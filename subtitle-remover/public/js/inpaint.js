/*
 * inpaint.js — deteccion de texto quemado + reconstruccion del fondo.
 *
 * Es el mismo metodo que se valido a mano con OpenCV/ffmpeg sobre un video real,
 * portado a JS puro para correr sobre ImageData en el navegador (sin WASM, sin deps).
 *
 * Por cada region de subtitulo:
 *   1. mascara = relleno claro del glifo + contorno oscuro pegado a ese relleno
 *      (+ emojis: manchas saturadas, compactas y de tamano de glifo).
 *   2. dilatacion generosa: hay que cubrir todo el antialiasing, si no queda un
 *      "fantasma" con la forma de las letras.
 *   3. relleno: Telea / Fast Marching Method, en telea.js.
 *
 * Todo son funciones puras sobre buffers RGBA => testeables fuera del navegador.
 * Las mascaras se manejan en coordenadas locales a la caja para no recorrer el
 * frame completo en cada paso.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});

  var DEFAULTS = {
    whiteThreshold: 175,  // relleno del glifo
    darkThreshold: 105,   // contorno del glifo
    outlineReach: 6,      // hasta donde se considera "contorno pegado al relleno"
    grow: 4,              // dilatacion final; <4 deja fantasma del texto
    radius: 4,            // vecindad de Telea (inpaintRadius de OpenCV)
    removeEmoji: true
  };

  SR.DEFAULTS = DEFAULTS;

  // -------------------------------------------------------------- scratch pool
  // Reutilizamos buffers entre frames: procesamos cientos de frames seguidos y
  // asignar arrays nuevos cada vez dispara el GC.
  var pool = {};
  function scratch(name, len, Ctor) {
    var b = pool[name];
    if (!b || b.length < len) b = pool[name] = new Ctor(len);
    return b;
  }

  function clampBox(box, W, H) {
    var x0 = Math.max(0, Math.min(W - 1, Math.round(box.x0)));
    var y0 = Math.max(0, Math.min(H - 1, Math.round(box.y0)));
    var x1 = Math.max(x0 + 1, Math.min(W, Math.round(box.x1)));
    var y1 = Math.max(y0 + 1, Math.min(H, Math.round(box.y1)));
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  SR.clampBox = clampBox;

  function luma(rgba, i) {
    return (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }

  /** Dilatacion binaria cuadrada (2r+1)^2, separable, sobre un buffer local w*h. */
  function dilateLocal(buf, w, h, radius, tmpName) {
    if (radius <= 0) return;
    var tmp = scratch(tmpName || 'dil', w * h, Uint8Array);
    var x, y, k, v;
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        v = 0;
        var xa = x - radius; if (xa < 0) xa = 0;
        var xb = x + radius; if (xb > w - 1) xb = w - 1;
        for (k = xa; k <= xb; k++) { if (buf[row + k]) { v = 1; break; } }
        tmp[row + x] = v;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        v = 0;
        var ya = y - radius; if (ya < 0) ya = 0;
        var yb = y + radius; if (yb > h - 1) yb = h - 1;
        for (k = ya; k <= yb; k++) { if (tmp[k * w + x]) { v = 1; break; } }
        buf[y * w + x] = v;
      }
    }
  }

  // ------------------------------------------------------------------ metricas

  /**
   * Pixeles de subtitulo: claros CON algo oscuro al lado.
   *
   * Contar solo pixeles claros no sirve — una pared blanca o un edredon claro dan
   * puntajes altisimos y hacen que los cortes caigan en el frame equivocado. Los
   * subtitulos quemados siempre llevan contorno oscuro, asi que exigir "claro con
   * oscuro cerca" los distingue del fondo sea cual sea la escena.
   *
   * Escribe la mascara local en el buffer `outlined` del pool.
   */
  function outlinedPixels(rgba, W, H, b) {
    var w = b.x1 - b.x0, h = b.y1 - b.y0, n = w * h;
    var darkMap = scratch('scDark', n, Uint8Array);
    var out = scratch('outlined', n, Uint8Array);

    for (var y = 0; y < h; y++) {
      var srow = (b.y0 + y) * W + b.x0;
      var lrow = y * w;
      for (var x = 0; x < w; x++) {
        darkMap[lrow + x] = luma(rgba, (srow + x) * 4) < 100 ? 1 : 0;
      }
    }
    dilateLocal(darkMap, w, h, 3, 'scDil');

    var count = 0;
    for (var y2 = 0; y2 < h; y2++) {
      var srow2 = (b.y0 + y2) * W + b.x0;
      var lrow2 = y2 * w;
      for (var x2 = 0; x2 < w; x2++) {
        var p = lrow2 + x2;
        var on = (luma(rgba, (srow2 + x2) * 4) > 200 && darkMap[p]) ? 1 : 0;
        out[p] = on;
        if (on) count++;
      }
    }
    return { mask: out, w: w, h: h, count: count };
  }

  /** Cuantos pixeles de subtitulo hay en la caja (para ubicar inicio y fin exactos). */
  SR.textScore = function (rgba, W, H, box) {
    var b = clampBox(box, W, H);
    return outlinedPixels(rgba, W, H, b).count;
  };

  /**
   * Encoge la caja al contenido del subtitulo realmente presente en este frame.
   * Cuenta el texto con contorno Y los emojis: si solo mirara el texto, un emoji
   * al final de la linea quedaria fuera de la caja y no se borraria.
   * Devuelve null si no hay nada que borrar.
   */
  SR.tightenBox = function (rgba, W, H, box, pad, opts) {
    pad = pad == null ? 10 : pad;
    var o = opts || {};
    var doEmoji = o.removeEmoji == null ? DEFAULTS.removeEmoji : o.removeEmoji;
    var b = clampBox(box, W, H);
    var r = outlinedPixels(rgba, W, H, b);
    if (r.count < 40) return null;

    var minX = r.w, minY = r.h, maxX = -1, maxY = -1;
    var y, x, row;
    for (y = 0; y < r.h; y++) {
      row = y * r.w;
      for (x = 0; x < r.w; x++) {
        if (!r.mask[row + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (doEmoji) {
      var em = emojiMask(rgba, W, H, b, r.w, r.h);
      if (em) {
        for (y = 0; y < r.h; y++) {
          row = y * r.w;
          for (x = 0; x < r.w; x++) {
            if (!em[row + x]) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    }

    return clampBox({
      x0: b.x0 + minX - pad,
      y0: b.y0 + minY - pad,
      x1: b.x0 + maxX + 1 + pad,
      y1: b.y0 + maxY + 1 + pad
    }, W, H);
  };

  // ------------------------------------------------------------------- mascara

  /**
   * Mascara del texto dentro de `box`, en coordenadas locales.
   * @returns {{mask:Uint8Array, box:Object, w:number, h:number, count:number}}
   */
  SR.buildMask = function (rgba, W, H, box, opts) {
    var o = opts || {};
    var whiteT = o.whiteThreshold == null ? DEFAULTS.whiteThreshold : o.whiteThreshold;
    var darkT = o.darkThreshold == null ? DEFAULTS.darkThreshold : o.darkThreshold;
    var reach = o.outlineReach == null ? DEFAULTS.outlineReach : o.outlineReach;
    var grow = o.grow == null ? DEFAULTS.grow : o.grow;
    var doEmoji = o.removeEmoji == null ? DEFAULTS.removeEmoji : o.removeEmoji;

    var b = clampBox(box, W, H);
    var w = b.x1 - b.x0, h = b.y1 - b.y0, n = w * h;

    var white = scratch('white', n, Uint8Array);
    var dark = scratch('dark', n, Uint8Array);
    var mask = new Uint8Array(n); // se devuelve, no puede venir del pool

    for (var y = 0; y < h; y++) {
      var srow = (b.y0 + y) * W + b.x0;
      var lrow = y * w;
      for (var x = 0; x < w; x++) {
        var g = luma(rgba, (srow + x) * 4);
        var p = lrow + x;
        white[p] = g > whiteT ? 1 : 0;
        dark[p] = g < darkT ? 1 : 0;
      }
    }

    // Paso clave: el relleno del glifo no es "todo lo claro", es lo claro que tiene
    // contorno oscuro al lado. Sin esta restriccion, sobre una pared blanca TODO el
    // fondo cuenta como relleno y despues cualquier estructura oscura cercana (el
    // borde de un cuadro, un mueble) entra en la mascara y se borra de mas.
    var darkDil = scratch('ddil', n, Uint8Array);
    darkDil.set(dark.subarray(0, n));
    dilateLocal(darkDil, w, h, reach, 'dilA');

    var core = scratch('core', n, Uint8Array);
    for (var p1 = 0; p1 < n; p1++) core[p1] = (white[p1] && darkDil[p1]) ? 1 : 0;

    // ...y el contorno que nos llevamos es solo el pegado a ese relleno.
    var coreDil = scratch('cdil', n, Uint8Array);
    coreDil.set(core.subarray(0, n));
    dilateLocal(coreDil, w, h, reach, 'dilA2');

    var count = 0;
    for (var p2 = 0; p2 < n; p2++) {
      mask[p2] = (core[p2] || (dark[p2] && coreDil[p2])) ? 1 : 0;
    }

    if (doEmoji) {
      var emoji = emojiMask(rgba, W, H, b, w, h);
      if (emoji) {
        // Dilatacion amplia a proposito: los emojis son grandes y muy saturados, y
        // su borde difuminado sigue tenido. Si el hueco no llega hasta fondo limpio,
        // la difusion arrastra ese color y queda un halo con la forma del emoji.
        dilateLocal(emoji, w, h, 8, 'dilB');
        for (var p3 = 0; p3 < n; p3++) if (emoji[p3]) mask[p3] = 1;
      }
    }

    dilateLocal(mask, w, h, grow, 'dilC');
    for (var p4 = 0; p4 < n; p4++) if (mask[p4]) count++;

    return { mask: mask, box: b, w: w, h: h, count: count };
  };

  /** Manchas saturadas, compactas y de tamano de glifo => emoji a color. */
  function emojiMask(rgba, W, H, b, w, h) {
    var n = w * h;
    var colorful = scratch('emoA', n, Uint8Array);
    var any = false;
    for (var y = 0; y < h; y++) {
      var srow = (b.y0 + y) * W + b.x0;
      var lrow = y * w;
      for (var x = 0; x < w; x++) {
        var i = (srow + x) * 4;
        var r = rgba[i], g = rgba[i + 1], bl = rgba[i + 2];
        var max = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl);
        var min = r < g ? (r < bl ? r : bl) : (g < bl ? g : bl);
        var sat = max === 0 ? 0 : ((max - min) * 255 / max);
        var on = (sat > 80 && max > 120) ? 1 : 0;
        colorful[lrow + x] = on;
        if (on) any = true;
      }
    }
    if (!any) return null;

    var out = scratch('emoB', n, Uint8Array);
    out.fill(0, 0, n);
    var seen = scratch('emoC', n, Uint8Array);
    seen.fill(0, 0, n);
    var stack = new Int32Array(2048);

    for (var sy = 0; sy < h; sy++) {
      for (var sx = 0; sx < w; sx++) {
        var start = sy * w + sx;
        if (!colorful[start] || seen[start]) continue;
        var sp = 0;
        stack[sp++] = start;
        seen[start] = 1;
        var area = 0, mnX = w, mxX = -1, mnY = h, mxY = -1;
        while (sp > 0) {
          var cur = stack[--sp];
          var cy = (cur / w) | 0, cx = cur - cy * w;
          area++;
          if (cx < mnX) mnX = cx;
          if (cx > mxX) mxX = cx;
          if (cy < mnY) mnY = cy;
          if (cy > mxY) mxY = cy;
          for (var dy = -1; dy <= 1; dy++) {
            var ny = cy + dy;
            if (ny < 0 || ny >= h) continue;
            for (var dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              var nx = cx + dx;
              if (nx < 0 || nx >= w) continue;
              var np = ny * w + nx;
              if (colorful[np] && !seen[np]) {
                seen[np] = 1;
                if (sp >= stack.length) {
                  var bigger = new Int32Array(stack.length * 2);
                  bigger.set(stack);
                  stack = bigger;
                }
                stack[sp++] = np;
              }
            }
          }
        }
        var cw = mxX - mnX + 1, ch = mxY - mnY + 1;
        if (area > 150 && cw > 12 && ch > 12 && area / (cw * ch) > 0.3) {
          for (var ey = mnY; ey <= mxY; ey++) {
            for (var ex = mnX; ex <= mxX; ex++) out[ey * w + ex] = 1;
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- inpainting
  //
  // El relleno lo hace telea.js (Fast Marching Method). Se probo tambien una
  // difusion armonica con multigrid: es mas rapida, pero solo promedia, y el parche
  // se nota como una mancha borrosa. Telea extrapola siguiendo el frente, asi que
  // prolonga las lineas y la textura del fondo dentro del hueco.

  /**
   * Mascara de caja completa, para elementos OPACOS (recuadros de comentario,
   * stickers, etiquetas, marcas de agua).
   *
   * Con estos no sirve buscar glifos: el fondo del recuadro tapa la imagen igual que
   * el texto, y ademas suele ser claro con letras oscuras — justo al reves que un
   * subtitulo. No hay nada que "detectar" dentro: lo que hay que quitar es el
   * rectangulo entero.
   */
  SR.buildBoxMask = function (W, H, box) {
    var b = clampBox(box, W, H);
    var w = b.x1 - b.x0, h = b.y1 - b.y0, n = w * h;
    var mask = new Uint8Array(n);
    mask.fill(1);
    return { mask: mask, box: b, w: w, h: h, count: n };
  };

  /** Construye la mascara y rellena, en un paso. */
  SR.cleanRegion = function (rgba, W, H, box, opts) {
    var o = opts || {};
    var built = SR.buildMask(rgba, W, H, box, o);
    return SR.inpaintTelea(rgba, W, H, built, o.radius);
  };

  if (typeof module === 'object' && module.exports) module.exports = SR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
