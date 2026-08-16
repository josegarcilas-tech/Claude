/*
 * video.js — demux / decode / encode / mux en el navegador.
 *
 * mp4box.js  -> separa las pistas y entrega las muestras codificadas
 * WebCodecs  -> decodifica y vuelve a codificar el video (acelerado por hardware)
 * mp4-muxer  -> arma el MP4 final
 *
 * El audio NO se recodifica: las muestras AAC originales se copian tal cual al
 * archivo de salida, asi que la pista de audio queda bit a bit identica.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var Video = (SR.Video = {});

  /**
   * Para decodificar hay respaldo con un <video> normal, asi que lo unico
   * imprescindible es poder CODIFICAR el resultado.
   */
  Video.isSupported = function () {
    return typeof root.VideoEncoder === 'function' &&
           typeof root.EncodedVideoChunk === 'function';
  };

  Video.hasDecoder = function () {
    return typeof root.VideoDecoder === 'function' &&
           typeof root.EncodedVideoChunk === 'function';
  };

  /** Camino de decodificacion que acabo usandose ('webcodecs' | 'element' | null). */
  Video.decodeMode = function () { return preferredMode; };

  /** Extrae el `description` (avcC/hvcC/...) que necesita VideoDecoder. */
  function codecDescription(file, trackId) {
    // mp4box expone DataStream como global propio, no como propiedad de MP4Box.
    var DS = root.DataStream;
    if (!DS) return null;
    var trak = file.getTrackById(trackId);
    var entries = trak.mdia.minf.stbl.stsd.entries;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var box = e.avcC || e.hvcC || e.vpcC || e.av1C;
      if (!box) continue;
      var stream = new DS(undefined, 0, DS.BIG_ENDIAN);
      box.write(stream);
      // los primeros 8 bytes son la cabecera del box (size + type)
      return new Uint8Array(stream.buffer, 8);
    }
    return null;
  }

  /** AudioSpecificConfig del esds, para poder remuxear AAC sin recodificar. */
  function audioDescription(file, trackId) {
    try {
      var trak = file.getTrackById(trackId);
      var entries = trak.mdia.minf.stbl.stsd.entries;
      for (var i = 0; i < entries.length; i++) {
        var esds = entries[i].esds;
        if (esds && esds.esd) {
          var descs = esds.esd.descs || [];
          for (var j = 0; j < descs.length; j++) {
            var inner = descs[j].descs || [];
            for (var k = 0; k < inner.length; k++) {
              if (inner[k].data) return new Uint8Array(inner[k].data);
            }
          }
        }
      }
    } catch (e) { /* sin ASC => se descarta el audio, se avisa arriba */ }
    return null;
  }

  /**
   * Lee el MP4 completo y devuelve pistas + muestras codificadas.
   * @returns {Promise<Object>}
   */
  Video.demux = function (file) {
    return new Promise(function (resolve, reject) {
      if (!root.MP4Box) return reject(new Error('mp4box no se cargo'));
      var mp4 = root.MP4Box.createFile();
      var result = { video: null, audio: null, videoSamples: [], audioSamples: [] };
      var expected = 0, done = 0;

      mp4.onError = function (e) { reject(new Error('No se pudo leer el MP4: ' + e)); };

      mp4.onReady = function (info) {
        var v = info.videoTracks && info.videoTracks[0];
        var a = info.audioTracks && info.audioTracks[0];
        if (!v) return reject(new Error('El archivo no tiene pista de video.'));

        result.video = {
          id: v.id,
          codec: v.codec,
          width: v.video.width,
          height: v.video.height,
          timescale: v.timescale,
          duration: v.duration,
          nbSamples: v.nb_samples,
          description: codecDescription(mp4, v.id)
        };
        expected++;
        mp4.setExtractionOptions(v.id, 'video', { nbSamples: Infinity });

        if (a) {
          result.audio = {
            id: a.id,
            codec: a.codec,
            timescale: a.timescale,
            sampleRate: a.audio.sample_rate,
            channels: a.audio.channel_count,
            description: audioDescription(mp4, a.id)
          };
          expected++;
          mp4.setExtractionOptions(a.id, 'audio', { nbSamples: Infinity });
        }
        mp4.start();
      };

      mp4.onSamples = function (id, user, samples) {
        var target = user === 'video' ? result.videoSamples : result.audioSamples;
        for (var i = 0; i < samples.length; i++) {
          var s = samples[i];
          target.push({
            data: new Uint8Array(s.data),
            isKey: s.is_sync,
            // WebCodecs trabaja en microsegundos
            timestamp: (s.cts / s.timescale) * 1e6,
            duration: (s.duration / s.timescale) * 1e6
          });
        }
        var expectedCount = user === 'video'
          ? result.video.nbSamples
          : (samples[0] ? samples[0].track_nb_samples : 0);
        if (target.length >= expectedCount) {
          done++;
          if (done >= expected) finish();
        }
      };

      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        result.videoSamples.sort(function (p, q) { return p.timestamp - q.timestamp; });
        resolve(result);
      }

      file.arrayBuffer().then(function (buf) {
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
        // si el conteo de muestras no cerro exacto, resolvemos igual tras el flush
        setTimeout(function () {
          if (!finished && result.video && result.videoSamples.length) finish();
          else if (!finished) reject(new Error('No se pudieron extraer los frames del video.'));
        }, 0);
      }).catch(reject);
    });
  };

  function delay(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /**
   * Decodificacion. Hay dos caminos:
   *
   *   webcodecs — VideoDecoder. Rapido y con acceso exacto a cada frame.
   *   element   — un <video> normal al que se le va moviendo currentTime.
   *               Mas lento, pero solo usa APIs que existen en todas partes.
   *
   * En iOS (iPhone y iPad, y por tanto Chrome, Edge y Firefox en iOS, que estan
   * obligados a usar WebKit) VideoDecoder aborta con "Decoder failure" en videos de
   * unos pocos segundos. Reproducir video, en cambio, es justo lo que esos equipos
   * hacen bien. Por eso se intenta WebCodecs y, si falla, se repite con el <video>.
   *
   * El callback recibe (source, index, info):
   *   source — algo que ctx.drawImage() acepte (VideoFrame o HTMLVideoElement)
   *   info   — { timestamp, duration, close() }; hay que llamar a close() al terminar
   *            con el source, y si el callback devuelve una promesa se espera.
   */
  var preferredMode = null;   // se recuerda el que funciono, para las pasadas siguientes

  Video.decodeAll = function (src, onFrame, onProgress) {
    if (preferredMode === 'element' || !Video.hasDecoder()) {
      return decodeWithElement(src, onFrame, onProgress);
    }
    return decodeWithCodecs(src, onFrame, onProgress).then(function (n) {
      preferredMode = 'webcodecs';
      return n;
    }, function (err) {
      if (preferredMode === 'webcodecs') throw err;  // ya funcionaba: el fallo es otro
      preferredMode = 'element';
      return decodeWithElement(src, onFrame, onProgress);
    });
  };

  /** Camino rapido: VideoDecoder de WebCodecs. */
  function decodeWithCodecs(src, onFrame, onProgress) {
    var track = src.track, samples = src.samples;
    var index = 0;
    var pending = Promise.resolve();
    var failure = null;
    var total = samples.length;

    var decoder = new root.VideoDecoder({
      output: function (frame) {
        if (failure) { try { frame.close(); } catch (_) {} return; }
        var i = index++;
        var res;
        var info = {
          timestamp: frame.timestamp,
          duration: frame.duration,
          close: function () { try { frame.close(); } catch (_) {} }
        };
        try {
          // sincrono: el callback dibuja y cierra el frame antes de devolver
          res = onFrame(frame, i, info);
        } catch (e) {
          failure = e;
          info.close();
          return;
        }
        if (res && typeof res.then === 'function') {
          pending = pending.then(function () { return res; });
        }
        if (onProgress && (i % 5 === 0)) onProgress(i, total);
      },
      error: function (e) {
        failure = e instanceof Error ? e : new Error(String(e && e.message || e));
      }
    });

    var config = {
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      hardwareAcceleration: 'no-preference'
    };
    if (track.description) config.description = track.description;

    try {
      decoder.configure(config);
    } catch (e) {
      return Promise.reject(new Error('El códec del video no es compatible (' + track.codec + ').'));
    }

    var next = 0;

    function decoderError() {
      var msg = String(failure && failure.message || failure || 'Decoder failure');
      return new Error('WebCodecs no pudo decodificar el video (' + msg + ').');
    }

    function pump() {
      if (failure) return Promise.reject(decoderError());

      // alimentamos en tandas cortas y solo si el decodificador va desahogado
      var fed = 0;
      while (next < total && decoder.decodeQueueSize < 6 && fed < 6) {
        var s = samples[next++];
        fed++;
        try {
          decoder.decode(new root.EncodedVideoChunk({
            type: s.isKey ? 'key' : 'delta',
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data
          }));
        } catch (e) {
          failure = e;
          return Promise.reject(decoderError());
        }
      }

      if (next >= total) {
        // flush() ya espera a que salga todo lo que quede dentro del decodificador
        return pending
          .then(function () { return decoder.flush(); })
          .then(function () { return pending; })
          .then(function () {
            if (failure) throw decoderError();
            try { decoder.close(); } catch (_) {}
            return index;
          });
      }

      // esperar al consumidor mantiene acotada la memoria de toda la cadena
      return pending.then(function () { return delay(0); }).then(pump);
    }

    return Promise.resolve().then(pump).catch(function (e) {
      try { decoder.close(); } catch (_) {}
      throw e;
    });
  }

  /**
   * Camino compatible: un <video> al que se le mueve currentTime frame a frame.
   * Se usan las marcas de tiempo exactas que dio el demuxer y se apunta al centro
   * de cada frame, para caer siempre en el correcto pese al redondeo del seek.
   */
  function decodeWithElement(src, onFrame, onProgress) {
    if (!src.file) {
      return Promise.reject(new Error('No se puede decodificar: falta el archivo original.'));
    }
    var samples = src.samples;
    var total = samples.length;
    var url = root.URL.createObjectURL(src.file);
    var v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';

    // iOS no pinta fotogramas de un <video> que no esta en el documento, y con
    // display:none o width:0 tampoco. Tiene que estar puesto y "renderizado",
    // aunque sea de 2px y practicamente invisible.
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;' +
                      'opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(v);

    function cleanup() {
      try { v.pause(); } catch (_) {}
      try { if (v.parentNode) v.parentNode.removeChild(v); } catch (_) {}
      try { v.removeAttribute('src'); v.load(); } catch (_) {}
      try { root.URL.revokeObjectURL(url); } catch (_) {}
    }

    /**
     * iOS solo empieza a decodificar de verdad despues de una reproduccion. Un
     * play() seguido de pause() deja el elemento listo sin que se oiga ni se vea.
     */
    function prime() {
      try {
        var p = v.play();
        if (p && typeof p.then === 'function') {
          return p.then(function () { try { v.pause(); } catch (_) {} },
                        function () { /* sin gesto de usuario: seguimos igual */ });
        }
        try { v.pause(); } catch (_) {}
      } catch (_) { /* da igual, seguimos */ }
      return Promise.resolve();
    }

    /**
     * `seeked` dice que la busqueda termino, NO que el fotograma nuevo ya se pinto.
     * En iOS dibujar en ese momento devuelve el fotograma anterior, asi que la
     * mascara se calcula sobre una imagen que no corresponde y no se borra nada
     * (el video sale entero, como si la app no hubiera hecho su trabajo).
     * requestVideoFrameCallback avisa cuando el fotograma esta realmente presentado.
     */
    function framePresented() {
      if (typeof v.requestVideoFrameCallback !== 'function') {
        return delay(0);
      }
      return new Promise(function (res) {
        var done = false;
        var finish = function () { if (!done) { done = true; res(); } };
        var id = v.requestVideoFrameCallback(finish);
        setTimeout(function () {
          if (done) return;
          try { v.cancelVideoFrameCallback(id); } catch (_) {}
          finish();
        }, 300);
      });
    }

    function ready() {
      return new Promise(function (res, rej) {
        var done = false;
        var ok = function () { if (!done) { done = true; res(); } };
        var bad = function () {
          if (done) return;
          done = true;
          rej(new Error('El navegador no pudo abrir el video para reproducirlo.'));
        };
        if (v.readyState >= 2) return ok();
        v.addEventListener('loadeddata', ok, { once: true });
        v.addEventListener('canplay', ok, { once: true });
        v.addEventListener('error', bad, { once: true });
        setTimeout(bad, 30000);
      });
    }

    function seekTo(t) {
      return new Promise(function (res, rej) {
        var done = false;
        var ok = function () { if (!done) { done = true; res(); } };
        var bad = function () {
          if (done) return;
          done = true;
          rej(new Error('El navegador se quedó bloqueado al buscar dentro del video.'));
        };
        v.addEventListener('seeked', ok, { once: true });
        v.addEventListener('error', bad, { once: true });
        var guard = setTimeout(bad, 15000);
        var clear = function () { clearTimeout(guard); };
        v.addEventListener('seeked', clear, { once: true });
        try {
          v.currentTime = t;
        } catch (e) {
          done = true; clear(); rej(e);
        }
      });
    }

    var i = 0;
    var pending = Promise.resolve();

    function step() {
      if (i >= total) return pending.then(function () { return total; });
      var s = samples[i];
      // al centro del frame: el seek redondea al frame que contiene ese instante
      var t = (s.timestamp + (s.duration || 0) / 2) / 1e6;
      var idx = i++;
      return seekTo(t).then(framePresented).then(function () {
        var info = { timestamp: s.timestamp, duration: s.duration, close: function () {} };
        var res = onFrame(v, idx, info);
        if (res && typeof res.then === 'function') {
          pending = pending.then(function () { return res; });
        }
        if (onProgress && (idx % 5 === 0)) onProgress(idx, total);
        return pending;
      }).then(step);
    }

    return ready()
      .then(prime)
      .then(step)
      .then(function (n) { cleanup(); return n; })
      .catch(function (e) { cleanup(); throw e; });
  }


  // Preferimos H.264: es lo que reproduce cualquier reproductor, telefono y red
  // social. Los demas son respaldo por si el navegador no trae el codec.
  var CODEC_CANDIDATES = [
    { codec: 'avc1.640028', mux: 'avc' },   // High profile
    { codec: 'avc1.42E01E', mux: 'avc' },   // Baseline
    { codec: 'vp09.00.10.08', mux: 'vp9' },
    { codec: 'av01.0.04M.08', mux: 'av1' }
  ];

  /** Primer codec de salida que este navegador sepa codificar. */
  Video.pickCodec = function (width, height, framerate, bitrate) {
    var i = 0;
    function next() {
      if (i >= CODEC_CANDIDATES.length) {
        return Promise.reject(new Error('Este navegador no puede codificar video (ni H.264 ni VP9 ni AV1).'));
      }
      var cand = CODEC_CANDIDATES[i++];
      return root.VideoEncoder.isConfigSupported({
        codec: cand.codec,
        width: width, height: height,
        bitrate: bitrate || 4000000,
        framerate: framerate || 30
      }).then(function (res) {
        return res.supported ? cand : next();
      }).catch(next);
    }
    return next();
  };

  /**
   * Crea un codificador + muxer listos para recibir frames procesados.
   * @returns {Promise<Object>} { addFrame, addAudio, finalize, codec }
   */
  Video.createEncoder = function (opts) {
    var Mux = root.Mp4Muxer;
    if (!Mux) return Promise.reject(new Error('mp4-muxer no se cargo'));

    return Video.pickCodec(opts.width, opts.height, opts.framerate, opts.bitrate)
      .then(function (chosen) { return buildEncoder(opts, chosen, Mux); });
  };

  function buildEncoder(opts, chosen, Mux) {
    var muxer = new Mux.Muxer({
      target: new Mux.ArrayBufferTarget(),
      video: { codec: chosen.mux, width: opts.width, height: opts.height },
      audio: opts.audio ? {
        codec: 'aac',
        numberOfChannels: opts.audio.channels,
        sampleRate: opts.audio.sampleRate
      } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset'
    });

    var encoderError = null;
    var encoder = new root.VideoEncoder({
      output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
      error: function (e) { encoderError = e; }
    });

    encoder.configure({
      codec: chosen.codec,
      width: opts.width,
      height: opts.height,
      bitrate: opts.bitrate || 6000000,
      framerate: opts.framerate || 30,
      latencyMode: 'quality'
    });

    var frameCount = 0;

    return {
      codec: chosen.codec,
      addFrame: function (source, timestamp, duration) {
        if (encoderError) throw encoderError;
        var frame = new root.VideoFrame(source, {
          timestamp: Math.round(timestamp),
          duration: Math.round(duration)
        });
        // un keyframe cada 2s mantiene el archivo navegable
        var key = (frameCount % Math.max(1, Math.round((opts.framerate || 30) * 2))) === 0;
        encoder.encode(frame, { keyFrame: key });
        frame.close();
        frameCount++;
        // no dejamos crecer la cola sin control
        if (encoder.encodeQueueSize > 16) {
          return new Promise(function (res) {
            var check = function () {
              if (encoder.encodeQueueSize <= 8) res();
              else setTimeout(check, 4);
            };
            check();
          });
        }
        return null;
      },

      addAudio: function (samples, description) {
        if (!opts.audio) return;
        for (var i = 0; i < samples.length; i++) {
          var s = samples[i];
          var meta = (i === 0 && description) ? {
            decoderConfig: {
              codec: opts.audio.codec || 'mp4a.40.2',
              sampleRate: opts.audio.sampleRate,
              numberOfChannels: opts.audio.channels,
              description: description
            }
          } : undefined;
          muxer.addAudioChunkRaw(s.data, 'key', s.timestamp, s.duration, meta);
        }
      },

      finalize: function () {
        return encoder.flush().then(function () {
          if (encoderError) throw encoderError;
          try { encoder.close(); } catch (_) {}
          muxer.finalize();
          return new Blob([muxer.target.buffer], { type: 'video/mp4' });
        });
      }
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = Video;
})(typeof globalThis !== 'undefined' ? globalThis : this);
