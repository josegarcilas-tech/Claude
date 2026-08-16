/*
 * zip.js — escritor ZIP minimo, solo modo "store" (sin comprimir).
 *
 * Los MP4 ya vienen comprimidos: intentar deflate no ganaria casi nada y
 * obligaria a cargar una libreria. Guardarlos tal cual permite juntar todos los
 * videos en un unico archivo sin dependencias.
 *
 * En el movil esto ademas importa: los navegadores bloquean las descargas
 * multiples seguidas, asi que un solo ZIP es la unica forma fiable de bajarlo todo.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) {
    if (root.TextEncoder) return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  /** Fecha y hora en el formato MS-DOS que usa el ZIP. */
  function dosDateTime(d) {
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  function writer(len) {
    var buf = new Uint8Array(len);
    var p = 0;
    return {
      buf: buf,
      u16: function (v) { buf[p++] = v & 0xFF; buf[p++] = (v >>> 8) & 0xFF; },
      u32: function (v) {
        buf[p++] = v & 0xFF; buf[p++] = (v >>> 8) & 0xFF;
        buf[p++] = (v >>> 16) & 0xFF; buf[p++] = (v >>> 24) & 0xFF;
      },
      bytes: function (b) { buf.set(b, p); p += b.length; },
      get pos() { return p; }
    };
  }

  /**
   * Construye un ZIP a partir de [{ name, blob }].
   * @returns {Promise<Blob>}
   */
  SR.makeZip = function (entries) {
    var prepared = [];

    return entries.reduce(function (chain, e) {
      return chain.then(function () {
        return e.blob.arrayBuffer().then(function (ab) {
          var data = new Uint8Array(ab);
          prepared.push({ name: utf8(e.name), data: data, crc: crc32(data) });
        });
      });
    }, Promise.resolve()).then(function () {
      var stamp = dosDateTime(new Date());

      var localSize = 0, centralSize = 0;
      prepared.forEach(function (f) {
        localSize += 30 + f.name.length + f.data.length;
        centralSize += 46 + f.name.length;
      });

      var w = writer(localSize + centralSize + 22);
      var offsets = [];

      prepared.forEach(function (f) {
        offsets.push(w.pos);
        w.u32(0x04034B50);        // firma de cabecera local
        w.u16(20);                // version necesaria
        w.u16(0x0800);            // nombres en UTF-8
        w.u16(0);                 // metodo: store
        w.u16(stamp.time);
        w.u16(stamp.date);
        w.u32(f.crc);
        w.u32(f.data.length);     // comprimido
        w.u32(f.data.length);     // sin comprimir
        w.u16(f.name.length);
        w.u16(0);                 // sin campos extra
        w.bytes(f.name);
        w.bytes(f.data);
      });

      var centralStart = w.pos;
      prepared.forEach(function (f, i) {
        w.u32(0x02014B50);        // firma del directorio central
        w.u16(20);                // version que lo creo
        w.u16(20);                // version necesaria
        w.u16(0x0800);
        w.u16(0);
        w.u16(stamp.time);
        w.u16(stamp.date);
        w.u32(f.crc);
        w.u32(f.data.length);
        w.u32(f.data.length);
        w.u16(f.name.length);
        w.u16(0);                 // extra
        w.u16(0);                 // comentario
        w.u16(0);                 // disco
        w.u16(0);                 // atributos internos
        w.u32(0);                 // atributos externos
        w.u32(offsets[i]);
        w.bytes(f.name);
      });

      var centralBytes = w.pos - centralStart;
      w.u32(0x06054B50);          // fin del directorio central
      w.u16(0); w.u16(0);
      w.u16(prepared.length);
      w.u16(prepared.length);
      w.u32(centralBytes);
      w.u32(centralStart);
      w.u16(0);                   // sin comentario

      return new Blob([w.buf], { type: 'application/zip' });
    });
  };

  if (typeof module === 'object' && module.exports) module.exports = SR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
