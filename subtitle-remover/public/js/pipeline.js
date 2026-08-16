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
  Pipeline.sampleFrames = function (src, count, onProgress) {
    var track = src.track, samples = src.samples;
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

    return SR.Video.decodeAll(src, function (source, idx, info) {
      if (wantedSet[idx]) {
        ctx.drawImage(source, 0, 0, cw, ch);
        var shot = { index: idx, time: info.timestamp / 1e6, dataUrl: null };
        shots.push(shot);
        var p = canvasToJpeg(canvas).then(function (url) { shot.dataUrl = url; });
        info.close();
        return p;
      }
      info.close();
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

  /** Rejilla de luminancia submuestreada de una caja: comparar frames sale barato. */
  function lumaGrid(data, W, box, step) {
    var w = Math.ceil((box.x1 - box.x0) / step);
    var h = Math.ceil((box.y1 - box.y0) / step);
    var out = new Uint8Array(w * h);
    var k = 0;
    for (var y = box.y0; y < box.y1; y += step) {
      var row = y * W;
      for (var x = box.x0; x < box.x1; x += step) {
        var i = (row + x) * 4;
        out[k++] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      }
    }
    return out;
  }

  function meanAbsDiff(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  /**
   * Pasada 2: localizar el primer y el ultimo fotograma de cada elemento.
   *
   * Segun el tipo se mide una cosa u otra:
   *
   *  subtitle — pixeles de texto (claro con contorno oscuro) dentro de la caja.
   *  overlay  — parecido con una PLANTILLA: se toma la caja en un fotograma donde
   *             Claude dice que el elemento esta, y se compara con la misma caja en
   *             cada fotograma. Un sticker opaco es identico mientras se ve, y muy
   *             distinto cuando no esta porque debajo se ve el video. Buscar texto
   *             aqui no sirve: un recuadro de comentario es fondo claro con letras
   *             oscuras, justo al reves que un subtitulo.
   */
  Pipeline.refine = function (src, segments, onProgress) {
    var track = src.track;
    var W = track.width, H = track.height;
    var canvas = makeCanvas(W, H);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var scores = segments.map(function () { return []; });   // subtitle
    var grids = segments.map(function () { return []; });    // overlay
    // Para la plantilla del overlay se usa el CENTRO de la caja, no la caja entera:
    // los bordes llevan margen de sobra y ahi se ve el video moviendose, lo que
    // dispara la diferencia en cada fotograma y arruina la comparacion.
    var boxes = segments.map(function (seg) {
      var b = SR.clampBox(seg.pixelBox, W, H);
      if (seg.kind !== 'overlay') return b;
      var insetX = Math.max(3, Math.round((b.x1 - b.x0) * 0.15));
      var insetY = Math.max(3, Math.round((b.y1 - b.y0) * 0.15));
      return SR.clampBox({
        x0: b.x0 + insetX, y0: b.y0 + insetY,
        x1: b.x1 - insetX, y1: b.y1 - insetY
      }, W, H);
    });
    var times = [];

    return SR.Video.decodeAll(src, function (source, idx, info) {
      var t = info.timestamp / 1e6;
      times[idx] = t;
      // solo leemos pixeles si algun segmento puede estar activo cerca de aqui
      var need = segments.some(function (seg) {
        return t >= seg.start - 1.0 && t <= seg.end + 1.0;
      });
      if (need) {
        ctx.drawImage(source, 0, 0);
        var img = ctx.getImageData(0, 0, W, H);
        for (var s = 0; s < segments.length; s++) {
          var seg = segments[s];
          if (t < seg.start - 1.0 || t > seg.end + 1.0) { scores[s][idx] = 0; continue; }
          if (seg.kind === 'overlay') {
            grids[s][idx] = lumaGrid(img.data, W, boxes[s], 2);
          } else {
            scores[s][idx] = SR.textScore(img.data, W, H, seg.pixelBox);
          }
        }
      } else {
        for (var s2 = 0; s2 < segments.length; s2++) scores[s2][idx] = 0;
      }
      info.close();
      return null;
    }, onProgress).then(function (frameCount) {
      segments.forEach(function (seg, si) {
        var fallback = function () {
          seg.firstFrame = frameIndexAt(times, frameCount, seg.start, true);
          seg.lastFrame = frameIndexAt(times, frameCount, seg.end, false);
          seg.refined = false;
        };

        if (seg.kind === 'overlay') {
          // plantilla: el fotograma mas cercano al centro del rango que dio Claude
          var mid = (seg.start + seg.end) / 2;
          var seedO = -1, bestD = Infinity;
          for (var k = 0; k < frameCount; k++) {
            if (!grids[si][k]) continue;
            var d = Math.abs(times[k] - mid);
            if (d < bestD) { bestD = d; seedO = k; }
          }
          if (seedO < 0) return fallback();

          var tpl = grids[si][seedO];
          var sim = [], maxSim = 0;
          for (var m = 0; m < frameCount; m++) {
            sim[m] = grids[si][m] ? meanAbsDiff(grids[si][m], tpl) : -1;
            if (sim[m] > maxSim) maxSim = sim[m];
          }
          // Si nunca se despega de la plantilla no hay contraste para decidir:
          // puede que el elemento dure todo el rango, o que el fondo no cambie.
          if (maxSim < 6) return fallback();

          var thrO = Math.min(12, Math.max(3, maxSim * 0.25));
          var ao = seedO, bo = seedO;
          while (ao - 1 >= 0 && sim[ao - 1] >= 0 && sim[ao - 1] <= thrO) ao--;
          while (bo + 1 < frameCount && sim[bo + 1] >= 0 && sim[bo + 1] <= thrO) bo++;
          seg.firstFrame = ao;
          seg.lastFrame = bo;
          seg.refined = true;
          seg.start = times[ao];
          seg.end = times[bo] + 0.001;
          return;
        }

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
        if (seed < 0 || seedScore < 100) return fallback();

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
    var src = opts.src;
    var track = src.track, samples = src.samples, segments = opts.segments;
    var W = track.width, H = track.height;

    var canvas = makeCanvas(W, H);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var fps = opts.fps || 30;
    var inpaintOpts = opts.inpaintOptions || {};
    var style = opts.style || {};
    // Cuantos frames se limpiaron de verdad. Si sale 0 habiendo segmentos activos,
    // algo fallo silenciosamente (el caso clasico: se leyeron fotogramas que no
    // correspondian) y hay que decirlo en vez de entregar el video intacto.
    var cleanedFrames = 0;
    var framesWithSegments = 0;

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

      return SR.Video.decodeAll(src, function (source, idx, info) {
      ctx.drawImage(source, 0, 0);
      var ts = info.timestamp;
      var dur = info.duration || (1e6 / fps);
      info.close();

      var active = [];
      for (var s = 0; s < segments.length; s++) {
        var seg = segments[s];
        if (idx >= seg.firstFrame && idx <= seg.lastFrame) active.push(seg);
      }
      if (active.length) framesWithSegments++;

      if (active.length && !opts.skipRemoval) {
        var img = ctx.getImageData(0, 0, W, H);
        var touched = false;
        for (var a = 0; a < active.length; a++) {
          var segA = active[a];
          var built;
          if (segA.kind === 'overlay') {
            // opaco: no hay glifos que buscar, se quita el rectangulo entero
            built = SR.buildBoxMask(W, H, segA.pixelBox);
          } else {
            // ajustamos la caja al texto de ESTE frame: los subtitulos se mueven o
            // cambian de largo, y una caja fija inpaintaria de mas.
            var box = SR.tightenBox(img.data, W, H, segA.pixelBox, 10, inpaintOpts);
            if (!box) continue;
            built = SR.buildMask(img.data, W, H, box, inpaintOpts);
          }
          if (SR.inpaintTelea(img.data, W, H, built, inpaintOpts.radius)) touched = true;
        }
        if (touched) { ctx.putImageData(img, 0, 0); cleanedFrames++; }
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
        if (!opts.skipRemoval && framesWithSegments > 0 && cleanedFrames === 0) {
          throw new Error(
            'No se encontró texto que borrar en ninguno de los ' + framesWithSegments +
            ' fotogramas marcados, así que el video habría salido igual que el original. ' +
            'Suele pasar cuando la caja del segmento no cae sobre el subtítulo: revisa la ' +
            'zona en el paso 3, o vuelve a analizar con más fotogramas.'
          );
        }
        return encoder.finalize().then(function (blob) {
          return { blob: blob, cleanedFrames: cleanedFrames, framesWithSegments: framesWithSegments };
        });
      });
    });
  };

  if (typeof module === 'object' && module.exports) module.exports = Pipeline;
})(typeof globalThis !== 'undefined' ? globalThis : this);
