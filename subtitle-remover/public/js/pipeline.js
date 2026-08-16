/*
 * pipeline.js — orquesta las tres pasadas sobre el video.
 *
 *   1) muestreo   : saca fotogramas sueltos y los manda a Claude para que ubique
 *                   los subtitulos, los transcriba y los traduzca.
 *   2) refinado   : mide frame por frame donde hay texto de verdad, para acertar
 *                   el primer y ultimo frame de cada subtitulo (Claude da tiempos
 *                   aproximados; los cortes tienen que ser exactos o queda un
 *                   parpadeo con el texto viejo).
 *   3) procesado  : borra el texto, dibuja el nuevo y reencoda.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var Pipeline = (SR.Pipeline = {});

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Pasada 1: N fotogramas repartidos, escalados y en JPEG, para el analisis. */
  Pipeline.sampleFrames = function (track, samples, count, onProgress) {
    var total = samples.length;
    var wanted = [];
    for (var i = 0; i < count; i++) {
      wanted.push(Math.min(total - 1, Math.round((i + 0.5) * total / count)));
    }
    var wantedSet = {};
    wanted.forEach(function (n) { wantedSet[n] = true; });

    var scale = Math.min(1, 512 / track.width);
    var cw = Math.round(track.width * scale), ch = Math.round(track.height * scale);
    var canvas = makeCanvas(cw, ch);
    var ctx = canvas.getContext('2d');
    var shots = [];

    return SR.Video.decodeAll(track, samples, function (frame, idx) {
      if (wantedSet[idx]) {
        ctx.drawImage(frame, 0, 0, cw, ch);
        var timeSec = frame.timestamp / 1e6;
        shots.push({ index: idx, time: timeSec, dataUrl: null, canvasRef: null });
        var shot = shots[shots.length - 1];
        var p = canvasToJpeg(canvas).then(function (url) { shot.dataUrl = url; });
        frame.close();
        return p;
      }
      frame.close();
      return null;
    }, onProgress).then(function () {
      return shots.filter(function (s) { return s.dataUrl; });
    });
  };

  function canvasToJpeg(canvas) {
    if (canvas.convertToBlob) {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 }).then(blobToDataUrl);
    }
    return Promise.resolve(canvas.toDataURL('image/jpeg', 0.72));
  }

  function blobToDataUrl(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Pasada 2: puntaje de texto por frame dentro de la caja de cada segmento.
   * Devuelve los segmentos con firstFrame/lastFrame exactos.
   */
  Pipeline.refine = function (track, samples, segments, onProgress) {
    var W = track.width, H = track.height;
    var canvas = makeCanvas(W, H);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var scores = segments.map(function () { return []; });
    var times = [];

    return SR.Video.decodeAll(track, samples, function (frame, idx) {
      var t = frame.timestamp / 1e6;
      times[idx] = t;
      // solo leemos pixeles si algun segmento puede estar activo cerca de aqui
      var need = segments.some(function (seg) {
        return t >= seg.start - 1.0 && t <= seg.end + 1.0;
      });
      if (need) {
        ctx.drawImage(frame, 0, 0);
        var img = ctx.getImageData(0, 0, W, H);
        for (var s = 0; s < segments.length; s++) {
          var seg = segments[s];
          if (t < seg.start - 1.0 || t > seg.end + 1.0) { scores[s][idx] = 0; continue; }
          scores[s][idx] = SR.textScore(img.data, W, H, seg.pixelBox);
        }
      } else {
        for (var s2 = 0; s2 < segments.length; s2++) scores[s2][idx] = 0;
      }
      frame.close();
      return null;
    }, onProgress).then(function (frameCount) {
      segments.forEach(function (seg, si) {
        var sc = scores[si];

        // frame semilla: el de mayor puntaje dentro del rango que dio Claude.
        // El umbral se calcula sobre ESE puntaje, no sobre el maximo global: si otra
        // escena del video tiene mucho texto, un maximo global inflaria el umbral y
        // cortaria el segmento por la mitad.
        var seed = -1, seedScore = -1;
        for (var j = 0; j < frameCount; j++) {
          var t = times[j];
          if (t >= seg.start && t <= seg.end && sc[j] > seedScore) { seedScore = sc[j]; seed = j; }
        }
        var threshold = Math.max(100, seedScore * 0.20);
        if (seed < 0 || seedScore < 100) {
          // no se encontro texto: se respeta lo que dijo Claude
          seg.firstFrame = frameIndexAt(times, frameCount, seg.start, true);
          seg.lastFrame = frameIndexAt(times, frameCount, seg.end, false);
          seg.refined = false;
          return;
        }
        var a = seed, b = seed;
        while (a - 1 >= 0 && sc[a - 1] >= threshold) a--;
        while (b + 1 < frameCount && sc[b + 1] >= threshold) b++;
        seg.firstFrame = a;
        seg.lastFrame = b;
        seg.refined = true;
        seg.start = times[a];
        seg.end = times[b] + 0.001;
      });
      return segments;
    });
  };

  function frameIndexAt(times, count, t, isStart) {
    for (var i = 0; i < count; i++) {
      if (times[i] >= t) return i;
    }
    return isStart ? count : count - 1;
  }

  /**
   * Pasada 3: borra el texto original, dibuja el nuevo y reencoda.
   * @returns {Promise<Blob>}
   */
  Pipeline.process = function (opts) {
    var track = opts.track, samples = opts.samples, segments = opts.segments;
    var W = track.width, H = track.height;

    var canvas = makeCanvas(W, H);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var fps = opts.fps || 30;
    var inpaintOpts = opts.inpaintOptions || {};
    var style = opts.style || {};

    return SR.Video.createEncoder({
      width: W, height: H,
      framerate: fps,
      bitrate: opts.bitrate || Math.round(W * H * fps * 0.12),
      audio: opts.audio || null
    }).then(function (encoder) {
      if (opts.audio && opts.audioSamples && opts.audioSamples.length) {
        encoder.addAudio(opts.audioSamples, opts.audio.description);
      }
      if (opts.onCodec) opts.onCodec(encoder.codec);

      return SR.Video.decodeAll(track, samples, function (frame, idx) {
      ctx.drawImage(frame, 0, 0);
      var ts = frame.timestamp;
      var dur = frame.duration || (1e6 / fps);
      frame.close();

      var active = [];
      for (var s = 0; s < segments.length; s++) {
        var seg = segments[s];
        if (idx >= seg.firstFrame && idx <= seg.lastFrame) active.push(seg);
      }

      if (active.length && !opts.skipRemoval) {
        var img = ctx.getImageData(0, 0, W, H);
        var touched = false;
        for (var a = 0; a < active.length; a++) {
          var segA = active[a];
          // ajustamos la caja al texto de ESTE frame: los subtitulos se mueven o
          // cambian de largo, y una caja fija inpaintaria de mas.
          var box = SR.tightenBox(img.data, W, H, segA.pixelBox, 10, inpaintOpts);
          if (!box) continue;
          var built = SR.buildMask(img.data, W, H, box, inpaintOpts);
          if (SR.inpaintTelea(img.data, W, H, built, inpaintOpts.radius)) touched = true;
        }
        if (touched) ctx.putImageData(img, 0, 0);
      }

      for (var d = 0; d < active.length; d++) {
        var segD = active[d];
        if (!segD.enabled || !segD.translated) continue;
        // lo que el usuario fije en ajustes avanzados manda sobre lo detectado
        SR.Overlay.draw(ctx, segD.translated, W, H, {
          fontSize: style.fontSize || segD.fontSize,
          position: segD.position || 'bottom',
          marginV: style.marginV != null ? style.marginV : segD.marginV,
          color: style.color,
          outline: style.outline,
          outlineRatio: style.outlineRatio,
          maxWidthRatio: style.maxWidthRatio
        });
      }

      if (opts.onFrame) opts.onFrame(idx, samples.length, canvas);
      return encoder.addFrame(canvas, ts, dur);
      }, opts.onProgress).then(function () {
        return encoder.finalize();
      });
    });
  };

  if (typeof module === 'object' && module.exports) module.exports = Pipeline;
})(typeof globalThis !== 'undefined' ? globalThis : this);
