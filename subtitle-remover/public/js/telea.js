/*
 * telea.js — inpainting por Fast Marching Method (Telea, 2004).
 *
 * Port fiel del algoritmo de OpenCV (`cv::inpaint` con INPAINT_TELEA), el mismo que
 * se uso en la primera version hecha a mano. A diferencia de una difusion suave, aqui
 * cada pixel se reconstruye extrapolando desde sus vecinos conocidos con un peso que
 * favorece la direccion del frente: eso propaga la estructura del fondo (las lineas,
 * los pliegues de la tela) en vez de limitarse a promediar, y por eso el parche se
 * confunde mucho mejor con la imagen.
 *
 * Se trabaja sobre un sub-rectangulo con borde de 1 pixel, igual que OpenCV, y con
 * indices "padded": el pixel de imagen (x,y) vive en (y+1, x+1).
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});

  var KNOWN = 0, BAND = 1, INSIDE = 2, CHANGE = 3;
  var INF = 1.0e6;

  // ------------------------------------------------------------- cola de prioridad
  // Min-heap por T; a igual T respeta el orden de insercion, como el de OpenCV.
  function Heap(capacity) {
    this.t = new Float32Array(capacity);
    this.ord = new Int32Array(capacity);
    this.pos = new Int32Array(capacity);
    this.n = 0;
    this.next = 0;
    this.cap = capacity;
  }
  Heap.prototype._grow = function () {
    var cap = this.cap * 2;
    var t = new Float32Array(cap); t.set(this.t);
    var o = new Int32Array(cap); o.set(this.ord);
    var p = new Int32Array(cap); p.set(this.pos);
    this.t = t; this.ord = o; this.pos = p; this.cap = cap;
  };
  Heap.prototype._less = function (a, b) {
    if (this.t[a] !== this.t[b]) return this.t[a] < this.t[b];
    return this.ord[a] < this.ord[b];
  };
  Heap.prototype._swap = function (a, b) {
    var tt = this.t[a]; this.t[a] = this.t[b]; this.t[b] = tt;
    var oo = this.ord[a]; this.ord[a] = this.ord[b]; this.ord[b] = oo;
    var pp = this.pos[a]; this.pos[a] = this.pos[b]; this.pos[b] = pp;
  };
  Heap.prototype.push = function (p, t) {
    if (this.n >= this.cap) this._grow();
    var i = this.n++;
    this.t[i] = t; this.pos[i] = p; this.ord[i] = this.next++;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (this._less(i, parent)) { this._swap(i, parent); i = parent; } else break;
    }
  };
  Heap.prototype.pop = function () {
    if (this.n === 0) return -1;
    var top = this.pos[0];
    this.n--;
    if (this.n > 0) {
      this.t[0] = this.t[this.n]; this.ord[0] = this.ord[this.n]; this.pos[0] = this.pos[this.n];
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < this.n && this._less(l, m)) m = l;
        if (r < this.n && this._less(r, m)) m = r;
        if (m === i) break;
        this._swap(i, m);
        i = m;
      }
    }
    return top;
  };

  // ------------------------------------------------------------------ eikonal
  /** Resuelve |grad T| = 1 en un pixel a partir de dos vecinos. */
  function solveEikonal(p1, p2, f, t) {
    var a11 = t[p1], a22 = t[p2], m12 = a11 < a22 ? a11 : a22;
    var sol;
    if (f[p1] !== INSIDE) {
      if (f[p2] !== INSIDE) {
        var d = a11 - a22;
        if (Math.abs(d) >= 1.0) sol = 1 + m12;
        else sol = (a11 + a22 + Math.sqrt(2 - d * d)) * 0.5;
      } else sol = 1 + a11;
    } else if (f[p2] !== INSIDE) {
      sol = 1 + a22;
    } else {
      sol = 1 + m12;
    }
    return sol;
  }

  function min4(a, b, c, d) {
    var m = a;
    if (b < m) m = b;
    if (c < m) m = c;
    if (d < m) m = d;
    return m;
  }

  /** Marcha rapida para rellenar T; con negate calcula el campo EXTERIOR (T negativo). */
  function calcFMM(f, t, heap, pw, ph, negate) {
    var known = negate ? CHANGE : KNOWN;
    var p;
    while ((p = heap.pop()) !== -1) {
      f[p] = known;
      for (var q = 0; q < 4; q++) {
        var n = q === 0 ? p - pw : q === 1 ? p - 1 : q === 2 ? p + pw : p + 1;
        var ni = (n / pw) | 0, nj = n - ni * pw;
        if (ni <= 0 || nj <= 0 || ni >= ph - 1 || nj >= pw - 1) continue;
        if (f[n] !== INSIDE) continue;
        var dist = min4(
          solveEikonal(n - pw, n - 1, f, t),
          solveEikonal(n + pw, n - 1, f, t),
          solveEikonal(n - pw, n + 1, f, t),
          solveEikonal(n + pw, n + 1, f, t)
        );
        t[n] = dist;
        f[n] = BAND;
        heap.push(n, dist);
      }
    }
    if (negate) {
      for (var i = 0; i < f.length; i++) {
        if (f[i] === CHANGE) { f[i] = KNOWN; t[i] = -t[i]; }
      }
    }
  }

  /** Dilatacion binaria con elemento en cruz 3x3 (el que usa OpenCV para la banda). */
  function dilateCross(src, dst, pw, ph) {
    for (var y = 1; y < ph - 1; y++) {
      for (var x = 1; x < pw - 1; x++) {
        var p = y * pw + x;
        dst[p] = (src[p] || src[p - 1] || src[p + 1] || src[p - pw] || src[p + pw]) ? INSIDE : 0;
      }
    }
  }

  /** Dilatacion binaria con elemento rectangular (2r+1)^2, separable. */
  function dilateRect(src, dst, pw, ph, r, tmp) {
    var x, y, k;
    for (y = 0; y < ph; y++) {
      for (x = 0; x < pw; x++) {
        var v = 0;
        var a = x - r; if (a < 0) a = 0;
        var b = x + r; if (b > pw - 1) b = pw - 1;
        for (k = a; k <= b; k++) if (src[y * pw + k]) { v = INSIDE; break; }
        tmp[y * pw + x] = v;
      }
    }
    for (y = 0; y < ph; y++) {
      for (x = 0; x < pw; x++) {
        var v2 = 0;
        var a2 = y - r; if (a2 < 0) a2 = 0;
        var b2 = y + r; if (b2 > ph - 1) b2 = ph - 1;
        for (k = a2; k <= b2; k++) if (tmp[k * pw + x]) { v2 = INSIDE; break; }
        dst[y * pw + x] = v2;
      }
    }
  }

  /**
   * Rellena la mascara sobre `rgba` (in place) usando Telea.
   *
   * @param built resultado de SR.buildMask (mascara local + caja)
   * @param radius radio de vecindad (el `inpaintRadius` de OpenCV; 4 por defecto)
   * @returns {boolean} true si se modifico algo
   */
  SR.inpaintTelea = function (rgba, W, H, built, radius) {
    if (!built || !built.count) return false;
    var range = Math.max(1, Math.min(100, Math.round(radius || 4)));

    var b = built.box, mw = built.w, mask = built.mask;

    // rectangulo de trabajo: la mascara mas margen suficiente para el campo exterior
    var margin = range + 3;
    var x0 = Math.max(0, b.x0 - margin), x1 = Math.min(W, b.x1 + margin);
    var y0 = Math.max(0, b.y0 - margin), y1 = Math.min(H, b.y1 + margin);
    var w = x1 - x0, h = y1 - y0;
    var pw = w + 2, ph = h + 2, np = pw * ph;

    var maskA = new Uint8Array(np);
    var t = new Float32Array(np);
    var band = new Uint8Array(np);
    var outer = new Uint8Array(np);
    var tmp = new Uint8Array(np);
    // imagen en coordenadas padded: img[(y+1)*pw + (x+1)] <-> pixel (x0+x, y0+y)
    var img = new Float32Array(np * 3);

    var x, y, p, gi;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        p = (y + 1) * pw + (x + 1);
        gi = ((y0 + y) * W + (x0 + x)) * 4;
        img[p * 3] = rgba[gi];
        img[p * 3 + 1] = rgba[gi + 1];
        img[p * 3 + 2] = rgba[gi + 2];
        var gx = x0 + x, gy = y0 + y;
        var inMask = (gx >= b.x0 && gx < b.x1 && gy >= b.y0 && gy < b.y1)
          ? mask[(gy - b.y0) * mw + (gx - b.x0)] : 0;
        maskA[p] = inMask ? INSIDE : KNOWN;
      }
    }

    t.fill(INF);

    // banda inicial = dilatacion en cruz de la mascara, menos la mascara
    dilateCross(maskA, band, pw, ph);
    for (p = 0; p < np; p++) if (maskA[p]) band[p] = 0;

    var heap = new Heap(Math.max(64, built.count));
    var outHeap = new Heap(Math.max(64, built.count));
    for (y = 1; y < ph - 1; y++) {
      for (x = 1; x < pw - 1; x++) {
        p = y * pw + x;
        if (!band[p]) continue;
        t[p] = 0;
        heap.push(p, 0);
        outHeap.push(p, 0);
      }
    }
    if (heap.n === 0) return false;

    // campo exterior: T negativo hasta `range` pixeles fuera de la mascara
    dilateRect(maskA, outer, pw, ph, range, tmp);
    for (p = 0; p < np; p++) {
      if (maskA[p] || band[p]) outer[p] = 0;
    }
    for (y = 0; y < ph; y++) {
      outer[y * pw] = 0; outer[y * pw + pw - 1] = 0;
    }
    for (x = 0; x < pw; x++) {
      outer[x] = 0; outer[(ph - 1) * pw + x] = 0;
    }
    calcFMM(outer, t, outHeap, pw, ph, true);

    teleaMarch(maskA, t, img, heap, pw, ph, range);

    // volcamos solo los pixeles reconstruidos
    for (y = 0; y < h; y++) {
      var gy2 = y0 + y;
      if (gy2 < b.y0 || gy2 >= b.y1) continue;
      for (x = 0; x < w; x++) {
        var gx2 = x0 + x;
        if (gx2 < b.x0 || gx2 >= b.x1) continue;
        if (!mask[(gy2 - b.y0) * mw + (gx2 - b.x0)]) continue;
        p = (y + 1) * pw + (x + 1);
        gi = (gy2 * W + gx2) * 4;
        rgba[gi] = img[p * 3];
        rgba[gi + 1] = img[p * 3 + 1];
        rgba[gi + 2] = img[p * 3 + 2];
      }
    }
    return true;
  };

  /** Marcha principal: por cada pixel del frente, extrapola color y avanza. */
  function teleaMarch(f, t, img, heap, pw, ph, range) {
    var r2 = range * range;
    var pp;
    while ((pp = heap.pop()) !== -1) {
      f[pp] = KNOWN;
      for (var q = 0; q < 4; q++) {
        var p = q === 0 ? pp - pw : q === 1 ? pp - 1 : q === 2 ? pp + pw : pp + 1;
        var i = (p / pw) | 0, j = p - i * pw;
        if (i <= 0 || j <= 0 || i >= ph - 1 || j >= pw - 1) continue;
        if (f[p] !== INSIDE) continue;

        var dist = min4(
          solveEikonal(p - pw, p - 1, f, t),
          solveEikonal(p + pw, p - 1, f, t),
          solveEikonal(p - pw, p + 1, f, t),
          solveEikonal(p + pw, p + 1, f, t)
        );
        t[p] = dist;

        // gradiente de T en p (diferencias centradas donde se puede)
        var gTx, gTy;
        if (f[p + 1] !== INSIDE) {
          gTx = (f[p - 1] !== INSIDE) ? (t[p + 1] - t[p - 1]) * 0.5 : (t[p + 1] - t[p]);
        } else {
          gTx = (f[p - 1] !== INSIDE) ? (t[p] - t[p - 1]) : 0;
        }
        if (f[p + pw] !== INSIDE) {
          gTy = (f[p - pw] !== INSIDE) ? (t[p + pw] - t[p - pw]) * 0.5 : (t[p + pw] - t[p]);
        } else {
          gTy = (f[p - pw] !== INSIDE) ? (t[p] - t[p - pw]) : 0;
        }

        var Ia0 = 0, Ia1 = 0, Ia2 = 0;
        var Jx0 = 0, Jx1 = 0, Jx2 = 0;
        var Jy0 = 0, Jy1 = 0, Jy2 = 0;
        var s0 = 1e-20, s1 = 1e-20, s2 = 1e-20;

        var kFrom = i - range, kTo = i + range;
        var lFrom = j - range, lTo = j + range;

        for (var k = kFrom; k <= kTo; k++) {
          if (k <= 0 || k >= ph - 1) continue;
          // clamps de OpenCV para no salirse al calcular el gradiente de la imagen
          var km = k - 1 + (k === 1 ? 1 : 0);
          var kp = k - 1 - (k === ph - 2 ? 1 : 0);
          for (var l = lFrom; l <= lTo; l++) {
            if (l <= 0 || l >= pw - 1) continue;
            var pk = k * pw + l;
            if (f[pk] === INSIDE) continue;
            var ry = i - k, rx = j - l;
            var len = rx * rx + ry * ry;
            if (len > r2) continue;

            var lm = l - 1 + (l === 1 ? 1 : 0);
            var lp = l - 1 - (l === pw - 2 ? 1 : 0);

            var dst = 1 / (len * Math.sqrt(len));
            var lev = 1 / (1 + Math.abs(t[pk] - t[p]));
            var dir = rx * gTx + ry * gTy;
            if (Math.abs(dir) <= 0.01) dir = 0.000001;
            var wgt = Math.abs(dst * lev * dir);

            // gradiente de la imagen en (k,l), en coordenadas padded desplazadas
            var cxA = f[pk + 1] !== INSIDE, cxB = f[pk - 1] !== INSIDE;
            var cyA = f[pk + pw] !== INSIDE, cyB = f[pk - pw] !== INSIDE;

            var base = ((km + 1) * pw + (lp + 1 + 1)) * 3;   // out(km, lp+1)
            var baseM1 = ((km + 1) * pw + (lm - 1 + 1)) * 3; // out(km, lm-1)
            var baseL = ((km + 1) * pw + (lp + 1)) * 3;      // out(km, lp)
            var baseLm = ((km + 1) * pw + (lm + 1)) * 3;     // out(km, lm)
            var baseYp = ((kp + 1 + 1) * pw + (lm + 1)) * 3; // out(kp+1, lm)
            var baseYm = ((km - 1 + 1) * pw + (lm + 1)) * 3; // out(km-1, lm)
            var baseYc = ((kp + 1) * pw + (lm + 1)) * 3;     // out(kp, lm)

            var here = pk * 3;
            for (var c = 0; c < 3; c++) {
              var gIx, gIy;
              if (cxA) {
                gIx = cxB ? (img[base + c] - img[baseM1 + c]) * 2 : (img[base + c] - img[baseLm + c]);
              } else {
                gIx = cxB ? (img[baseL + c] - img[baseM1 + c]) : 0;
              }
              if (cyA) {
                gIy = cyB ? (img[baseYp + c] - img[baseYm + c]) * 2 : (img[baseYp + c] - img[baseLm + c]);
              } else {
                gIy = cyB ? (img[baseYc + c] - img[baseYm + c]) : 0;
              }
              var iv = img[here + c];
              if (c === 0) { Ia0 += wgt * iv; Jx0 -= wgt * gIx * rx; Jy0 -= wgt * gIy * ry; s0 += wgt; }
              else if (c === 1) { Ia1 += wgt * iv; Jx1 -= wgt * gIx * rx; Jy1 -= wgt * gIy * ry; s1 += wgt; }
              else { Ia2 += wgt * iv; Jx2 -= wgt * gIx * rx; Jy2 -= wgt * gIy * ry; s2 += wgt; }
            }
          }
        }

        var o = p * 3;
        img[o] = sat(Ia0 / s0 + (Jx0 + Jy0) / (Math.sqrt(Jx0 * Jx0 + Jy0 * Jy0) + 1e-20));
        img[o + 1] = sat(Ia1 / s1 + (Jx1 + Jy1) / (Math.sqrt(Jx1 * Jx1 + Jy1 * Jy1) + 1e-20));
        img[o + 2] = sat(Ia2 / s2 + (Jx2 + Jy2) / (Math.sqrt(Jx2 * Jx2 + Jy2 * Jy2) + 1e-20));

        f[p] = BAND;
        heap.push(p, dist);
      }
    }
  }

  function sat(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  if (typeof module === 'object' && module.exports) module.exports = SR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
