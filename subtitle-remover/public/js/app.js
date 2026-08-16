/*
 * app.js — interfaz y orquestacion.
 */
(function () {
  'use strict';

  var SR = window.SR;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    file: null,
    track: null,
    samples: [],
    audio: null,
    audioSamples: [],
    shots: [],
    segments: [],
    fps: 30,
    blobUrl: null
  };

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

  function fmtTime(s) { return Number(s).toFixed(2) + 's'; }

  // Deja que el navegador repinte entre pasos pesados.
  function yieldToUi() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }

  // ----------------------------------------------------- compatibilidad

  if (!SR.Video.isSupported()) {
    var warn = $('unsupported');
    warn.innerHTML =
      '<h3>Tu navegador no puede procesar video aquí</h3>' +
      '<p>Esta herramienta usa <strong>WebCodecs</strong> para decodificar y volver a codificar el video ' +
      'sin subirlo a ningún servidor. Ábrela en <strong>Chrome, Edge u Opera</strong> (versión de escritorio, ' +
      '2023 en adelante). Safari y Firefox todavía no lo soportan completo.</p>';
    show(warn);
    $('drop').style.pointerEvents = 'none';
    $('drop').style.opacity = '.5';
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
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  function loadFile(file) {
    state.file = file;
    var info = $('file-info');
    info.innerHTML = '<p>Leyendo el video…</p>';
    show(info);

    SR.Video.demux(file).then(function (res) {
      state.track = res.video;
      state.samples = res.videoSamples;
      state.audio = res.audio;
      state.audioSamples = res.audioSamples;

      var durationSec = state.samples.length
        ? (state.samples[state.samples.length - 1].timestamp + state.samples[state.samples.length - 1].duration) / 1e6
        : 0;
      state.fps = durationSec > 0 ? state.samples.length / durationSec : 30;

      info.innerHTML =
        '<dl>' +
        '<dt>Archivo</dt><dd>' + escapeHtml(file.name) + ' · ' + fmtBytes(file.size) + '</dd>' +
        '<dt>Resolución</dt><dd>' + state.track.width + ' × ' + state.track.height + '</dd>' +
        '<dt>Duración</dt><dd>' + durationSec.toFixed(2) + ' s · ' + state.samples.length + ' fotogramas · ' +
          state.fps.toFixed(1) + ' fps</dd>' +
        '<dt>Audio</dt><dd>' + (state.audio
            ? (state.audio.description
                ? 'sí, se copia sin recodificar'
                : 'detectado, pero sin configuración legible — se descartará')
            : 'sin pista de audio') + '</dd>' +
        '</dl>';

      show($('step-analyze'));
      $('step-analyze').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (err) {
      info.innerHTML = '';
      setStatus(info, 'No se pudo leer el video.', 'err', String(err.message || err));
      info.className = 'status err';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------------------------------------------------------------- paso 2

  $('btn-analyze').addEventListener('click', analyze);
  $('btn-manual').addEventListener('click', function () {
    ensureShots().then(function () {
      addSegment(makeBlankSegment());
      show($('step-segments'));
      show($('step-render'));
      renderSegments();
    });
  });

  function ensureShots() {
    if (state.shots.length) return Promise.resolve(state.shots);
    var status = $('analyze-status');
    setStatus(status, 'Extrayendo fotogramas…', 'work');
    return SR.Pipeline.sampleFrames(state.track, state.samples, 8, null)
      .then(function (shots) { state.shots = shots; hide(status); return shots; });
  }

  function analyze() {
    var status = $('analyze-status');
    var btn = $('btn-analyze');
    btn.disabled = true;
    setStatus(status, 'Extrayendo fotogramas del video…', 'work');

    var count = parseInt($('frame-count').value, 10) || 8;

    SR.Pipeline.sampleFrames(state.track, state.samples, count, null).then(function (shots) {
      state.shots = shots;
      setStatus(status, 'Claude está analizando ' + shots.length + ' fotogramas…', 'work');
      return fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
          hint += '\nSi el error se repite, baja «Fotogramas de análisis» a 6 ' +
                  'o añade los segmentos a mano.';
        }
        throw new Error((r.body && (r.body.error || r.body.detail) || 'Error HTTP ' + r.status) + hint);
      }
      var segs = (r.body.segments || []);
      if (!segs.length) {
        setStatus(status, 'Claude no encontró subtítulos incrustados en este video.', 'err',
          'Puedes añadir un segmento a mano si sabes dónde está el texto.');
        show($('step-segments'));
        show($('step-render'));
        return;
      }

      state.segments = segs.map(toInternalSegment);
      setStatus(status, 'Ajustando los cortes fotograma a fotograma…', 'work');

      return yieldToUi()
        .then(function () { return SR.Pipeline.refine(state.track, state.samples, state.segments, null); })
        .then(function () {
          setStatus(status, 'Listo: ' + state.segments.length + ' subtítulo(s) detectado(s).', 'ok');
          show($('step-segments'));
          show($('step-render'));
          renderSegments();
          $('step-segments').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }).catch(function (err) {
      setStatus(status, 'Falló el análisis.', 'err', String(err.message || err));
      show($('step-segments'));
      show($('step-render'));
      renderSegments();
    }).then(function () {
      btn.disabled = false;
    });
  }

  function toInternalSegment(s) {
    var W = state.track.width, H = state.track.height;
    // margen extra: la caja de Claude suele ir justa y el contorno del texto sobresale
    var padX = W * 0.02, padY = H * 0.012;
    var top = s.box.y * H;
    var bottom = (s.box.y + s.box.h) * H;
    return {
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

  function makeBlankSegment() {
    var W = state.track.width, H = state.track.height;
    return {
      start: 0,
      end: Math.min(3, state.samples.length / state.fps),
      pixelBox: { x0: W * 0.06, y0: H * 0.62, x1: W * 0.94, y1: H * 0.78 },
      position: 'bottom',
      marginV: Math.round(H * 0.22),
      original: '',
      translated: '',
      enabled: true,
      firstFrame: 0,
      lastFrame: Math.min(state.samples.length - 1, Math.round(3 * state.fps)),
      refined: false
    };
  }

  function addSegment(seg) {
    state.segments.push(seg);
    syncFramesFromTimes(seg);
  }

  function syncFramesFromTimes(seg) {
    var n = state.samples.length;
    seg.firstFrame = Math.max(0, Math.min(n - 1, Math.round(seg.start * state.fps)));
    seg.lastFrame = Math.max(seg.firstFrame, Math.min(n - 1, Math.round(seg.end * state.fps)));
  }

  // -------------------------------------------------------------- paso 3

  $('btn-add').addEventListener('click', function () {
    ensureShots().then(function () {
      addSegment(makeBlankSegment());
      renderSegments();
    });
  });

  function nearestShot(time) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < state.shots.length; i++) {
      var d = Math.abs(state.shots[i].time - time);
      if (d < bestD) { bestD = d; best = state.shots[i]; }
    }
    return best;
  }

  function renderSegments() {
    var host = $('segments');
    host.innerHTML = '';
    var W = state.track.width, H = state.track.height;

    state.segments.forEach(function (seg, i) {
      var card = document.createElement('div');
      card.className = 'seg' + (seg.enabled ? '' : ' off');

      // miniatura con la caja detectada
      var thumb = document.createElement('div');
      thumb.className = 'seg-thumb';
      var shot = nearestShot((seg.start + seg.end) / 2);
      if (shot) {
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
      }
      card.appendChild(thumb);

      var body = document.createElement('div');
      body.className = 'seg-body';

      // fila 1: tiempos + estado + acciones
      var row1 = document.createElement('div');
      row1.className = 'seg-row';

      var times = document.createElement('div');
      times.className = 'seg-times';
      times.appendChild(numField('Desde (s)', seg.start.toFixed(2), function (v) {
        seg.start = parseFloat(v) || 0; syncFramesFromTimes(seg); renderSegments();
      }));
      times.appendChild(numField('Hasta (s)', seg.end.toFixed(2), function (v) {
        seg.end = parseFloat(v) || 0; syncFramesFromTimes(seg); renderSegments();
      }));
      row1.appendChild(times);

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
      cb.addEventListener('change', function () { seg.enabled = cb.checked; renderSegments(); });
      toggle.appendChild(cb);
      toggle.appendChild(document.createTextNode('activo'));
      actions.appendChild(toggle);

      var del = document.createElement('button');
      del.className = 'ghost small';
      del.textContent = 'Quitar';
      del.addEventListener('click', function () {
        state.segments.splice(i, 1);
        renderSegments();
      });
      actions.appendChild(del);
      row1.appendChild(actions);
      body.appendChild(row1);

      // texto original detectado
      if (seg.original) {
        var orig = document.createElement('div');
        orig.className = 'seg-orig';
        orig.innerHTML = 'Original: <b>' + escapeHtml(seg.original) + '</b>';
        body.appendChild(orig);
      }

      // traduccion editable
      var lab = document.createElement('label');
      lab.className = 'field';
      var span = document.createElement('span');
      span.textContent = 'Subtítulo nuevo (déjalo vacío para solo borrar)';
      var ta = document.createElement('textarea');
      ta.value = seg.translated;
      ta.rows = 2;
      ta.addEventListener('input', function () { seg.translated = ta.value; });
      lab.appendChild(span);
      lab.appendChild(ta);
      body.appendChild(lab);

      // posicion + caja
      var row2 = document.createElement('div');
      row2.className = 'seg-row';
      row2.appendChild(selectField('Posición', seg.position, [
        { v: 'bottom', t: 'Abajo' }, { v: 'top', t: 'Arriba' }
      ], function (v) { seg.position = v; }));
      row2.appendChild(numField('Caja X', Math.round(seg.pixelBox.x0), function (v) {
        seg.pixelBox.x0 = parseFloat(v) || 0; renderSegments();
      }));
      row2.appendChild(numField('Caja Y', Math.round(seg.pixelBox.y0), function (v) {
        seg.pixelBox.y0 = parseFloat(v) || 0; renderSegments();
      }));
      row2.appendChild(numField('Ancho', Math.round(seg.pixelBox.x1 - seg.pixelBox.x0), function (v) {
        seg.pixelBox.x1 = seg.pixelBox.x0 + (parseFloat(v) || 0); renderSegments();
      }));
      row2.appendChild(numField('Alto', Math.round(seg.pixelBox.y1 - seg.pixelBox.y0), function (v) {
        seg.pixelBox.y1 = seg.pixelBox.y0 + (parseFloat(v) || 0); renderSegments();
      }));
      body.appendChild(row2);

      card.appendChild(body);
      host.appendChild(card);
    });
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

  $('btn-render').addEventListener('click', render);

  function render() {
    var status = $('render-status');
    var btn = $('btn-render');
    var bar = $('progress-bar');
    var prog = $('progress');

    if (!state.segments.length) {
      setStatus(status, 'No hay ningún segmento que procesar.', 'err');
      return;
    }

    btn.disabled = true;
    show(prog);
    bar.style.width = '0%';
    setStatus(status, 'Procesando…', 'work');

    var fontSize = parseInt($('opt-fontsize').value, 10);
    var marginV = parseInt($('opt-margin').value, 10);

    var opts = {
      track: state.track,
      samples: state.samples,
      segments: state.segments,
      fps: state.fps,
      audio: (state.audio && state.audio.description) ? state.audio : null,
      audioSamples: state.audioSamples,
      skipRemoval: false,
      inpaintOptions: {
        grow: parseInt($('opt-grow').value, 10),
        iterations: parseInt($('opt-iter').value, 10),
        removeEmoji: $('opt-emoji').checked
      },
      style: {
        fontSize: isFinite(fontSize) && fontSize > 0 ? fontSize : undefined,
        marginV: isFinite(marginV) && marginV >= 0 ? marginV : undefined
      },
      onProgress: function (done, total) {
        var pct = Math.round(done / total * 100);
        bar.style.width = pct + '%';
        setStatus(status, 'Procesando fotograma ' + done + ' de ' + total + '…', 'work');
      }
    };

    if ($('opt-onlyremove').checked) {
      opts.segments = state.segments.map(function (s) {
        return Object.assign({}, s, { translated: '' });
      });
    }

    var t0 = performance.now();

    yieldToUi().then(function () {
      return SR.Pipeline.process(opts);
    }).then(function (blob) {
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      bar.style.width = '100%';
      setStatus(status, 'Video procesado en ' + secs + ' s · ' + fmtBytes(blob.size), 'ok');

      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = URL.createObjectURL(blob);
      $('result').src = state.blobUrl;
      var dl = $('download');
      dl.href = state.blobUrl;
      dl.download = (state.file.name || 'video').replace(/\.[^.]+$/, '') + '-limpio.mp4';

      show($('step-result'));
      $('step-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (err) {
      setStatus(status, 'Falló el procesamiento.', 'err', String(err.message || err));
      hide(prog);
    }).then(function () {
      btn.disabled = false;
    });
  }

  $('btn-restart').addEventListener('click', function () {
    if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    location.reload();
  });
})();
