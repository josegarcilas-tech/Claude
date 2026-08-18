/*
 * timeline.js — pestana 3: ver como quedo el video.
 *
 * Muestra el resultado con una linea de tiempo tipo editor: tira de miniaturas,
 * un bloque por cada elemento borrado colocado en su tramo real, y un cabezal que
 * sigue la reproduccion. El interruptor Original/Limpio cambia entre los dos videos
 * manteniendo el instante, que es la forma rapida de comprobar que se quito.
 *
 * Las miniaturas son un extra: si el navegador no las puede sacar (iOS es tacano
 * con los <video> que no se ven), se dibuja una tira lisa y los bloques siguen ahi.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var Timeline = (SR.Timeline = {});

  var host = document.getElementById('tl-root');
  if (!host) return;

  var current = null;      // job mostrado
  var origUrl = null;      // object URL del original
  var thumbsFor = null;    // id del job cuyas miniaturas ya se generaron
  var thumbs = [];

  function fmtTime(s) {
    if (!isFinite(s)) s = 0;
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** Reparte los segmentos en carriles para que los solapados no se pisen. */
  function assignLanes(segs) {
    var lanes = [];
    segs.forEach(function (s) {
      for (var i = 0; i < lanes.length; i++) {
        if (s.start >= lanes[i] - 0.01) { s._lane = i; lanes[i] = s.end; return; }
      }
      s._lane = lanes.length;
      lanes.push(s.end);
    });
    return lanes.length || 1;
  }

  /** Miniaturas del video ya procesado, sacadas moviendo currentTime. */
  function makeThumbs(url, count, width) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;' +
                        'opacity:0.01;pointer-events:none;z-index:-1;';
      document.body.appendChild(v);

      var out = [];
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var done = false;

      function finish() {
        if (done) return;
        done = true;
        try { v.pause(); } catch (e) {}
        try { if (v.parentNode) v.parentNode.removeChild(v); } catch (e) {}
        resolve(out);
      }
      var guard = setTimeout(finish, 20000);

      function ready() {
        return new Promise(function (res) {
          if (v.readyState >= 1) return res();
          v.addEventListener('loadedmetadata', res, { once: true });
          v.addEventListener('error', res, { once: true });
        });
      }

      function seek(t) {
        return new Promise(function (res) {
          var ok = false;
          var fin = function () { if (!ok) { ok = true; res(); } };
          v.addEventListener('seeked', fin, { once: true });
          v.addEventListener('error', fin, { once: true });
          setTimeout(fin, 3000);
          try { v.currentTime = t; } catch (e) { fin(); }
        });
      }

      function presented() {
        if (typeof v.requestVideoFrameCallback !== 'function') {
          return new Promise(function (r) { setTimeout(r, 0); });
        }
        return new Promise(function (r) {
          var f = false;
          var id = v.requestVideoFrameCallback(function () { if (!f) { f = true; r(); } });
          setTimeout(function () {
            if (f) return;
            try { v.cancelVideoFrameCallback(id); } catch (e) {}
            r();
          }, 300);
        });
      }

      ready().then(function () {
        if (!v.videoWidth) return finish();
        canvas.width = width;
        canvas.height = Math.max(1, Math.round(width * v.videoHeight / v.videoWidth));
        // igual que en la decodificacion de respaldo: iOS no carga datos hasta reproducir
        var p;
        try { p = v.play(); } catch (e) { p = null; }
        return (p && p.then ? p.catch(function () {}) : Promise.resolve())
          .then(function () { try { v.pause(); } catch (e) {} });
      }).then(function () {
        if (done) return;
        var dur = v.duration || (current && current.duration) || 0;
        if (!dur) return finish();
        var i = 0;
        function step() {
          if (done || i >= count) return finish();
          var t = (i + 0.5) * dur / count;
          i++;
          return seek(t).then(presented).then(function () {
            try {
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              out.push(canvas.toDataURL('image/jpeg', 0.6));
            } catch (e) { /* fotograma no legible: seguimos */ }
            return step();
          });
        }
        return step();
      }).then(function () {
        clearTimeout(guard);
        finish();
      }).catch(finish);
    });
  }

  // ------------------------------------------------------------------ render

  Timeline.refresh = function () {
    var done = SR.App ? SR.App.doneJobs() : [];
    host.innerHTML = '';

    if (!done.length) {
      var empty = el('p', 'hint');
      empty.textContent = 'Todavía no hay ningún video procesado. Ve a la pestaña ' +
                          '«Limpiar», procesa y vuelve aquí.';
      empty.style.marginTop = '0';
      host.appendChild(empty);
      return;
    }

    if (!current || done.indexOf(current) === -1) current = done[0];

    if (done.length > 1) {
      var picker = el('div', 'tl-picker');
      done.forEach(function (job) {
        var b = el('button', 'ghost small' + (job === current ? ' on' : ''), job.file.name);
        b.addEventListener('click', function () { current = job; Timeline.refresh(); });
        picker.appendChild(b);
      });
      host.appendChild(picker);
    }

    host.appendChild(buildStage(current));
  };

  function buildStage(job) {
    var wrap = el('div', 'tl');

    // ------------------------------------------------------------- reproductor
    var stage = el('div', 'tl-stage');
    var shell = el('div', 'tl-video');

    if (origUrl) { try { URL.revokeObjectURL(origUrl); } catch (e) {} }
    origUrl = URL.createObjectURL(job.file);

    var vClean = document.createElement('video');
    vClean.src = job.blobUrl;
    vClean.playsInline = true;
    vClean.setAttribute('playsinline', '');
    vClean.preload = 'metadata';

    var vOrig = document.createElement('video');
    vOrig.src = origUrl;
    vOrig.playsInline = true;
    vOrig.setAttribute('playsinline', '');
    vOrig.preload = 'metadata';
    vOrig.muted = true;
    vOrig.classList.add('hidden');

    shell.appendChild(vClean);
    shell.appendChild(vOrig);
    stage.appendChild(shell);

    var side = el('div', 'tl-side');

    var toggle = el('div', 'tl-toggle');
    var bClean = el('button', 'on', 'Limpio');
    var bOrig = el('button', null, 'Original');
    toggle.appendChild(bClean);
    toggle.appendChild(bOrig);
    side.appendChild(toggle);

    var showing = 'clean';
    function swapTo(which) {
      if (which === showing) return;
      var from = showing === 'clean' ? vClean : vOrig;
      var to = which === 'clean' ? vClean : vOrig;
      var wasPlaying = !from.paused;
      try { to.currentTime = from.currentTime; } catch (e) {}
      from.pause();
      from.classList.add('hidden');
      to.classList.remove('hidden');
      // el original va en silencio: el audio siempre sale del limpio
      to.muted = which !== 'clean';
      if (wasPlaying) to.play().catch(function () {});
      showing = which;
      bClean.classList.toggle('on', which === 'clean');
      bOrig.classList.toggle('on', which === 'orig');
    }
    bClean.addEventListener('click', function () { swapTo('clean'); });
    bOrig.addEventListener('click', function () { swapTo('orig'); });

    var counts = el('div', 'tl-counts');
    var nSub = job.segments.filter(function (s) { return s.kind !== 'overlay'; }).length;
    var nOv = job.segments.filter(function (s) { return s.kind === 'overlay'; }).length;
    counts.innerHTML =
      '<div><b>' + nSub + '</b> subtítulo(s)</div>' +
      '<div><b>' + nOv + '</b> recuadro(s)</div>' +
      '<div class="muted">' + job.cleaned + ' de ' + job.framesWithSegments +
      ' fotogramas limpiados</div>';
    side.appendChild(counts);

    stage.appendChild(side);
    wrap.appendChild(stage);

    // ------------------------------------------------------------- transporte
    var transport = el('div', 'tl-transport');
    var play = el('button', 'tl-play', '▶');
    var clock = el('span', 'tl-clock', '0:00.0 / 0:00.0');
    transport.appendChild(play);
    transport.appendChild(clock);
    wrap.appendChild(transport);

    function active() { return showing === 'clean' ? vClean : vOrig; }

    play.addEventListener('click', function () {
      var v = active();
      if (v.paused) v.play().catch(function () {}); else v.pause();
    });
    [vClean, vOrig].forEach(function (v) {
      v.addEventListener('play', function () { if (v === active()) play.textContent = '❚❚'; });
      v.addEventListener('pause', function () { if (v === active()) play.textContent = '▶'; });
    });

    // ---------------------------------------------------------------- la pista
    var duration = job.duration || 0;
    var track = el('div', 'tl-track');

    var strip = el('div', 'tl-strip');
    track.appendChild(strip);

    var segs = job.segments.slice().sort(function (a, b) { return a.start - b.start; });
    var laneCount = assignLanes(segs);
    var lanes = el('div', 'tl-lanes');
    lanes.style.height = (laneCount * 26) + 'px';

    segs.forEach(function (seg) {
      var left = duration ? (seg.start / duration) * 100 : 0;
      var width = duration ? ((seg.end - seg.start) / duration) * 100 : 0;
      var block = el('div', 'tl-block ' + (seg.kind === 'overlay' ? 'ov' : 'sub') +
                                (seg.enabled ? '' : ' off'));
      block.style.left = left + '%';
      block.style.width = Math.max(0.6, width) + '%';
      block.style.top = (seg._lane * 26) + 'px';
      var label = seg.kind === 'overlay' ? 'recuadro' : (seg.translated || seg.original || 'subtítulo');
      block.title = label + ' · ' + fmtTime(seg.start) + '–' + fmtTime(seg.end);
      block.appendChild(el('span', null, label));
      block.addEventListener('click', function (e) {
        e.stopPropagation();
        seekTo(seg.start + 0.05);
      });
      lanes.appendChild(block);
    });
    track.appendChild(lanes);

    var head = el('div', 'tl-head');
    track.appendChild(head);
    wrap.appendChild(track);

    var legend = el('div', 'tl-legend');
    legend.innerHTML =
      '<span><i class="sw sub"></i> subtítulo</span>' +
      '<span><i class="sw ov"></i> recuadro / sticker</span>' +
      '<span class="muted">toca un bloque para saltar a ese punto</span>';
    wrap.appendChild(legend);

    function seekTo(t) {
      var v = active();
      try { v.currentTime = Math.max(0, Math.min(duration || v.duration || 0, t)); } catch (e) {}
      paint();
    }

    track.addEventListener('click', function (e) {
      var r = track.getBoundingClientRect();
      var frac = (e.clientX - r.left) / r.width;
      seekTo(frac * (duration || active().duration || 0));
    });

    function paint() {
      var v = active();
      var d = duration || v.duration || 0;
      var t = v.currentTime || 0;
      head.style.left = (d ? (t / d) * 100 : 0) + '%';
      clock.textContent = fmtTime(t) + ' / ' + fmtTime(d);
    }
    [vClean, vOrig].forEach(function (v) {
      v.addEventListener('timeupdate', paint);
      v.addEventListener('loadedmetadata', paint);
      v.addEventListener('seeked', paint);
    });
    paint();

    // ------------------------------------------------------------ miniaturas
    function drawStrip(list) {
      strip.innerHTML = '';
      if (!list.length) { strip.classList.add('plain'); return; }
      strip.classList.remove('plain');
      list.forEach(function (src) {
        var i = document.createElement('img');
        i.src = src;
        i.alt = '';
        strip.appendChild(i);
      });
    }

    if (thumbsFor === job.id && thumbs.length) {
      drawStrip(thumbs);
    } else {
      strip.classList.add('plain');
      makeThumbs(job.blobUrl, 14, 80).then(function (list) {
        thumbs = list;
        thumbsFor = job.id;
        if (host.contains(strip)) drawStrip(list);
      });
    }

    return wrap;
  }

  // Si se procesa otro video mientras la pestana esta abierta, se refresca sola.
  if (SR.App) {
    SR.App.onChange(function () {
      var panel = document.getElementById('tab-timeline');
      if (panel && !panel.classList.contains('hidden')) Timeline.refresh();
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
