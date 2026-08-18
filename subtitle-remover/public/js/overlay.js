/*
 * overlay.js — dibujo de los subtitulos nuevos sobre el canvas.
 *
 * Dos estilos:
 *
 *   'outline' — blanco con contorno negro, sin fondo. El tipico de TikTok/Reels.
 *               Va sobre el fondo ya reconstruido.
 *
 *   'boxed'   — texto sobre una caja de color, una por linea. Este NO necesita
 *               reconstruir nada: la caja TAPA el subtitulo original. Sale mejor
 *               en fondos con estructura, donde rellenar deja una mancha lisa.
 *
 * En 'boxed' la cobertura no se deja al azar: ademas de las cajas por linea se
 * pinta una caja base sobre la zona del subtitulo viejo, asi que aunque la
 * traduccion sea mas corta o mas estrecha no asoma nada por debajo.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var Overlay = (SR.Overlay = {});

  var FALLBACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

  Overlay.fontStack = function (family) {
    if (!family || family === 'system') return FALLBACK;
    return '"' + family + '", ' + FALLBACK;
  };

  /**
   * Las fuentes web se cargan cuando el navegador las necesita para PINTAR. Un
   * canvas no cuenta como pintar, asi que hay que pedirlas a mano o el primer
   * fotograma sale con la tipografia de reserva.
   */
  Overlay.ensureFont = function (family, sizes) {
    if (!family || family === 'system' || !root.document || !document.fonts) {
      return Promise.resolve(false);
    }
    var weights = ['400', '600', '700'];
    var px = sizes || [40];
    var jobs = [];
    weights.forEach(function (w) {
      px.forEach(function (s) {
        jobs.push(document.fonts.load(w + ' ' + Math.round(s) + 'px "' + family + '"'));
      });
    });
    return Promise.all(jobs)
      .then(function () { return document.fonts.ready; })
      .then(function () { return document.fonts.check('700 40px "' + family + '"'); })
      .catch(function () { return false; });
  };

  /** Parte el texto en lineas que entren en maxWidth. Respeta los saltos manuales. */
  Overlay.wrap = function (ctx, text, maxWidth) {
    var out = [];
    var paragraphs = String(text).split('\n');
    for (var p = 0; p < paragraphs.length; p++) {
      var words = paragraphs[p].split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      var line = words[0];
      for (var i = 1; i < words.length; i++) {
        var test = line + ' ' + words[i];
        if (ctx.measureText(test).width <= maxWidth) line = test;
        else { out.push(line); line = words[i]; }
      }
      out.push(line);
    }
    return out;
  };

  function roundRect(ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.fill();
  }

  /** Negro o blanco segun lo claro que sea el fondo, para que siempre se lea. */
  Overlay.autoTextColor = function (bg) {
    var hex = String(bg == null ? '' : bg).trim().replace(/^#/, '');
    var r = 255, g = 255, b = 255;
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      var v = parseInt(hex, 16);
      r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255;
    } else if (/^[0-9a-f]{3}$/i.test(hex)) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    }
    var luma = (r * 77 + g * 150 + b * 29) >> 8;
    return luma > 150 ? '#111111' : '#FFFFFF';
  };

  /**
   * Dibuja un subtitulo.
   * @param style {
   *   boxed, fontFamily, fontSize, position:'top'|'bottom', marginV,
   *   color, outline, outlineRatio, maxWidthRatio, lineHeight,
   *   bgColor, radius, padX, padY, coverBox
   * }
   */
  Overlay.draw = function (ctx, text, W, H, style) {
    if (!text) return;
    var s = style || {};
    var boxed = !!s.boxed;
    var fontSize = s.fontSize || Math.round(W * (boxed ? 0.062 : 0.073));
    var lineHeight = s.lineHeight || (boxed ? 1.34 : 1.22);
    var maxWidth = W * (s.maxWidthRatio || (boxed ? 0.82 : 0.86));

    ctx.save();
    ctx.font = '700 ' + fontSize + 'px ' + Overlay.fontStack(s.fontFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    var lines = Overlay.wrap(ctx, text, maxWidth);
    if (!lines.length) { ctx.restore(); return; }

    var step = fontSize * lineHeight;
    var blockHeight = step * lines.length;
    var cx = W / 2;

    // ------------------------------------------------------ colocacion vertical
    var firstBaseline;
    var box = boxed ? s.coverBox : null;
    if (box) {
      // Centrado sobre el subtitulo original: asi la traduccion queda donde estaba
      // el texto viejo y la caja lo tapa.
      var centerY = (box.y0 + box.y1) / 2;
      var top = centerY - blockHeight / 2;
      top = Math.max(4, Math.min(H - blockHeight - 4, top));
      firstBaseline = top + fontSize;
    } else {
      var marginV = s.marginV == null ? Math.round(H * 0.14) : s.marginV;
      firstBaseline = s.position === 'top'
        ? marginV + fontSize
        : H - marginV - blockHeight + fontSize;
    }

    if (boxed) {
      var padX = s.padX == null ? Math.round(fontSize * 0.42) : s.padX;
      var padY = s.padY == null ? Math.round(fontSize * 0.20) : s.padY;
      var radius = s.radius == null ? Math.round(fontSize * 0.22) : s.radius;
      ctx.fillStyle = s.bgColor || '#FFFFFF';

      // caja base: garantiza que no asome el subtitulo original por ningun lado
      if (box) {
        var bx = box.x0 - 2, by = box.y0 - 2;
        roundRect(ctx, bx, by, (box.x1 - box.x0) + 4, (box.y1 - box.y0) + 4, radius);
      }

      // Una caja por linea, como en los editores de movil. Se dimensiona desde la
      // linea base con las proporciones tipicas de ascendentes y descendentes, no
      // desde el interlineado: si no, las cajas se pisan o dejan huecos.
      var above = fontSize * 0.82, below = fontSize * 0.24;
      for (var i = 0; i < lines.length; i++) {
        var by = firstBaseline + i * step;
        var lw = ctx.measureText(lines[i]).width + padX * 2;
        var lh = above + below + padY * 2;
        roundRect(ctx, cx - lw / 2, by - above - padY, lw, lh, radius);
      }

      ctx.fillStyle = s.color || Overlay.autoTextColor(s.bgColor || '#FFFFFF');
      for (var j = 0; j < lines.length; j++) {
        ctx.fillText(lines[j], cx, firstBaseline + j * step);
      }
    } else {
      ctx.strokeStyle = s.outline || '#000000';
      ctx.fillStyle = s.color || '#FFFFFF';
      ctx.lineWidth = Math.max(2, fontSize * (s.outlineRatio || 0.16));
      for (var k = 0; k < lines.length; k++) {
        var y = firstBaseline + k * step;
        ctx.strokeText(lines[k], cx, y);
        ctx.fillText(lines[k], cx, y);
      }
    }

    ctx.restore();
  };

  /** Alto aproximado del bloque, para previsualizar sin dibujar. */
  Overlay.measure = function (ctx, text, W, style) {
    var s = style || {};
    var boxed = !!s.boxed;
    var fontSize = s.fontSize || Math.round(W * (boxed ? 0.062 : 0.073));
    ctx.save();
    ctx.font = '700 ' + fontSize + 'px ' + Overlay.fontStack(s.fontFamily);
    var lines = Overlay.wrap(ctx, text, W * (s.maxWidthRatio || (boxed ? 0.82 : 0.86)));
    ctx.restore();
    return { lines: lines, height: lines.length * fontSize * (s.lineHeight || (boxed ? 1.34 : 1.22)) };
  };

  if (typeof module === 'object' && module.exports) module.exports = Overlay;
})(typeof globalThis !== 'undefined' ? globalThis : this);
