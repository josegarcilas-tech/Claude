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
 *   3. relleno: piramide push-pull (color base) + relajacion de Laplace restringida
 *      a la mascara (difusion suave desde el borde conocido).
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
    iterations: 60,       // pasadas de difusion (mas alla de ~60 ya no se nota)
    margin: 24,           // borde conocido alrededor del hueco
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

  /**
   * Rellena los pixeles marcados difundiendo el color del entorno. Modifica rgba in place.
   * @param built resultado de SR.buildMask
   */
  SR.inpaint = function (rgba, W, H, built, opts) {
    var o = opts || {};
    var iterations = o.iterations == null ? DEFAULTS.iterations : o.iterations;
    var margin = o.margin == null ? DEFAULTS.margin : o.margin;
    if (!built || !built.count) return false;

    var b = built.box, mw = built.w, mask = built.mask;

    // rect de trabajo = caja de la mascara + margen conocido (condicion de contorno)
    var x0 = Math.max(0, b.x0 - margin), x1 = Math.min(W, b.x1 + margin);
    var y0 = Math.max(0, b.y0 - margin), y1 = Math.min(H, b.y1 + margin);
    var w = x1 - x0, h = y1 - y0, n = w * h;

    var col = scratch('col', n * 3, Float32Array);
    var known = scratch('known', n, Uint8Array);

    for (var ly = 0; ly < h; ly++) {
      var gy = y0 + ly;
      var lrow = ly * w;
      var grow_ = gy * W;
      var inMaskRow = (gy >= b.y0 && gy < b.y1);
      var mrow = inMaskRow ? (gy - b.y0) * mw - b.x0 : 0;
      for (var lx = 0; lx < w; lx++) {
        var gx = x0 + lx;
        var lp = lrow + lx;
        var gi = (grow_ + gx) * 4;
        col[lp * 3] = rgba[gi];
        col[lp * 3 + 1] = rgba[gi + 1];
        col[lp * 3 + 2] = rgba[gi + 2];
        var masked = (inMaskRow && gx >= b.x0 && gx < b.x1) ? mask[mrow + gx] : 0;
        known[lp] = masked ? 0 : 1;
      }
    }

    solveHarmonic(col, known, w, h, iterations);

    for (var ry = 0; ry < h; ry++) {
      var ry_g = y0 + ry;
      if (ry_g < b.y0 || ry_g >= b.y1) continue; // fuera de la mascara: nada que escribir
      var rrow = ry * w;
      for (var rx = 0; rx < w; rx++) {
        var rp = rrow + rx;
        if (known[rp]) continue;
        var gi2 = (ry_g * W + (x0 + rx)) * 4;
        rgba[gi2] = col[rp * 3];
        rgba[gi2 + 1] = col[rp * 3 + 1];
        rgba[gi2 + 2] = col[rp * 3 + 2];
      }
    }
    return true;
  };

  /**
   * Resuelve el relleno como un problema de Laplace, con multigrid en cascada.
   *
   * Gauss-Seidel a secas necesita del orden de n^2 pasadas para atravesar un hueco
   * de n pixeles de ancho. Una banda de subtitulo puede tener 400x100, asi que con
   * unas decenas de pasadas el centro se queda con el color de la inicializacion
   * (se notaba como un halo con la forma del texto o del emoji).
   *
   * Con multigrid se resuelve primero en los niveles chicos —donde el hueco mide
   * pocos pixeles y converge enseguida— y se va bajando el resultado. Cada nivel
   * arranca de una solucion ya casi correcta.
   */
  function solveHarmonic(col, known, w, h, iterations) {
    var levels = [{ col: col, known: known, w: w, h: h }];
    var cur = levels[0];
    var cw = w, ch = h;

    while (cw > 2 && ch > 2) {
      var nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2);
      var ncol = new Float32Array(nw * nh * 3);
      var nknown = new Uint8Array(nw * nh);
      for (var y = 0; y < nh; y++) {
        for (var x = 0; x < nw; x++) {
          var r = 0, g = 0, b = 0, cnt = 0;
          for (var dy = 0; dy < 2; dy++) {
            var sy = y * 2 + dy;
            if (sy >= ch) continue;
            for (var dx = 0; dx < 2; dx++) {
              var sx = x * 2 + dx;
              if (sx >= cw) continue;
              var sp = sy * cw + sx;
              if (!cur.known[sp]) continue;
              r += cur.col[sp * 3]; g += cur.col[sp * 3 + 1]; b += cur.col[sp * 3 + 2];
              cnt++;
            }
          }
          var np = y * nw + x;
          if (cnt) {
            ncol[np * 3] = r / cnt; ncol[np * 3 + 1] = g / cnt; ncol[np * 3 + 2] = b / cnt;
            nknown[np] = 1;
          }
        }
      }
      cur = { col: ncol, known: nknown, w: nw, h: nh };
      levels.push(cur);
      cw = nw; ch = nh;
    }

    // El nivel mas grueso se resuelve casi exacto: es diminuto, sale barato.
    var top = levels[levels.length - 1];
    relax(top.col, top.known, top.w, top.h, 40);

    for (var l = levels.length - 2; l >= 0; l--) {
      var fine = levels[l], coarse = levels[l + 1];
      for (var fy = 0; fy < fine.h; fy++) {
        for (var fx = 0; fx < fine.w; fx++) {
          var fp = fy * fine.w + fx;
          if (fine.known[fp]) continue;
          var cp = (fy >> 1) * coarse.w + (fx >> 1);
          fine.col[fp * 3] = coarse.col[cp * 3];
          fine.col[fp * 3 + 1] = coarse.col[cp * 3 + 1];
          fine.col[fp * 3 + 2] = coarse.col[cp * 3 + 2];
        }
      }
      // suavizado en cada nivel; el mas fino se lleva el presupuesto del usuario
      relax(fine.col, fine.known, fine.w, fine.h, l === 0 ? iterations : 24);
    }
  }

  /**
   * Relajacion de Laplace (Gauss-Seidel) sobre los huecos.
   * Los vecinos se recortan al borde, asi que los huecos pegados al borde tambien
   * se resuelven: en los niveles gruesos de la piramide el margen conocido casi
   * desaparece y saltarselos dejaba pixeles en negro que luego bajaban al resultado.
   */
  function relax(col, known, w, h, iterations) {
    var holes = [];
    var neigh = [];
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var p = row + x;
        if (known[p]) continue;
        holes.push(p);
        neigh.push(
          (y > 0 ? p - w : p + (h > 1 ? w : 0)),
          (y < h - 1 ? p + w : p - (h > 1 ? w : 0)),
          (x > 0 ? p - 1 : p + (w > 1 ? 1 : 0)),
          (x < w - 1 ? p + 1 : p - (w > 1 ? 1 : 0))
        );
      }
    }
    if (!holes.length) return;
    var idx = Int32Array.from(holes);
    var nb = Int32Array.from(neigh);
    var len = idx.length;

    for (var it = 0; it < iterations; it++) {
      for (var k = 0; k < len; k++) {
        var o = idx[k] * 3;
        var k4 = k * 4;
        var a = nb[k4] * 3, b = nb[k4 + 1] * 3, c = nb[k4 + 2] * 3, d = nb[k4 + 3] * 3;
        col[o] = (col[a] + col[b] + col[c] + col[d]) * 0.25;
        col[o + 1] = (col[a + 1] + col[b + 1] + col[c + 1] + col[d + 1]) * 0.25;
        col[o + 2] = (col[a + 2] + col[b + 2] + col[c + 2] + col[d + 2]) * 0.25;
      }
    }
  }

  /** Conveniencia: construye la mascara y rellena, en un paso. */
  SR.cleanRegion = function (rgba, W, H, box, opts) {
    var built = SR.buildMask(rgba, W, H, box, opts);
    return SR.inpaint(rgba, W, H, built, opts);
  };

  if (typeof module === 'object' && module.exports) module.exports = SR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
