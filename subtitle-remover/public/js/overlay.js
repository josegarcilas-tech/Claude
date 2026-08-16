/*
 * overlay.js — dibujo de los subtitulos nuevos sobre el canvas.
 * Replica el estilo tipico de TikTok/Reels: sans bold, blanco con contorno negro.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var Overlay = (SR.Overlay = {});

  var FONT_STACK = '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif';

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

  /**
   * Dibuja un subtitulo.
   * @param style {fontSize, position:'top'|'bottom', marginV, color, outline, lineHeight}
   */
  Overlay.draw = function (ctx, text, W, H, style) {
    if (!text) return;
    var s = style || {};
    var fontSize = s.fontSize || Math.round(W * 0.073);
    var marginV = s.marginV == null ? Math.round(H * 0.14) : s.marginV;
    var lineHeight = s.lineHeight || 1.22;
    var maxWidth = W * (s.maxWidthRatio || 0.86);

    ctx.save();
    ctx.font = '700 ' + fontSize + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    var lines = Overlay.wrap(ctx, text, maxWidth);
    if (!lines.length) { ctx.restore(); return; }

    var step = fontSize * lineHeight;
    var blockHeight = step * lines.length;

    // y del baseline de la primera linea
    var firstBaseline;
    if (s.position === 'top') {
      firstBaseline = marginV + fontSize;
    } else {
      firstBaseline = H - marginV - blockHeight + fontSize;
    }

    var cx = W / 2;
    ctx.strokeStyle = s.outline || '#000000';
    ctx.fillStyle = s.color || '#FFFFFF';
    ctx.lineWidth = Math.max(2, fontSize * (s.outlineRatio || 0.16));

    for (var i = 0; i < lines.length; i++) {
      var y = firstBaseline + i * step;
      ctx.strokeText(lines[i], cx, y);
      ctx.fillText(lines[i], cx, y);
    }
    ctx.restore();
  };

  /** Alto aproximado del bloque, para previsualizar sin dibujar. */
  Overlay.measure = function (ctx, text, W, style) {
    var s = style || {};
    var fontSize = s.fontSize || Math.round(W * 0.073);
    ctx.save();
    ctx.font = '700 ' + fontSize + 'px ' + FONT_STACK;
    var lines = Overlay.wrap(ctx, text, W * (s.maxWidthRatio || 0.86));
    ctx.restore();
    return { lines: lines, height: lines.length * fontSize * (s.lineHeight || 1.22) };
  };

  if (typeof module === 'object' && module.exports) module.exports = Overlay;
})(typeof globalThis !== 'undefined' ? globalThis : this);
