/*
 * app.js — interfaz y orquestacion.
 *
 * La app trabaja sobre una lista de "jobs": un job por video cargado. Todas las
 * fases (analisis y procesado) recorren esa lista EN SERIE, nunca en paralelo:
 * decodificar y recodificar video se come CPU y memoria, y hacer dos a la vez
 * multiplica el pico de memoria justo donde mas duele (el telefono).
 */
(function () {
  'use strict';

  var SR = window.SR;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    jobs: [],
    nextId: 1,
    // 'cover'     = tapar con una caja de color (no reconstruye el fondo)
    // 'translate' = borrar el fondo y escribir la traduccion con contorno
    // 'remove'    = solo borrar
    mode: 'cover',
    zipUrl: null
  };

  function currentMode() {
    var checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'cover';
  }

  function doneJobs() {
    return state.jobs.filter(function (j) { return j.status === 'hecho' && j.blob; });
  }

  var listeners = [];
  function emitChange() {
    listeners.forEach(function (fn) {
      try { fn(state.jobs); } catch (e) { /* un oyente roto no tumba el render */ }
    });
  }

  // --------------------------------------------------------------- utilidades

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setStatus(el, message, kind, detail) {
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.textContent = '';
    var main = document.createElement('div');
    main.textContent = message;
    el.appendChild(main);
    if (detail) {
      var d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      el.appendChild(d);
    }
    show(el);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Deja que el navegador repinte entre pasos pesados.
  function yieldToUi() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }

  /** Recorre una lista en serie, aplicando fn(item, i) que devuelve una promesa. */
  function series(items, fn) {
    return items.reduce(function (chain, item, i) {
      return chain.then(function () { return fn(item, i); });
    }, Promise.resolve());
  }

  function outName(job) {
    return (job.file.name || 'video').replace(/\.[^.]+$/, '') + '-limpio.mp4';
  }

  // ----------------------------------------------------- compatibilidad

  var ua = navigator.userAgent;
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
              (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (!SR.Video.isSupported()) {
    var warn = $('unsupported');
    warn.innerHTML =
      '<h3>Tu navegador no puede generar el video</h3>' +
      '<p>Hace falta el codificador de <strong>WebCodecs</strong> para armar el MP4 de salida. ' +
      'Ábrela en <strong>Chrome o Edge</strong> (2023 en adelante). Firefox todavía no lo ' +
      'soporta completo.</p>';
    show(warn);
    $('drop').style.pointerEvents = 'none';
    $('drop').style.opacity = '.5';
  } else if (isIOS) {
    var note = $('unsupported');
    note.className = 'warning soft';
    note.innerHTML =
      '<h3>En iPhone y iPad va por el camino lento</h3>' +
      '<p>El decodificador rápido de iOS falla, así que la app lo detecta y extrae los ' +
      'fotogramas reproduciendo el video, que sí funciona aquí. Tarda bastante más, y con ' +
      'varios videos a la vez el navegador puede quedarse sin memoria: ve de pocos en pocos.</p>';
    show(note);
  }

  // -------------------------------------------------------------- paso 1

  var drop = $('drop');
  var fileInput = $('file');

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';   // permite volver a elegir el mismo archivo
  });

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && (/^video\//.test(f.type) || /\.(mp4|m4v|mov)$/i.test(f.name));
    });
    if (!files.length) return;

    var status = $('file-status');
    var jobs = files.map(function (f) {
      var job = {
        id: state.nextId++,
        file: f,
        status: 'leyendo',
        error: null,
        segments: [],
        shots: [],
        shotsFailed: false,
        blob: null,
        blobUrl: null,
        open: false
      };
      state.jobs.push(job);
      return job;
    });
    renderJobs();

    setStatus(status, 'Leyendo ' + jobs.length + ' video(s)…', 'work');

    series(jobs, function (job) {
      return SR.Video.demux(job.file).then(function (res) {
        job.track = res.video;
        job.samples = res.videoSamples;
        job.audio = res.audio;
        job.audioSamples = res.audioSamples;
        job.src = { file: job.file, track: res.video, samples: res.videoSamples };
        var last = res.videoSamples[res.videoSamples.length - 1];
        job.duration = last ? (last.timestamp + last.duration) / 1e6 : 0;
        job.fps = job.duration > 0 ? res.videoSamples.length / job.duration : 30;
        job.status = 'pendiente';
      }).catch(function (err) {
        job.status = 'error';
        job.error = String(err && err.message || err);
      }).then(function () {
        renderJobs();
        return yieldToUi();
      });
    }).then(function () {
      var ok = state.jobs.filter(function (j) { return j.status !== 'error'; });
      var bad = state.jobs.filter(function (j) { return j.status === 'error'; });
      if (!ok.length) {
        setStatus(status, 'No se pudo leer ningún video.', 'err');
        return;
      }
      if (bad.length) {
        setStatus(status, ok.length + ' video(s) listos · ' + bad.length + ' con problemas.', 'err');
      } else {
        hide(status);
      }
      show($('step-analyze'));
      show($('step-render'));
    });
  }

  var STATUS_TEXT = {
    leyendo: 'leyendo…',
    pendiente: 'listo para analizar',
    analizando: 'analizando…',
    analizado: 'analizado',
    procesando: 'procesando…',
    hecho: 'procesado',
    error: 'error'
  };

  function renderJobs() {
    emitChange();
    var host = $('job-list');
    host.innerHTML = '';
    state.jobs.forEach(function (job) {
      var row = document.createElement('div');
      row.className = 'job' + (job.status === 'error' ? ' bad' : '');

      var main = document.createElement('div');
      main.className = 'job-main';
      var name = document.createElement('div');
      name.className = 'job-name';
      name.textContent = job.file.name;
      main.appendChild(name);

      var meta = document.createElement('div');
      meta.className = 'job-meta';
      var bits = [fmtBytes(job.file.size)];
      if (job.track) {
        bits.push(job.track.width + '×' + job.track.height);
        bits.push(job.duration.toFixed(1) + ' s');
        bits.push(job.samples.length + ' fotogramas');
      }
      if (job.status === 'analizado' || job.status === 'hecho' || job.status === 'procesando') {
        bits.push(job.segments.length + ' subtítulo(s)');
      }
      meta.textContent = bits.join(' · ');
      main.appendChild(meta);

      if (job.error) {
        var err = document.createElement('div');
        err.className = 'job-err';
        err.textContent = job.error;
        main.appendChild(err);
      }
      row.appendChild(main);

      var side = document.createElement('div');
      side.className = 'job-side';
      var badge = document.createElement('span');
      badge.className = 'badge state-' + job.status;
      badge.textContent = STATUS_TEXT[job.status] || job.status;
      side.appendChild(badge);

      if (job.status !== 'procesando' && job.status !== 'analizando' && job.status !== 'leyendo') {
        var del = document.createElement('button');
        del.className = 'ghost small';
        del.textContent = 'Quitar';
        del.addEventListener('click', function () {
          if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
          state.jobs = state.jobs.filter(function (j) { return j !== job; });
          renderJobs(); renderReview(); renderResults();
          if (!state.jobs.length) { hide($('step-analyze')); hide($('step-render')); hide($('step-segments')); }
        });
        side.appendChild(del);
      }
      row.appendChild(side);
      host.appendChild(row);
    });
  }

  // -------------------------------------------------------------- paso 2

  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (radio) {
    radio.addEventListener('change', function () {
      state.mode = currentMode();
      applyModeUi();
      renderReview();
    });
  });

  function applyModeUi() {
    var translating = state.mode !== 'remove';
    $('lang-field').classList.toggle('hidden', !translating);
    // las opciones de caja solo tienen sentido cuando se tapa
    $('style-box').classList.toggle('hidden', state.mode !== 'cover');
    $('btn-analyze').textContent = translating
      ? 'Analizar con Claude'
      : 'Detectar subtítulos con Claude';
    $('analyze-hint').textContent = translating
      ? 'Claude ubica todo lo añadido en edición: subtítulos, recuadros de comentario, ' +
        'stickers, etiquetas y marcas de agua. Los subtítulos se traducen; los recuadros ' +
        'solo se borran. Después puedes corregir cualquier cosa.'
      : 'Claude ubica todo lo añadido en edición —subtítulos, recuadros, stickers, marcas ' +
        'de agua— y se borra todo, sin escribir nada encima.';
  }
  applyModeUi();

  $('opt-bg').addEventListener('change', function () {
    $('opt-bg-custom-field').classList.toggle('hidden', $('opt-bg').value !== 'custom');
  });

  function bgColor() {
    var v = $('opt-bg').value;
    return v === 'custom' ? $('opt-bg-custom').value : v;
  }

  $('btn-analyze').addEventListener('click', analyzeAll);

  function analyzeAll() {
    var status = $('analyze-status');
    var btn = $('btn-analyze');
    var targets = state.jobs.filter(function (j) {
      return j.status === 'pendiente' || j.status === 'analizado';
    });
    if (!targets.length) {
      setStatus(status, 'No hay videos que analizar.', 'err');
      return;
    }

    btn.disabled = true;
    state.mode = currentMode();
    var count = parseInt($('frame-count').value, 10) || 8;
    var failures = [];

    series(targets, function (job, i) {
      job.status = 'analizando';
      renderJobs();
      setStatus(status, 'Analizando ' + (i + 1) + ' de ' + targets.length + ': ' + job.file.name, 'work');

      return analyzeJob(job, count).then(function () {
        job.status = 'analizado';
      }).catch(function (err) {
        job.status = 'error';
        job.error = String(err && err.message || err);
        failures.push(job);
      }).then(function () {
        renderJobs();
        renderReview();
        return yieldToUi();
      });
    }).then(function () {
      var ok = targets.length - failures.length;
      if (!ok) {
        setStatus(status, 'Falló el análisis en todos los videos.', 'err',
          failures[0] ? failures[0].error : '');
      } else if (failures.length) {
        setStatus(status, ok + ' de ' + targets.length + ' analizados. ' +
          failures.length + ' con problemas — puedes añadirles zonas a mano.', 'err');
      } else {
        setStatus(status, ok + ' video(s) analizados.', 'ok');
      }
      show($('step-segments'));
      show($('step-render'));
      renderReview();
      $('step-segments').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).then(function () { btn.disabled = false; });
  }

  function analyzeJob(job, count) {
    return SR.Pipeline.sampleFrames(job.src, count, null).then(function (shots) {
      job.shots = shots;
      return fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: state.mode === 'remove' ? 'remove' : 'translate',
          targetLanguage: $('lang').value || 'español',
          frames: shots.map(function (s) { return { time: s.time, dataUrl: s.dataUrl }; })
        })
      });
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    }).then(function (r) {
      if (!r.ok) {
        var hint = r.body && r.body.hint ? '\n' + r.body.hint : '';
        if (r.status === 502 || r.status === 504) {
          hint += '\nSi se repite, baja «Fotogramas de análisis» a 6.';
        }
        throw new Error((r.body && (r.body.error || r.body.detail) || 'Error HTTP ' + r.status) + hint);
      }
      var segs = r.body.segments || [];
      job.segments = segs.map(function (s) { return toInternalSegment(job, s); });
      if (!job.segments.length) return;
      return SR.Pipeline.refine(job.src, job.segments, null);
    });
  }

  function toInternalSegment(job, s) {
    var W = job.track.width, H = job.track.height;
    var overlay = s.kind === 'overlay';
    // Margen extra sobre la caja de Claude. Para el texto hace falta bastante: el
    // contorno del glifo sobresale. Para un recuadro se pide poco, porque el margen
    // solo anade fondo que habria que reconstruir sin necesidad.
    var padX = overlay ? W * 0.006 : W * 0.02;
    var padY = overlay ? H * 0.004 : H * 0.012;
    var top = s.box.y * H;
    var bottom = (s.box.y + s.box.h) * H;
    return {
      kind: overlay ? 'overlay' : 'subtitle',
      start: s.start,
      end: s.end,
      pixelBox: {
        x0: s.box.x * W - padX,
        y0: top - padY,
        x1: (s.box.x + s.box.w) * W + padX,
        y1: bottom + padY
      },
      position: s.position,
      // El subtitulo nuevo va donde estaba el original: asi tapa la zona reconstruida
      // y se respeta la composicion que eligio quien hizo el video.
      marginV: s.position === 'top' ? Math.round(top) : Math.round(H - bottom),
      original: s.original,
      translated: s.translated,
      enabled: true,
      firstFrame: 0,
      lastFrame: 0,
      refined: false
    };
  }

  function makeBlankSegment(job) {
    var W = job.track.width, H = job.track.height;
    var seg = {
      kind: 'subtitle',
      start: 0,
      end: Math.min(3, job.duration || 3),
      pixelBox: { x0: W * 0.06, y0: H * 0.62, x1: W * 0.94, y1: H * 0.78 },
      position: 'bottom',
      marginV: Math.round(H * 0.22),
      original: '',
      translated: '',
      enabled: true,
      firstFrame: 0,
      lastFrame: 0,
      refined: false
    };
    syncFrames(job, seg);
    return seg;
  }

  function syncFrames(job, seg) {
    var n = job.samples.length;
    seg.firstFrame = Math.max(0, Math.min(n - 1, Math.round(seg.start * job.fps)));
    seg.lastFrame = Math.max(seg.firstFrame, Math.min(n - 1, Math.round(seg.end * job.fps)));
  }

  /**
   * Miniaturas para las tarjetas de segmento. Nunca rechaza: si el navegador no
   * puede decodificar, las tarjetas se muestran sin miniatura en vez de dejar la
   * interfaz colgada — anadir segmentos a mano no necesita decodificar nada.
   */
  function ensureShots(job) {
    if (job.shots.length || job.shotsFailed) return Promise.resolve(job.shots);
    return SR.Pipeline.sampleFrames(job.src, 8, null)
      .then(function (shots) { job.shots = shots; return shots; })
      .catch(function () { job.shotsFailed = true; return []; });
  }

  // -------------------------------------------------------------- paso 3

  function renderReview() {
    var host = $('review');
    host.innerHTML = '';
    var usable = state.jobs.filter(function (j) { return j.track; });
    if (!usable.length) return;

    usable.forEach(function (job) {
      var box = document.createElement('div');
      box.className = 'review-job';

      var head = document.createElement('button');
      head.className = 'review-head';
      head.setAttribute('aria-expanded', job.open ? 'true' : 'false');
      head.innerHTML =
        '<span class="caret">' + (job.open ? '▾' : '▸') + '</span>' +
        '<span class="review-name">' + escapeHtml(job.file.name) + '</span>' +
        '<span class="review-count">' + job.segments.length + ' subtítulo(s)</span>';
      head.addEventListener('click', function () {
        job.open = !job.open;
        renderReview();
        if (job.open) ensureShots(job).then(function (s) { if (s.length) renderReview(); });
      });
      box.appendChild(head);

      if (job.open) {
        var body = document.createElement('div');
        body.className = 'review-body';
        var list = document.createElement('div');
        list.className = 'segments';
        job.segments.forEach(function (seg, i) {
          list.appendChild(segmentCard(job, seg, i));
        });
        body.appendChild(list);

        var add = document.createElement('button');
        add.className = 'ghost small';
        add.textContent = '+ Añadir segmento a mano';
        add.addEventListener('click', function () {
          job.segments.push(makeBlankSegment(job));
          renderReview();
          ensureShots(job).then(function (s) { if (s.length) renderReview(); });
        });
        body.appendChild(add);
        box.appendChild(body);
      }
      host.appendChild(box);
    });
  }

  function nearestShot(job, time) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < job.shots.length; i++) {
      var d = Math.abs(job.shots[i].time - time);
      if (d < bestD) { bestD = d; best = job.shots[i]; }
    }
    return best;
  }

  function segmentCard(job, seg, i) {
    var W = job.track.width, H = job.track.height;
    var card = document.createElement('div');
    card.className = 'seg' + (seg.enabled ? '' : ' off');

    var shot = nearestShot(job, (seg.start + seg.end) / 2);
    if (shot) {
      var thumb = document.createElement('div');
      thumb.className = 'seg-thumb';
      var img = document.createElement('img');
      img.src = shot.dataUrl;
      img.alt = '';
      thumb.appendChild(img);
      var mark = document.createElement('div');
      mark.className = 'boxmark';
      mark.style.left = (seg.pixelBox.x0 / W * 100) + '%';
      mark.style.top = (seg.pixelBox.y0 / H * 100) + '%';
      mark.style.width = ((seg.pixelBox.x1 - seg.pixelBox.x0) / W * 100) + '%';
      mark.style.height = ((seg.pixelBox.y1 - seg.pixelBox.y0) / H * 100) + '%';
      thumb.appendChild(mark);
      card.appendChild(thumb);
    } else {
      card.classList.add('no-thumb');
    }

    var body = document.createElement('div');
    body.className = 'seg-body';

    var row1 = document.createElement('div');
    row1.className = 'seg-row';
    var times = document.createElement('div');
    times.className = 'seg-times';
    times.appendChild(numField('Desde (s)', seg.start.toFixed(2), function (v) {
      seg.start = parseFloat(v) || 0; syncFrames(job, seg); renderReview();
    }));
    times.appendChild(numField('Hasta (s)', seg.end.toFixed(2), function (v) {
      seg.end = parseFloat(v) || 0; syncFrames(job, seg); renderReview();
    }));
    row1.appendChild(times);

    var kindBadge = document.createElement('span');
    kindBadge.className = 'badge kind-' + seg.kind;
    kindBadge.textContent = seg.kind === 'overlay' ? 'recuadro' : 'subtítulo';
    row1.appendChild(kindBadge);

    var badge = document.createElement('span');
    badge.className = 'badge' + (seg.refined ? '' : ' approx');
    badge.textContent = seg.refined
      ? 'cortes exactos (' + seg.firstFrame + '–' + seg.lastFrame + ')'
      : 'tiempos aproximados';
    row1.appendChild(badge);

    var actions = document.createElement('div');
    actions.className = 'seg-actions';
    var toggle = document.createElement('label');
    toggle.className = 'check';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = seg.enabled;
    cb.addEventListener('change', function () { seg.enabled = cb.checked; renderReview(); });
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode('activo'));
    actions.appendChild(toggle);

    var del = document.createElement('button');
    del.className = 'ghost small';
    del.textContent = 'Quitar';
    del.addEventListener('click', function () {
      job.segments.splice(i, 1);
      renderReview();
    });
    actions.appendChild(del);
    row1.appendChild(actions);
    body.appendChild(row1);

    if (seg.original) {
      var orig = document.createElement('div');
      orig.className = 'seg-orig';
      orig.innerHTML = 'Original: <b>' + escapeHtml(seg.original) + '</b>';
      body.appendChild(orig);
    }

    if (state.mode !== 'remove' && seg.kind !== 'overlay') {
      var lab = document.createElement('label');
      lab.className = 'field';
      var span = document.createElement('span');
      span.textContent = 'Subtítulo nuevo (déjalo vacío para solo borrar este)';
      var ta = document.createElement('textarea');
      ta.value = seg.translated;
      ta.rows = 2;
      ta.addEventListener('input', function () { seg.translated = ta.value; });
      lab.appendChild(span);
      lab.appendChild(ta);
      body.appendChild(lab);
    }

    var row2 = document.createElement('div');
    row2.className = 'seg-row';
    row2.appendChild(selectField('Tipo', seg.kind, [
      { v: 'subtitle', t: 'Subtítulo' }, { v: 'overlay', t: 'Recuadro / sticker' }
    ], function (v) { seg.kind = v; renderReview(); }));
    row2.appendChild(selectField('Posición', seg.position, [
      { v: 'bottom', t: 'Abajo' }, { v: 'top', t: 'Arriba' }
    ], function (v) { seg.position = v; }));
    row2.appendChild(numField('Caja X', Math.round(seg.pixelBox.x0), function (v) {
      seg.pixelBox.x0 = parseFloat(v) || 0; renderReview();
    }));
    row2.appendChild(numField('Caja Y', Math.round(seg.pixelBox.y0), function (v) {
      seg.pixelBox.y0 = parseFloat(v) || 0; renderReview();
    }));
    row2.appendChild(numField('Ancho', Math.round(seg.pixelBox.x1 - seg.pixelBox.x0), function (v) {
      seg.pixelBox.x1 = seg.pixelBox.x0 + (parseFloat(v) || 0); renderReview();
    }));
    row2.appendChild(numField('Alto', Math.round(seg.pixelBox.y1 - seg.pixelBox.y0), function (v) {
      seg.pixelBox.y1 = seg.pixelBox.y0 + (parseFloat(v) || 0); renderReview();
    }));
    body.appendChild(row2);

    card.appendChild(body);
    return card;
  }

  function numField(label, value, onChange) {
    var l = document.createElement('label');
    l.className = 'field narrow';
    var s = document.createElement('span');
    s.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.step = 'any';
    inp.value = value;
    inp.addEventListener('change', function () { onChange(inp.value); });
    l.appendChild(s); l.appendChild(inp);
    return l;
  }

  function selectField(label, value, options, onChange) {
    var l = document.createElement('label');
    l.className = 'field narrow';
    var s = document.createElement('span');
    s.textContent = label;
    var sel = document.createElement('select');
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.v; opt.textContent = o.t;
      if (o.v === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    l.appendChild(s); l.appendChild(sel);
    return l;
  }

  // -------------------------------------------------------------- paso 4

  $('btn-render').addEventListener('click', renderAll);

  function buildOptions(job) {
    var fontSize = parseInt($('opt-fontsize').value, 10);
    var marginV = parseInt($('opt-margin').value, 10);
    var segments = job.segments.map(function (s) {
      // un recuadro se borra y ya; en modo "solo quitar", todo se borra sin reemplazo
      if (s.kind === 'overlay' || state.mode === 'remove') {
        return Object.assign({}, s, { translated: '' });
      }
      return s;
    });
    return {
      src: job.src,
      segments: segments,
      fps: job.fps,
      audio: (job.audio && job.audio.description) ? job.audio : null,
      audioSamples: job.audioSamples,
      skipRemoval: false,
      inpaintOptions: {
        grow: parseInt($('opt-grow').value, 10),
        radius: parseInt($('opt-radius').value, 10),
        removeEmoji: $('opt-emoji').checked
      },
      style: {
        boxed: state.mode === 'cover',
        fontFamily: $('opt-font').value,
        bgColor: bgColor(),
        color: $('opt-fg').value === 'auto' ? undefined : $('opt-fg').value,
        fontSize: isFinite(fontSize) && fontSize > 0 ? fontSize : undefined,
        marginV: isFinite(marginV) && marginV >= 0 ? marginV : undefined
      }
    };
  }

  function renderAll() {
    var status = $('render-status');
    var btn = $('btn-render');
    var bar = $('progress-bar');
    var prog = $('progress');

    var targets = state.jobs.filter(function (j) {
      return j.track && j.segments.length;
    });
    if (!targets.length) {
      setStatus(status, 'Ningún video tiene subtítulos marcados.', 'err',
        'Analiza primero, o abre un video en el paso 3 y añade la zona a mano.');
      return;
    }

    btn.disabled = true;
    show(prog);
    bar.style.width = '0%';
    var t0 = performance.now();
    var failures = [];

    series(targets, function (job, i) {
      job.status = 'procesando';
      renderJobs();

      var opts = buildOptions(job);
      opts.onProgress = function (done, total) {
        // la barra avanza sobre el total del lote, no solo sobre este video
        var overall = (i + (total ? done / total : 0)) / targets.length;
        bar.style.width = Math.round(overall * 100) + '%';
        setStatus(status,
          'Video ' + (i + 1) + ' de ' + targets.length + ': ' + job.file.name +
          ' — fotograma ' + done + ' de ' + total, 'work');
      };

      return yieldToUi()
        .then(function () {
          return SR.Overlay.ensureFont(opts.style.fontFamily,
            [opts.style.fontSize || Math.round(job.track.width * 0.062)]);
        })
        .then(function () { return SR.Pipeline.process(opts); })
        .then(function (result) {
          job.blob = result.blob;
          job.cleaned = result.cleanedFrames;
          job.framesWithSegments = result.framesWithSegments;
          if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
          job.blobUrl = URL.createObjectURL(result.blob);
          job.status = 'hecho';
        })
        .catch(function (err) {
          job.status = 'error';
          job.error = String(err && err.message || err);
          failures.push(job);
        })
        .then(function () {
          renderJobs();
          renderResults();
          return yieldToUi();
        });
    }).then(function () {
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      var ok = doneJobs().length;
      bar.style.width = '100%';
      if (!ok) {
        setStatus(status, 'No se pudo procesar ningún video.', 'err',
          failures[0] ? failures[0].error : '');
      } else if (failures.length) {
        setStatus(status, ok + ' de ' + targets.length + ' procesados en ' + secs + ' s.', 'err',
          failures.length + ' con problemas: ' + failures[0].error);
      } else {
        setStatus(status, ok + ' video(s) procesados en ' + secs + ' s.', 'ok');
      }
      if (ok) {
        show($('step-result'));
        $('step-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      btn.disabled = false;
    });
  }

  // -------------------------------------------------------------- resultados

  function renderResults() {
    var host = $('results');
    host.innerHTML = '';
    var done = doneJobs();
    $('btn-zip').disabled = done.length < 1;

    done.forEach(function (job) {
      var row = document.createElement('div');
      row.className = 'result';

      var vid = document.createElement('video');
      vid.src = job.blobUrl;
      vid.controls = true;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      row.appendChild(vid);

      var info = document.createElement('div');
      info.className = 'result-info';
      var n = document.createElement('div');
      n.className = 'result-name';
      n.textContent = outName(job);
      info.appendChild(n);

      var m = document.createElement('div');
      m.className = 'result-meta';
      m.textContent = fmtBytes(job.blob.size) + ' · se limpiaron ' + job.cleaned +
                      ' de ' + job.framesWithSegments + ' fotogramas con subtítulo';
      info.appendChild(m);

      var a = document.createElement('a');
      a.className = 'primary';
      a.href = job.blobUrl;
      a.download = outName(job);
      a.textContent = 'Descargar';
      info.appendChild(a);

      row.appendChild(info);
      host.appendChild(row);
    });
  }

  $('btn-zip').addEventListener('click', function () {
    var status = $('zip-status');
    var done = doneJobs();
    if (!done.length) return;

    var btn = $('btn-zip');
    btn.disabled = true;
    setStatus(status, 'Empaquetando ' + done.length + ' video(s)…', 'work');

    SR.makeZip(done.map(function (j) {
      return { name: outName(j), blob: j.blob };
    })).then(function (zip) {
      if (state.zipUrl) URL.revokeObjectURL(state.zipUrl);
      state.zipUrl = URL.createObjectURL(zip);
      var a = document.createElement('a');
      a.href = state.zipUrl;
      a.download = 'videos-limpios.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setStatus(status, 'ZIP listo · ' + fmtBytes(zip.size), 'ok',
        'Si el navegador no lo descargó solo, vuelve a tocar el botón.');
    }).catch(function (err) {
      setStatus(status, 'No se pudo crear el ZIP.', 'err', String(err && err.message || err));
    }).then(function () { btn.disabled = false; });
  });

  /**
   * Puente con las otras pestanas: la de descarga mete archivos aqui, y la linea
   * de tiempo lee los trabajos ya procesados.
   */
  SR.App = {
    addFiles: function (files) { addFiles(files); },
    jobs: function () { return state.jobs; },
    doneJobs: doneJobs,
    onChange: function (fn) { listeners.push(fn); },
    mode: function () { return state.mode; }
  };

  $('btn-restart').addEventListener('click', function () {
    state.jobs.forEach(function (j) { if (j.blobUrl) URL.revokeObjectURL(j.blobUrl); });
    if (state.zipUrl) URL.revokeObjectURL(state.zipUrl);
    location.reload();
  });
})();
