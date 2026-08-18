/* ============================================================
   Doblaje — subtítulos en español y voz pegada, por lote
   Todo el procesamiento de video ocurre en el navegador.
   ============================================================ */

const $ = (id) => document.getElementById(id);
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/* ---------------- estado ---------------- */

const state = {
  clips: [],
  sel: -1,
  style: {
    family: 'Montserrat',
    weight: '800',
    caseMode: 'none',
    size: 4.2,      // % del alto
    strokeW: 18,    // % del tamaño de letra
    fill: '#ffffff',
    stroke: '#000000',
    y: 16,          // % del alto (borde superior del bloque)
    maxW: 86        // % del ancho
  },
  cover: { on: true, mode: 'box', color: '#120a26', strength: 9, y: 14, h: 12, zones: null, boxOpacity: 95, boxRadius: 22, boxMinW: 72 },
  audio: { mode: 'keep', mute: false, musicVol: 28, voiceDelay: 0.5 },
  logo: { on: false, file: null, img: null, opacity: 70, size: 16, margin: 4, pos: 'br' },
  exportLado: 1280,   // tope del lado largo al exportar; 0 = tal cual el original
  zip: true
};

let ffmpeg = null;
let ffmpegReady = false;
let busy = false;
let ultimoFpsExport = 0;   // cuadros por segundo logrados en la última exportación

/**
 * iOS solo deja arrancar el audio dentro del toque del usuario.
 * Si se intenta después, resume() se queda colgado para siempre.
 * Por eso el contexto se crea y se despierta apenas tocan un botón.
 */
let audioCtx = null;

function conLimiteDeTiempo(promesa, ms, mensaje) {
  let t;
  return Promise.race([
    promesa.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(mensaje)), ms); })
  ]);
}

function despertarAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();   // sin await: en iOS no resuelve fuera del gesto
    // un pitido de cero duración termina de desbloquearlo en Safari
    const s = audioCtx.createBufferSource();
    s.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    s.connect(audioCtx.destination);
    s.start(0);
  } catch (e) { /* si no se puede, el video saldrá mudo */ }
}

/* ---------------- utilidades ---------------- */

function textoDeError(err) {
  if (!err) return '';
  const partes = [];
  if (err.name && err.name !== 'Error') partes.push(err.name);
  if (err.message) partes.push(err.message);
  return partes.join(': ');
}

function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}

function setEngine(label, cls) {
  const el = $('engineState');
  el.textContent = 'Motor: ' + label;
  el.className = 'chip ' + cls;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '_').slice(0, 60);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- carga de archivos ---------------- */

const dropzone = $('dropzone');
const fileInput = $('fileInput');

// la etiqueta ya abre el selector; un click() extra hace que iOS lo cierre al instante
fileInput.addEventListener('change', e => {
  const files = e.target.files;
  if (files && files.length) addFiles(files);
  setTimeout(() => { fileInput.value = ''; }, 0);
});

['dragenter', 'dragover'].forEach(ev =>
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev =>
  dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('hot'); }));
dropzone.addEventListener('drop', e => addFiles(e.dataTransfer.files));

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  if (dropzone.contains(e.target) || $('voiceDrop').contains(e.target)) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});

const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi', '3gp', 'ogv'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic'];

function kindOf(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
}

async function addFiles(list) {
  const all = [...list];
  const files = all.filter(f => kindOf(f));
  if (all.length && !files.length) {
    toast('Ese formato no se reconoce. Usá MP4, MOV, WebM, JPG o PNG.', true);
  }
  if (!files.length) return;
  for (const file of files) {
    try {
      const clip = await buildClip(file);
      state.clips.push(clip);
      if (state.sel < 0) state.sel = 0;
    } catch (err) {
      toast(err && err.message ? `${file.name}: ${err.message}` : `No se pudo leer ${file.name}.`, true);
    }
  }
  renderClipList();
  renderStage();
}

function waitEvent(el, name, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = () => { if (done) return; done = true; cleanup(); resolve(true); };
    const fail = () => { if (done) return; done = true; cleanup(); reject(new Error(name)); };
    const timer = setTimeout(() => { if (done) return; done = true; cleanup(); resolve(false); }, ms);
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener(name, ok);
      el.removeEventListener('error', fail);
    }
    el.addEventListener(name, ok);
    el.addEventListener('error', fail);
  });
}

async function buildClip(file) {
  const url = URL.createObjectURL(file);
  const isVideo = kindOf(file) === 'video';

  if (!isVideo) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    const ok = await waitEvent(img, 'load', 12000);
    if (!ok && !img.naturalWidth) throw new Error('No se pudo abrir la imagen.');
    return {
      file, url, isVideo: false, media: img,
      w: img.naturalWidth, h: img.naturalHeight, dur: 0,
      thumb: grabThumb(img, img.naturalWidth, img.naturalHeight),
      cues: [{ text: '', start: 0, end: 0 }],
      voice: null, time: 0, status: ''
    };
  }

  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('muted', '');
  v.src = url;
  v.load();

  await waitEvent(v, 'loadedmetadata', 15000);

  if (!v.videoWidth || !v.videoHeight) {
    // algunos formatos solo publican las medidas al llegar el primer cuadro
    await waitEvent(v, 'loadeddata', 8000);
  }
  if (!v.videoWidth || !v.videoHeight) {
    throw new Error('Ese video no lo puede abrir el navegador. Probá exportarlo como MP4 (H.264).');
  }

  if (v.readyState < 2) await waitEvent(v, 'loadeddata', 8000);

  const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;

  // primer cuadro para la miniatura; si el navegador no lo entrega, seguimos igual
  try {
    v.currentTime = Math.min(0.1, dur ? dur / 2 : 0.1);
    await waitEvent(v, 'seeked', 4000);
  } catch (e) { /* seguimos sin miniatura */ }

  let thumb = '';
  try { thumb = grabThumb(v, v.videoWidth, v.videoHeight); } catch (e) { thumb = ''; }

  return {
    file, url, isVideo: true, media: v,
    w: v.videoWidth, h: v.videoHeight, dur,
    thumb,
    cues: [{ text: '', start: 0, end: Math.min(3, dur || 3) }],
    voice: null, time: 0, status: ''
  };
}

function grabThumb(media, w, h) {
  if (!w || !h) return '';
  const c = document.createElement('canvas');
  const scale = 120 / Math.max(w, h);
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(media, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

/* ---------------- lista del lote ---------------- */

function renderClipList() {
  const ul = $('clipList');
  ul.innerHTML = '';
  $('batchCount').textContent = state.clips.length;
  const badge = $('tabBadge');
  badge.textContent = state.clips.length;
  badge.hidden = state.clips.length === 0;

  state.clips.forEach((clip, i) => {
    const li = document.createElement('li');
    li.className = 'clip' + (i === state.sel ? ' sel' : '');
    const lines = clip.cues.filter(c => c.text.trim()).length;
    const bits = [clip.isVideo ? `${clip.dur.toFixed(1)}s` : 'imagen', `${lines} línea${lines === 1 ? '' : 's'}`];
    if (clip.voice) bits.push('voz ✓');
    li.innerHTML = `
      <img class="clip-thumb" src="${clip.thumb || BLANK}" alt="">
      <span class="clip-meta">
        <span class="clip-name">${esc(clip.file.name)}</span>
        <span class="clip-sub ${clip.status === 'listo' ? 'ok' : clip.status ? 'work' : ''}">${esc(clip.status || bits.join(' · '))}</span>
      </span>
      <button class="clip-x" type="button" aria-label="Quitar">×</button>`;
    li.addEventListener('click', e => {
      if (e.target.classList.contains('clip-x')) return;
      pausarVista();                     // no seguir reproduciendo el anterior
      state.sel = i; renderClipList(); renderStage();
      if (isPhone()) goTab('texto');
    });
    li.querySelector('.clip-x').addEventListener('click', () => {
      pausarVista();
      URL.revokeObjectURL(clip.url);
      state.clips.splice(i, 1);
      if (state.sel >= state.clips.length) state.sel = state.clips.length - 1;
      renderClipList(); renderStage();
    });
    ul.appendChild(li);
  });
}

$('clearBatch').addEventListener('click', () => {
  pausarVista();
  state.clips.forEach(c => URL.revokeObjectURL(c.url));
  state.clips = []; state.sel = -1;
  renderClipList(); renderStage();
});

/* ---------------- importar desde TikTok ---------------- */

const urlForm = $('urlForm');
const urlInput = $('urlInput');
const urlSubmit = $('urlSubmit');

function proxiedDownload(url, filename) {
  return `/dl?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
}

urlForm.addEventListener('submit', async e => {
  e.preventDefault();
  const raw = urlInput.value.trim();
  if (!raw) return;

  urlSubmit.disabled = true;
  const textoOriginal = urlSubmit.textContent;
  urlSubmit.textContent = 'Buscando…';

  try {
    let res;
    try {
      res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw })
      });
    } catch {
      throw new Error('No hay conexión con el servicio de importación.');
    }

    if (res.status === 404) {
      throw new Error('La función de importación no está publicada en el sitio. Subilo desde GitHub en vez de arrastrar el ZIP.');
    }

    let body = null;
    try { body = await res.json(); } catch { /* respuesta no JSON */ }

    if (!res.ok || !body || !body.ok) {
      throw new Error((body && body.error) || `El servidor respondió ${res.status}.`);
    }

    const data = body.data;
    const videoUrl = (data.downloads && (data.downloads.noWatermark || data.downloads.watermark)) || null;
    if (!videoUrl) throw new Error('Ese video no trajo un enlace descargable.');

    urlSubmit.textContent = 'Descargando…';
    const idSafe = (data.id || Date.now()).toString().replace(/[^\w-]/g, '');
    const filename = `${data.fuente === 'instagram' ? 'instagram' : 'tiktok'}_${idSafe}.mp4`;
    const dlRes = await fetch(proxiedDownload(videoUrl, filename));
    if (!dlRes.ok) {
      // el enlace se encontró pero el archivo no vino: conviene distinguirlo
      let detalle = '';
      try { detalle = (await dlRes.text()).slice(0, 160); } catch { /* sin cuerpo */ }
      throw new Error(detalle || `No se pudo traer el archivo del video (${dlRes.status}).`);
    }
    const blob = await dlRes.blob();
    if (!blob.size) throw new Error('El archivo del video llegó vacío. Probá de nuevo en unos segundos.');
    const file = new File([blob], filename, { type: blob.type || 'video/mp4' });

    // se comprueba que de verdad haya entrado al lote: el archivo puede venir
    // bien y aun así el navegador no poder abrirlo, y decir "listo" sin que
    // haya nada cargado es peor que avisar el problema
    const antes = state.clips.length;
    await addFiles([file]);
    if (state.clips.length === antes) {
      throw new Error('El video se descargó pero el navegador no pudo abrirlo. Guardalo en tu teléfono y subilo con "Elegí tus videos".');
    }

    urlInput.value = '';
    toast('Video importado. Ya está en tu lote.');
  } catch (err) {
    toast(textoDeError(err) || 'No se pudo importar ese video.', true);
  } finally {
    urlSubmit.disabled = false;
    urlSubmit.textContent = textoOriginal;
  }
});

/* ---------------- dibujo del texto ---------------- */

function fontString(px) {
  return `${state.style.weight} ${px}px "${state.style.family}", sans-serif`;
}

function wrapLines(ctx, text, maxPx) {
  const paragraphs = text.split('\n');
  const out = [];
  for (const p of paragraphs) {
    const words = p.split(/\s+/).filter(Boolean);
    if (!words.length) { continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (ctx.measureText(test).width <= maxPx) line = test;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

/** Trazo de un rectángulo con esquinas redondeadas, a mano (Safari viejo no tiene ctx.roundRect). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Recorta una caja al cuadro, sin deformarla cuando se sale por un costado. */
function cajaDentro(x, y, w, h, W, H) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(H, Math.ceil(y + h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Dibuja el bloque de subtítulo. Devuelve la caja usada.
 * xPct/yPct son la posición de ESTA línea (centro horizontal y borde
 * superior, en % del cuadro). Si vienen vacíos usa el centro y la altura
 * general de la pestaña Letra.
 */
function drawSubtitle(ctx, rawText, W, H, yPct, xPct, sizePct) {
  const s = state.style;
  let text = rawText.trim();
  if (!text) return null;
  if (s.caseMode === 'upper') text = text.toUpperCase();

  // sizePct: tamaño propio de ESTA línea; sin él manda el general de Letra
  const px = ((sizePct == null ? s.size : sizePct) / 100) * H;
  const strokePx = (s.strokeW / 100) * px;
  const maxPx = (s.maxW / 100) * W;

  ctx.font = fontString(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const lines = wrapLines(ctx, text, maxPx);
  const lineH = px * 1.24;
  const top = ((yPct == null ? s.y : yPct) / 100) * H;
  const cx = ((xPct == null ? 50 : xPct) / 100) * W;

  let widest = 0;
  lines.forEach(l => { widest = Math.max(widest, ctx.measureText(l).width); });

  let boxRect = null;

  // Fondo pegado al texto: en vez de borrar o difuminar el subtítulo
  // original, se tapa con una placa detrás de la traducción. Como la
  // placa es opaca y va en el mismo lugar, cubre el original de paso.
  if (state.cover.on && state.cover.mode === 'box') {
    const c = state.cover;
    const padX = px * 0.62;
    const padY = px * 0.34;
    const minW = Math.min(W, (c.boxMinW / 100) * W);
    const boxW = Math.max(widest + padX * 2, minW);
    const boxH = lines.length * lineH + padY * 2;
    const boxX = cx - boxW / 2;
    const boxY = top - padY;
    const radius = Math.min(boxW, boxH) * 0.5 * (c.boxRadius / 100);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, c.boxOpacity / 100));
    ctx.fillStyle = c.color;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.restore();

    boxRect = { x: boxX, y: boxY, w: boxW, h: boxH };
  }

  lines.forEach((line, i) => {
    const y = top + px * 0.96 + i * lineH;
    if (strokePx > 0) {
      ctx.lineWidth = strokePx * 2;
      ctx.strokeStyle = s.stroke;
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = s.fill;
    ctx.fillText(line, cx, y);
  });

  if (boxRect) {
    return cajaDentro(boxRect.x, boxRect.y, boxRect.w, boxRect.h, W, H);
  }

  const pad = strokePx + px * 0.3;
  return cajaDentro(
    cx - widest / 2 - pad,
    top - pad,
    widest + pad * 2,
    lines.length * lineH + pad * 2,
    W, H
  );
}

const _blurA = document.createElement('canvas');
const _blurB = document.createElement('canvas');

/**
 * Solo "Solo el texto" difumina la silueta de las letras originales.
 * "Fondo detrás de la traducción" no: para no dejar un manchón difuminado
 * donde estaba el original, tapa con la placa opaca nada más (por eso por
 * defecto es bien ancha — ver cover.boxMinW).
 */
function coverUsesMask() {
  return state.cover.mode === 'text';
}

function drawCover(ctx, media, W, H, clip, t) {
  if (!state.cover.on) return;
  if (state.cover.mode === 'box') return; // acá tapa solo la placa opaca de drawSubtitle, sin difuminado
  const y = Math.round((state.cover.y / 100) * H);
  const h = Math.round((state.cover.h / 100) * H);
  if (h <= 0) return;

  if (state.cover.mode === 'solid') {
    ctx.fillStyle = state.cover.color;
    ctx.fillRect(0, y, W, h);
    return;
  }

  const mask = coverUsesMask() ? mascaraEn(clip, t) : null;
  if (coverUsesMask() && !mask) return;   // sin silueta no se toca nada

  // El lienzo puede ser más chico que el video (en el celular se exporta
  // topado). Los recortes se toman en píxeles del ORIGEN, así que se
  // convierten; si coinciden, la escala es 1 y no cambia nada.
  const anchoOrigen = media.videoWidth || media.naturalWidth || W;
  const altoOrigen = media.videoHeight || media.naturalHeight || H;
  const esc = altoOrigen / H;
  const yOrigen = y * esc;
  const hOrigen = h * esc;

  // Difuminado por reducción en dos pasadas: se achica muchísimo la franja
  // y se vuelve a estirar. Safari no soporta ctx.filter, así que el
  // desenfoque se hace a mano. Cuanta más reducción, menos se lee el texto.
  const fuerza = Math.max(1, Math.min(10, state.cover.strength || 7));
  const f1 = 4 + fuerza * 1.2;          // primera reducción
  const f2 = 2 + fuerza * 0.9;          // segunda reducción

  const w1 = Math.max(6, Math.round(W / f1));
  const h1 = Math.max(3, Math.round(h / f1));
  const w2 = Math.max(3, Math.round(w1 / f2));
  const h2 = Math.max(2, Math.round(h1 / f2));

  try {
    _blurA.width = w1; _blurA.height = h1;
    const ca = _blurA.getContext('2d');
    ca.imageSmoothingEnabled = true;
    ca.imageSmoothingQuality = 'high';
    ca.drawImage(media, 0, yOrigen, anchoOrigen, hOrigen, 0, 0, w1, h1);

    _blurB.width = w2; _blurB.height = h2;
    const cb = _blurB.getContext('2d');
    cb.imageSmoothingEnabled = true;
    cb.imageSmoothingQuality = 'high';
    cb.drawImage(_blurA, 0, 0, w1, h1, 0, 0, w2, h2);

    // de vuelta al tamaño intermedio y luego al final: suaviza los bloques
    ca.clearRect(0, 0, w1, h1);
    ca.drawImage(_blurB, 0, 0, w2, h2, 0, 0, w1, h1);

    const prevS = ctx.imageSmoothingEnabled;
    const prevQ = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (mask) {
      _patch.width = W; _patch.height = h;
      const pc = _patch.getContext('2d');
      pc.clearRect(0, 0, W, h);
      pc.globalCompositeOperation = 'source-over';
      pc.imageSmoothingEnabled = true;
      pc.imageSmoothingQuality = 'high';
      pc.drawImage(_blurA, 0, 0, w1, h1, 0, 0, W, h);
      pc.globalCompositeOperation = 'destination-in';
      // la silueta se calculó al tamaño del video, no del lienzo
      pc.drawImage(mask, 0, y * (mask.height / H), mask.width, h * (mask.height / H), 0, 0, W, h);
      pc.globalCompositeOperation = 'source-over';
      ctx.drawImage(_patch, 0, y);
    } else {
      ctx.drawImage(_blurA, 0, 0, w1, h1, 0, y, W, h);
    }

    ctx.imageSmoothingEnabled = prevS;
    ctx.imageSmoothingQuality = prevQ;
  } catch (e) {
    // si no se pudo leer el cuadro, mejor una barra que dejar el texto a la vista
    ctx.fillStyle = state.cover.color;
    ctx.fillRect(0, y, W, h);
  }
}


/** Posición y tamaño en píxeles del logo para un cuadro W×H dado. */
function logoBox(W, H) {
  const L = state.logo;
  if (!L.img || !L.img.naturalWidth) return null;
  const targetW = Math.max(1, Math.round((L.size / 100) * W));
  const scale = targetW / L.img.naturalWidth;
  const targetH = Math.max(1, Math.round(L.img.naturalHeight * scale));
  const margin = Math.round((L.margin / 100) * W);
  let x, y;
  switch (L.pos) {
    case 'tl': x = margin; y = margin; break;
    case 'tr': x = W - targetW - margin; y = margin; break;
    case 'bl': x = margin; y = H - targetH - margin; break;
    case 'tc': x = (W - targetW) / 2; y = margin; break;
    case 'bc': x = (W - targetW) / 2; y = H - targetH - margin; break;
    default: x = W - targetW - margin; y = H - targetH - margin; // br
  }
  return { x: Math.round(x), y: Math.round(y), w: targetW, h: targetH };
}

/** Dibuja la marca de agua sobre el cuadro actual, si hay una cargada y activa. */
function drawLogo(ctx, W, H) {
  const L = state.logo;
  if (!L.on || !L.img) return;
  const box = logoBox(W, H);
  if (!box) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(0, Math.min(1, L.opacity / 100));
  ctx.drawImage(L.img, box.x, box.y, box.w, box.h);
  ctx.globalAlpha = prevAlpha;
}

/* ============================================================
   TAPADO SOLO SOBRE LAS LETRAS
   En vez de una franja, se calcula la silueta del texto original
   (relleno claro + borde oscuro) y se difumina únicamente ahí.
   El resto del video queda intacto.
   ============================================================ */

const _patch = document.createElement('canvas');

/** Silueta del texto quemado en el instante t, ya engordada. */
async function construirMascara(clip, t) {
  const W = clip.w, H = clip.h;
  if (!W || !H) return null;

  if (clip.isVideo) await seekTo(clip.media, t);

  const m = document.createElement('canvas');
  m.width = W; m.height = H;
  const mc = m.getContext('2d');
  let algo = false;

  for (const zona of zonasActivas()) {
    const y0 = Math.max(0, Math.floor((zona.y / 100) * H));
    const y1 = Math.min(H, Math.ceil(((zona.y + zona.h) / 100) * H));
    const alto = y1 - y0;
    if (alto <= 2) continue;

    const src = document.createElement('canvas');
    src.width = W; src.height = alto;
    const sc = src.getContext('2d', { willReadFrequently: true });
    sc.drawImage(clip.media, 0, y0, W, alto, 0, 0, W, alto);

    let d;
    try { d = sc.getImageData(0, 0, W, alto).data; }
    catch (e) { continue; }

    const lum = new Float32Array(W * alto);
    for (let i = 0, q = 0; i < d.length; i += 4, q++) {
      lum[q] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }

    // Fondo estimado: la misma zona muy reducida y vuelta a estirar.
    // El texto desaparece del fondo, así que la diferencia marca las letras.
    // Sirve igual con letras blancas sin borde sobre piel, pared o lo que sea.
    const fw = Math.max(4, Math.round(W / 12));
    const fh = Math.max(3, Math.round(alto / 6));
    const bg1 = document.createElement('canvas');
    bg1.width = fw; bg1.height = fh;
    const b1 = bg1.getContext('2d');
    b1.imageSmoothingEnabled = true; b1.imageSmoothingQuality = 'high';
    b1.drawImage(src, 0, 0, W, alto, 0, 0, fw, fh);

    const bg2 = document.createElement('canvas');
    bg2.width = W; bg2.height = alto;
    const b2 = bg2.getContext('2d', { willReadFrequently: true });
    b2.imageSmoothingEnabled = true; b2.imageSmoothingQuality = 'high';
    b2.drawImage(bg1, 0, 0, fw, fh, 0, 0, W, alto);

    let bd;
    try { bd = b2.getImageData(0, 0, W, alto).data; }
    catch (e) { continue; }

    const letras = new Uint8Array(W * alto);
    let cuenta = 0;
    for (let i = 0, q = 0; i < bd.length; i += 4, q++) {
      const fondo = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2];
      const v = lum[q];
      const dif = v - fondo;
      // letras claras o borde oscuro, siempre comparados contra su entorno
      if ((v > 165 && dif > 22) || (v < 105 && dif < -26)) { letras[q] = 1; cuenta++; }
    }
    if (cuenta < W * alto * 0.0012) continue;   // casi nada: no hay texto en esta zona

    const margen = Math.max(3, Math.round(H * 0.007));
    const gordas = dilate(letras, W, alto, margen);

    const img = mc.createImageData(W, alto);
    const md = img.data;
    for (let q = 0, k = 0; q < gordas.length; q++, k += 4) {
      md[k] = md[k + 1] = md[k + 2] = 255;
      md[k + 3] = gordas[q] ? 255 : 0;
    }
    mc.putImageData(img, 0, y0);
    algo = true;
  }

  return algo ? m : null;
}

/** Momentos donde hay que calcular una silueta: los tramos detectados, o las líneas. */
function planDeSiluetas(clip) {
  if (clip._segPlan && clip._segPlan.length) return clip._segPlan;
  return clip.cues.map(c => ({ start: c.start, end: c.end }));
}

function firmaDeCues(clip) {
  return planDeSiluetas(clip).map(s => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join('|') +
    '@' + zonasActivas().map(z => `${z.y.toFixed(1)}+${z.h.toFixed(1)}`).join(',');
}

/**
 * Una silueta por tramo. Se calcula una sola vez y se estira para que
 * no queden huecos: entre un tramo y el siguiente sigue valiendo el anterior.
 */
async function prepararMascaras(clip) {
  const firma = firmaDeCues(clip);
  if (clip._maskSig === firma && clip._masks) return clip._masks;

  const previo = clip.isVideo ? clip.time : 0;
  const plan = planDeSiluetas(clip)
    .slice()
    .sort((a, b) => a.start - b.start);

  const masks = [];
  for (const s of plan) {
    const mid = clip.isVideo ? (s.start + s.end) / 2 : 0;
    try {
      const canvas = await construirMascara(clip, mid);
      if (canvas) masks.push({ start: s.start, end: s.end, canvas });
    } catch (e) { /* ese tramo se queda sin silueta */ }
  }

  // sin huecos: cada silueta vale hasta que empieza la siguiente
  for (let i = 0; i < masks.length; i++) {
    if (i === 0) masks[i].start = 0;
    if (i < masks.length - 1) masks[i].end = masks[i + 1].start;
    else masks[i].end = clip.dur || masks[i].end;
  }

  if (clip.isVideo) { try { await seekTo(clip.media, previo); } catch (e) { /* nada */ } }

  clip._masks = masks;
  clip._maskSig = firma;
  return masks;
}

function mascaraEn(clip, t) {
  if (!clip || !clip._masks || !clip._masks.length) return null;
  if (!clip.isVideo) return clip._masks[0].canvas;
  for (const m of clip._masks) {
    if (t >= m.start && t <= m.end) return m.canvas;
  }
  // fuera de rango: vale la más cercana en el tiempo
  let mejor = clip._masks[0], dist = Infinity;
  for (const m of clip._masks) {
    const d = t < m.start ? m.start - t : t - m.end;
    if (d < dist) { dist = d; mejor = m; }
  }
  return mejor.canvas;
}

/* ---------------- vista previa ---------------- */

const preview = $('preview');
const pctx = preview.getContext('2d');

function currentClip() { return state.clips[state.sel] || null; }

/** Líneas visibles en un momento dado (puede haber varias a distinta altura). */
function cuesEn(clip, t) {
  if (!clip) return [];
  return clip.cues.filter(c =>
    c.text.trim() && (t == null || (t >= c.start && t <= c.end))
  );
}

function renderStage() {
  const clip = currentClip();
  $('stageEmpty').hidden = !!clip;
  $('stageLive').hidden = !clip;
  $('viewer').hidden = !clip;
  $('emptyNote').hidden = state.clips.length > 0;
  $('clearBatch').hidden = state.clips.length === 0;
  $('heroAuto').hidden = state.clips.length === 0;
  actualizarBotonPlay();
  if (!clip) return;

  const scrub = $('scrub');
  scrub.disabled = !clip.isVideo;
  scrub.max = clip.isVideo ? clip.dur.toFixed(2) : 1;
  scrub.value = Math.min(clip.time, clip.isVideo ? clip.dur : 1);
  $('tcNow').textContent = clip.isVideo ? clip.time.toFixed(2) + 's' : 'imagen';

  updateVoiceBox(clip);
  renderCues();
  paint();
  if (!busy) {
    quickBand(clip);
    if (state.cover.on && coverUsesMask() &&
        clip._maskSig !== firmaDeCues(clip) && clip.cues.some(c => c.text.trim())) {
      prepararMascaras(clip).then(() => { if (currentClip() === clip) paint(); });
    }
  }
}

// cajas de las líneas dibujadas en el último paint, para el arrastre con el dedo
let cajasEnPantalla = [];
let arrastre = null;

function paint() {
  const clip = currentClip();
  if (!clip) return;
  const W = clip.w, H = clip.h;
  // solo se redimensiona si cambió: asignar width/height reserva el lienzo de
  // nuevo, y durante la reproducción esto corre en cada cuadro
  if (preview.width !== W || preview.height !== H) { preview.width = W; preview.height = H; }

  pctx.clearRect(0, 0, W, H);
  pctx.drawImage(clip.media, 0, 0, W, H);
  drawCover(pctx, clip.media, W, H, clip, clip.isVideo ? clip.time : 0);

  // se guarda la caja de cada línea para saber cuál agarra el dedo al arrastrar
  cajasEnPantalla = [];
  cuesEn(clip, clip.isVideo ? clip.time : null).forEach(c => {
    const box = drawSubtitle(pctx, c.text, W, H, c.y, c.x, c.size);
    if (box && box.w > 0 && box.h > 0) cajasEnPantalla.push({ cue: c, box });
  });

  drawLogo(pctx, W, H);
}

/* ---------------- mover el subtítulo con el dedo ---------------- */

/** Convierte un toque de la pantalla a coordenadas del video. */
function puntoEnLienzo(e) {
  const r = preview.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: (e.clientX - r.left) / r.width * preview.width,
    y: (e.clientY - r.top) / r.height * preview.height
  };
}

/** La línea que está bajo el dedo. Se recorre al revés: gana la de encima. */
function cueEnPunto(p) {
  const margen = Math.max(10, preview.height * 0.012);   // holgura para el dedo
  for (let i = cajasEnPantalla.length - 1; i >= 0; i--) {
    const { cue, box } = cajasEnPantalla[i];
    if (p.x >= box.x - margen && p.x <= box.x + box.w + margen &&
        p.y >= box.y - margen && p.y <= box.y + box.h + margen) {
      return cue;
    }
  }
  return null;
}

preview.addEventListener('pointerdown', e => {
  const clip = currentClip();
  if (!clip || busy) return;
  const p = puntoEnLienzo(e);
  if (!p) return;
  const cue = cueEnPunto(p);
  if (!cue) return;

  e.preventDefault();
  if (reproduciendo) pausarVista();   // se acomoda con el video quieto
  try { preview.setPointerCapture(e.pointerId); } catch (err) { /* sin captura igual funciona */ }

  const W = preview.width, H = preview.height;
  arrastre = {
    id: e.pointerId,
    cue,
    // desfase entre el dedo y la posición de la línea, para que no pegue un salto
    dx: p.x - ((cue.x == null ? 50 : cue.x) / 100) * W,
    dy: p.y - ((cue.y == null ? state.style.y : cue.y) / 100) * H,
    movido: false
  };
  preview.classList.add('moviendo');
});

preview.addEventListener('pointermove', e => {
  if (!arrastre || e.pointerId !== arrastre.id) {
    // sin arrastrar: la manito solo aparece encima de un subtítulo
    if (!arrastre && e.pointerType === 'mouse') {
      const q = puntoEnLienzo(e);
      preview.classList.toggle('sobre-cue', !!(q && cueEnPunto(q)));
    }
    return;
  }
  const p = puntoEnLienzo(e);
  if (!p) return;
  e.preventDefault();

  const W = preview.width, H = preview.height;
  const cue = arrastre.cue;

  // se limita con el tamaño real del bloque para que no se escape del cuadro
  const entrada = cajasEnPantalla.find(b => b.cue === cue);
  const medioAncho = entrada ? (entrada.box.w / W) * 50 : 0;
  const alto = entrada ? (entrada.box.h / H) * 100 : 0;

  const x = (p.x - arrastre.dx) / W * 100;
  const y = (p.y - arrastre.dy) / H * 100;

  cue.x = medioAncho * 2 >= 100 ? 50 : Math.max(medioAncho, Math.min(100 - medioAncho, x));
  cue.y = Math.max(0, Math.min(Math.max(0, 100 - alto), y));
  arrastre.movido = true;
  paint();
});

function terminarArrastre(e) {
  if (!arrastre || (e && e.pointerId !== arrastre.id)) return;
  const movido = arrastre.movido;
  arrastre = null;
  preview.classList.remove('moviendo');
  if (movido) renderCues();   // que los deslizadores muestren los valores nuevos
}

preview.addEventListener('pointerup', terminarArrastre);
preview.addEventListener('pointercancel', terminarArrastre);

/* ---------------- reproducir la vista previa ---------------- */

const ICONO_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2l11.5 6.8L8 18.8z"/></svg>';
const ICONO_PAUSA = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/></svg>';

let reproduciendo = false;
let rafVista = null;

function actualizarBotonPlay() {
  const btn = $('playBtn');
  const clip = currentClip();
  btn.disabled = !clip || !clip.isVideo || busy;
  btn.innerHTML = reproduciendo ? ICONO_PAUSA : ICONO_PLAY;
  btn.setAttribute('aria-label', reproduciendo ? 'Pausar' : 'Reproducir');
}

/** Marca qué línea está sonando ahora, sin rehacer toda la lista. */
function marcarCueActiva() {
  const clip = currentClip();
  if (!clip) return;
  const filas = $('cueList').children;
  for (let i = 0; i < filas.length && i < clip.cues.length; i++) {
    const c = clip.cues[i];
    filas[i].classList.toggle('active', clip.isVideo && clip.time >= c.start && clip.time <= c.end);
  }
}

function bucleVista() {
  const clip = currentClip();
  if (!reproduciendo || !clip || !clip.isVideo || busy) { pausarVista(); return; }

  const v = clip.media;
  clip.time = v.currentTime;
  paint();
  $('scrub').value = clip.time;
  $('tcNow').textContent = clip.time.toFixed(2) + 's';
  marcarCueActiva();

  if (v.ended || (clip.dur && clip.time >= clip.dur - 0.03)) { pausarVista(); return; }
  rafVista = requestAnimationFrame(bucleVista);
}

function pausarVista() {
  const clip = currentClip();
  reproduciendo = false;
  if (rafVista) cancelAnimationFrame(rafVista);
  rafVista = null;
  if (clip && clip.isVideo) { try { clip.media.pause(); } catch (e) { /* ya estaba detenido */ } }
  actualizarBotonPlay();
}

async function reproducirVista() {
  const clip = currentClip();
  if (!clip || !clip.isVideo || busy) return;
  const v = clip.media;
  v.muted = true;            // la vista previa siempre va muda
  v.playsInline = true;

  // si quedó al final, vuelve a empezar
  if (clip.dur && v.currentTime >= clip.dur - 0.05) {
    try { await seekTo(v, 0); } catch (e) { /* igual se intenta reproducir */ }
    clip.time = 0;
  }

  try {
    await v.play();
  } catch (e) {
    toast('El navegador no dejó reproducir la vista previa. Tocá el botón otra vez.', true);
    return;
  }

  reproduciendo = true;
  actualizarBotonPlay();
  rafVista = requestAnimationFrame(bucleVista);
}

$('playBtn').addEventListener('click', () => {
  if (reproduciendo) { pausarVista(); renderCues(); }
  else reproducirVista();
});

$('scrub').addEventListener('input', e => {
  const clip = currentClip();
  if (!clip || !clip.isVideo) return;
  if (reproduciendo) pausarVista();     // mover la barra manda sobre la reproducción
  clip.time = parseFloat(e.target.value);
  $('tcNow').textContent = clip.time.toFixed(2) + 's';
  clip.media.currentTime = clip.time;
  clip.media.onseeked = () => { paint(); renderCues(); };
});

/* ---------------- líneas de subtítulo ---------------- */

function renderCues() {
  const clip = currentClip();
  const ul = $('cueList');
  ul.innerHTML = '';
  if (!clip) return;

  clip.cues.forEach((cue, i) => {
    const active = clip.isVideo && clip.time >= cue.start && clip.time <= cue.end;
    const curY = cue.y != null ? cue.y : state.style.y;
    const curX = cue.x != null ? cue.x : 50;
    const curT = cue.size != null ? cue.size : state.style.size;
    const li = document.createElement('li');
    li.className = 'cue' + (active ? ' active' : '');
    li.innerHTML = `
      <div class="cue-top">
        <button class="cue-n" type="button" title="Ver este momento">${i + 1}</button>
        ${clip.isVideo ? `
          <input class="cue-time" type="text" value="${cue.start.toFixed(2)}" data-k="start" aria-label="Desde">
          <span class="cue-arrow">→</span>
          <input class="cue-time" type="text" value="${cue.end.toFixed(2)}" data-k="end" aria-label="Hasta">
        ` : '<span class="cue-arrow">texto fijo</span>'}
        <button class="cue-del" type="button" aria-label="Quitar línea">×</button>
      </div>
      <div class="cue-pos">
        <span>Arriba/abajo <em class="cue-posv">${curY.toFixed(1)}%</em></span>
        <input type="range" class="cue-y" min="0" max="94" step="0.5" value="${curY}" aria-label="Posición vertical de esta línea">
        <button class="cue-posreset" type="button" title="Volver al centro y a la altura general">↺</button>
      </div>
      <div class="cue-pos">
        <span>Izq./der. <em class="cue-posh">${curX.toFixed(1)}%</em></span>
        <input type="range" class="cue-x" min="0" max="100" step="0.5" value="${curX}" aria-label="Posición horizontal de esta línea">
        <button class="cue-pick" type="button" title="Ver esta línea en la vista previa">◎</button>
      </div>
      <div class="cue-pos">
        <span>Tamaño <em class="cue-sizev">${curT.toFixed(1)}%</em></span>
        <input type="range" class="cue-size" min="1.5" max="14" step="0.1" value="${curT}" aria-label="Tamaño de esta línea">
        <button class="cue-sizereset" type="button" title="Volver al tamaño general de la pestaña Letra">↺</button>
      </div>
      <textarea placeholder="Escribí el texto en español…">${esc(cue.text)}</textarea>`;

    const ta = li.querySelector('textarea');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; };
    ta.addEventListener('input', e => {
      cue.text = e.target.value; grow(); paint(); renderClipList();
    });
    requestAnimationFrame(grow);
    li.querySelectorAll('.cue-time').forEach(inp => {
      inp.addEventListener('change', e => {
        const v = parseFloat(e.target.value.replace(',', '.'));
        if (!isNaN(v)) cue[e.target.dataset.k] = Math.max(0, Math.min(clip.dur, v));
        renderCues(); paint();
      });
    });

    const yRange = li.querySelector('.cue-y');
    const yLabel = li.querySelector('.cue-posv');
    yRange.addEventListener('input', e => {
      cue.y = parseFloat(e.target.value);
      yLabel.textContent = cue.y.toFixed(1) + '%';
      paint();
    });

    const xRange = li.querySelector('.cue-x');
    const xLabel = li.querySelector('.cue-posh');
    xRange.addEventListener('input', e => {
      cue.x = parseFloat(e.target.value);
      xLabel.textContent = cue.x.toFixed(1) + '%';
      paint();
    });

    const tRange = li.querySelector('.cue-size');
    const tLabel = li.querySelector('.cue-sizev');
    tRange.addEventListener('input', e => {
      cue.size = parseFloat(e.target.value);
      tLabel.textContent = cue.size.toFixed(1) + '%';
      paint();
    });
    li.querySelector('.cue-sizereset').addEventListener('click', () => {
      cue.size = null;
      renderCues(); paint();
    });

    li.querySelector('.cue-posreset').addEventListener('click', () => {
      cue.y = null; cue.x = null;
      renderCues(); paint();
    });

    // salta al momento de esta línea, así se la puede arrastrar en la vista previa
    li.querySelector('.cue-pick').addEventListener('click', () => {
      if (!clip.isVideo) { goTab('texto'); return; }
      const t = Math.min(clip.dur, cue.start + 0.15);
      clip.time = t;
      $('scrub').value = t;
      $('tcNow').textContent = t.toFixed(2) + 's';
      clip.media.currentTime = t;
      clip.media.onseeked = () => { paint(); renderCues(); };
    });
    li.querySelector('.cue-n').addEventListener('click', () => {
      if (!clip.isVideo) return;
      const t = Math.min(clip.dur, cue.start + 0.15);
      clip.time = t;
      $('scrub').value = t;
      $('tcNow').textContent = t.toFixed(2) + 's';
      clip.media.currentTime = t;
      clip.media.onseeked = () => { paint(); renderCues(); };
    });

    li.querySelector('.cue-del').addEventListener('click', () => {
      clip.cues.splice(i, 1);
      if (!clip.cues.length) clip.cues.push({ text: '', start: 0, end: clip.dur || 0 });
      renderCues(); paint(); renderClipList();
    });
    ul.appendChild(li);
  });
}

$('addCue').addEventListener('click', () => {
  const clip = currentClip();
  if (!clip) return;
  const last = clip.cues[clip.cues.length - 1];
  const start = last ? Math.min(clip.dur, last.end) : 0;
  clip.cues.push({ text: '', start, end: Math.min(clip.dur, start + 3) });
  renderCues(); renderClipList();
});

/* ---------------- leer texto del video (OCR) ---------------- */

$('btnOcr').addEventListener('click', async () => {
  const clip = currentClip();
  if (!clip || busy) return;
  const btn = $('btnOcr');
  btn.disabled = true; btn.textContent = 'Leyendo…';

  try {
    const W = clip.w, H = clip.h;
    const bandY = state.cover.on ? (state.cover.y / 100) * H : H * 0.55;
    const bandH = state.cover.on ? (state.cover.h / 100) * H : H * 0.4;

    const c = document.createElement('canvas');
    const scale = 2;
    c.width = Math.round(W * scale);
    c.height = Math.round(bandH * scale);
    const cx = c.getContext('2d');
    cx.drawImage(clip.media, 0, bandY, W, bandH, 0, 0, c.width, c.height);

    // el texto quemado suele ser blanco con borde negro: subimos contraste
    const img = cx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = lum > 205 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    cx.putImageData(img, 0, 0);

    const { data } = await Tesseract.recognize(c, 'eng');
    const text = (data.text || '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!text) { toast('No se leyó texto en esa franja. Movela sobre el subtítulo original y probá de nuevo.', true); }
    else {
      const cue = clip.cues.find(c2 => clip.time >= c2.start && clip.time <= c2.end) || clip.cues[0];
      cue.text = text;
      renderCues(); paint(); renderClipList();
      toast('Texto leído. Revisalo y tocá “Traducir todo”.');
    }
  } catch (err) {
    toast('La lectura falló. Podés escribir el texto a mano.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Leer del video';
  }
});

/* ---------------- traducción ---------------- */

$('btnTranslate').addEventListener('click', async () => {
  const clip = currentClip();
  if (!clip) return;
  const texts = clip.cues.map(c => c.text).filter(t => t.trim());
  if (!texts.length) { toast('Todavía no hay texto para traducir.', true); return; }

  const btn = $('btnTranslate');
  btn.disabled = true; btn.textContent = 'Traduciendo…';
  try {
    const translations = await translateMany(texts);

    let k = 0;
    clip.cues.forEach(c => { if (c.text.trim()) c.text = translations[k++] ?? c.text; });
    renderCues(); paint(); renderClipList();
    toast('Traducido al español.');
  } catch (err) {
    toast(err.name === 'TranslateError'
      ? err.message
      : 'La traducción no respondió. Revisá que ANTHROPIC_API_KEY esté configurada en Netlify.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Traducir todo';
  }
});

/* ---------------- voz de ElevenLabs ---------------- */

const voiceDrop = $('voiceDrop');
const voiceInput = $('voiceInput');

voiceInput.addEventListener('change', e => {
  if (e.target.files && e.target.files[0]) attachVoice(e.target.files[0]);
  setTimeout(() => { voiceInput.value = ''; }, 0);
});
['dragenter', 'dragover'].forEach(ev =>
  voiceDrop.addEventListener(ev, e => { e.preventDefault(); voiceDrop.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev =>
  voiceDrop.addEventListener(ev, e => { e.preventDefault(); voiceDrop.classList.remove('hot'); }));
voiceDrop.addEventListener('drop', e => attachVoice(e.dataTransfer.files[0]));

function attachVoice(file) {
  const clip = currentClip();
  if (!clip) { toast('Primero elegí un archivo del lote.', true); return; }
  if (!file || !file.type.startsWith('audio/')) { toast('Ese archivo no es audio.', true); return; }
  clip.voice = file;
  updateVoiceBox(clip); renderClipList();
}

function updateVoiceBox(clip) {
  const has = !!(clip && clip.voice);
  voiceDrop.classList.toggle('has', has);
  $('voiceName').textContent = has ? clip.voice.name : 'Subir la voz de ElevenLabs';
}

$('voiceToAll').addEventListener('click', () => {
  const clip = currentClip();
  if (!clip || !clip.voice) { toast('Subí una voz primero.', true); return; }
  state.clips.forEach(c => { c.voice = clip.voice; });
  renderClipList();
  toast(`Voz aplicada a ${state.clips.length} archivos.`);
});

/* ---------------- marca de agua (logo) ---------------- */

const logoDrop = $('logoDrop');
const logoInput = $('logoInput');

function updateLogoBox() {
  const has = !!state.logo.img;
  logoDrop.classList.toggle('has', has);
  $('logoName').textContent = has ? state.logo.file.name : 'Subir el logo de tu marca';
}

async function attachLogo(file) {
  if (!file || !file.type.startsWith('image/')) { toast('Ese archivo no es una imagen.', true); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  const ok = await waitEvent(img, 'load', 12000);
  if (!ok && !img.naturalWidth) { toast('No se pudo abrir esa imagen.', true); URL.revokeObjectURL(url); return; }
  if (state.logo.img && state.logo.img.src) URL.revokeObjectURL(state.logo.img.src);
  state.logo.file = file;
  state.logo.img = img;
  state.logo.on = true;
  $('logoOn').checked = true;
  updateLogoBox();
  paint();
  toast('Logo cargado. Ajustá dónde va y qué tan marcado se ve.');
}

logoInput.addEventListener('change', e => {
  if (e.target.files && e.target.files[0]) attachLogo(e.target.files[0]);
  setTimeout(() => { logoInput.value = ''; }, 0);
});
['dragenter', 'dragover'].forEach(ev =>
  logoDrop.addEventListener(ev, e => { e.preventDefault(); logoDrop.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev =>
  logoDrop.addEventListener(ev, e => { e.preventDefault(); logoDrop.classList.remove('hot'); }));
logoDrop.addEventListener('drop', e => attachLogo(e.dataTransfer.files[0]));

$('logoClear').addEventListener('click', () => {
  if (state.logo.img && state.logo.img.src) URL.revokeObjectURL(state.logo.img.src);
  state.logo.file = null;
  state.logo.img = null;
  state.logo.on = false;
  $('logoOn').checked = false;
  updateLogoBox();
  paint();
});

/* ---------------- controles de estilo ---------------- */

function bind(id, path, opts = {}) {
  const el = $(id);
  const [group, key] = path.split('.');
  const apply = () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (opts.num) v = parseFloat(v);
    state[group][key] = v;
    if (opts.label) $(opts.label).textContent = opts.fmt ? opts.fmt(v) : v;
    paint();
  };
  el.addEventListener('input', apply);
  el.addEventListener('change', apply);
}

const pct = v => v + '%';

bind('fontFamily', 'style.family');
bind('fontWeight', 'style.weight');
bind('fontCase', 'style.caseMode');
bind('fontSize', 'style.size', { num: 1, label: 'fontSizev', fmt: pct });
bind('strokeW', 'style.strokeW', { num: 1, label: 'strokeWv', fmt: pct });
bind('fillColor', 'style.fill');
bind('strokeColor', 'style.stroke');
bind('textY', 'style.y', { num: 1, label: 'textYv', fmt: pct });
bind('maxW', 'style.maxW', { num: 1, label: 'maxWv', fmt: pct });

bind('coverOn', 'cover.on');
bind('coverMode', 'cover.mode');
bind('coverColor', 'cover.color');
bind('coverY', 'cover.y', { num: 1, label: 'coverYv', fmt: pct });
bind('coverH', 'cover.h', { num: 1, label: 'coverHv', fmt: pct });
['coverY', 'coverH'].forEach(id => $(id).addEventListener('input', () => {
  state.cover.zones = null;          // al mover a mano manda la franja manual
  state.clips.forEach(c => { c._masks = null; c._maskSig = null; });
}));
bind('coverStrength', 'cover.strength', { num: 1, label: 'coverSv' });
bind('coverBoxOpacity', 'cover.boxOpacity', { num: 1, label: 'coverBoxOpacityv', fmt: pct });
bind('coverBoxRadius', 'cover.boxRadius', { num: 1, label: 'coverBoxRadiusv', fmt: pct });
bind('coverBoxMinW', 'cover.boxMinW', { num: 1, label: 'coverBoxMinWv', fmt: pct });

bind('logoOn', 'logo.on');
bind('logoPos', 'logo.pos');
bind('logoOpacity', 'logo.opacity', { num: 1, label: 'logoOpacityv', fmt: pct });
bind('logoSize', 'logo.size', { num: 1, label: 'logoSizev', fmt: pct });
bind('logoMargin', 'logo.margin', { num: 1, label: 'logoMarginv', fmt: pct });

bind('musicVol', 'audio.musicVol', { num: 1, label: 'musicVolv', fmt: pct });
bind('voiceDelay', 'audio.voiceDelay', { num: 1, label: 'voiceDelayv', fmt: v => v.toFixed(1) + 's' });

$('audioMode').addEventListener('change', e => {
  state.audio.mode = e.target.value;
  $('mixControls').style.display = e.target.value === 'mix' ? '' : 'none';
});
$('mixControls').style.display = 'none';

function setMute(on) {
  state.audio.mute = on;
  $('muteAll').checked = on;
  $('muteHero').checked = on;
}
$('muteAll').addEventListener('change', e => setMute(e.target.checked));
$('muteHero').addEventListener('change', e => setMute(e.target.checked));

$('zipAll').addEventListener('change', e => { state.zip = e.target.checked; });
$('exportQuality').addEventListener('change', e => { state.exportLado = parseInt(e.target.value, 10) || 0; });

/* ---------------- motor de video ---------------- */

async function loadEngine() {
  if (ffmpegReady) return;
  setEngine('cargando…', 'chip-load');
  const { FFmpeg } = FFmpegWASM;
  const { toBlobURL } = FFmpegUtil;
  const base = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';

  ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (progress > 0 && progress <= 1) setBar(progress, null);
  });

  const conLimite = (p, ms, queHace) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(queHace)), ms))
  ]);

  try {
    const [coreURL, wasmURL] = await conLimite(Promise.all([
      toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
    ]), 90000, 'La descarga del motor tardó demasiado.');

    await conLimite(ffmpeg.load({ coreURL, wasmURL }), 60000, 'El motor no arrancó en este navegador.');
  } catch (err) {
    ffmpeg = null; ffmpegReady = false;
    setEngine('no disponible', 'chip-idle');
    throw err;
  }

  ffmpegReady = true;
  setEngine('listo', 'chip-ready');
}

function setBar(frac, text) {
  $('progressWrap').hidden = false;
  $('progressBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  if (text != null) $('progressText').textContent = text;
}

/* ---------------- construcción de superposiciones ---------------- */

/** PNG recortado con el texto de una línea + su posición. */
function cueOverlay(clip, cue, anchoSalida, altoSalida) {
  // se dibuja directo al tamaño final: si el video se exporta más chico, las
  // letras salen nítidas en vez de achicadas después
  const W = anchoSalida || clip.w, H = altoSalida || clip.h;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  const box = drawSubtitle(cx, cue.text, W, H, cue.y, cue.x, cue.size);
  if (!box || box.w <= 0 || box.h <= 0) return null;

  const out = document.createElement('canvas');
  out.width = box.w; out.height = box.h;
  out.getContext('2d').drawImage(c, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return { canvas: out, x: box.x, y: box.y };
}

function canvasToBytes(canvas) {
  return new Promise(resolve => {
    canvas.toBlob(async blob => resolve(new Uint8Array(await blob.arrayBuffer())), 'image/png');
  });
}

/* ---------------- exportar una imagen ---------------- */

async function exportImage(clip) {
  if (state.cover.on && coverUsesMask()) await prepararMascaras(clip);
  const W = clip.w, H = clip.h;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.drawImage(clip.media, 0, 0, W, H);
  drawCover(cx, clip.media, W, H, clip, 0);
  cuesEn(clip, null).forEach(c => drawSubtitle(cx, c.text, W, H, c.y, c.x, c.size));
  drawLogo(cx, W, H);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  return { name: baseName(clip.file.name) + '-es.jpg', data: new Uint8Array(await blob.arrayBuffer()) };
}

/* ---------------- exportar un video ---------------- */

async function exportVideo(clip) {
  await loadEngine();
  const W = clip.w, H = clip.h;
  const dur = clip.dur;

  const inName = 'in.mp4';
  await ffmpeg.writeFile(inName, new Uint8Array(await clip.file.arrayBuffer()));

  const inputs = ['-i', inName];
  const filters = [];
  let last = '0:v';
  let idx = 1;

  // franja que tapa el subtítulo original
  if (state.cover.on && state.cover.h > 0) {
    const cy = Math.round((state.cover.y / 100) * H);
    const ch = Math.round((state.cover.h / 100) * H);
    if (state.cover.mode === 'blur') {
      const r = Math.max(6, Math.round(H * 0.022));
      filters.push(`[${last}]split=2[bA][bB]`);
      filters.push(`[bB]crop=${W}:${ch}:0:${cy},boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${Math.round(r / 2)}:chroma_power=2[bl]`);
      filters.push(`[bA][bl]overlay=0:${cy}[vc]`);
    } else {
      filters.push(`[${last}]drawbox=x=0:y=${cy}:w=${W}:h=${ch}:color=${state.cover.color}@1:t=fill[vc]`);
    }
    last = 'vc';
  }

  // una superposición por línea de subtítulo
  let n = 0;
  for (const cue of clip.cues) {
    if (!cue.text.trim()) continue;
    const ov = cueOverlay(clip, cue);
    if (!ov) continue;
    const png = `cue${n}.png`;
    await ffmpeg.writeFile(png, await canvasToBytes(ov.canvas));
    inputs.push('-i', png);
    const start = Math.max(0, cue.start);
    const end = Math.min(dur, cue.end > cue.start ? cue.end : dur);
    filters.push(`[${last}][${idx}:v]overlay=${ov.x}:${ov.y}:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[v${n}]`);
    last = `v${n}`;
    idx++; n++;
  }

  // marca de agua: se pre-renderiza con la intensidad y el tamaño ya
  // aplicados, así que en ffmpeg es una superposición fija de principio a fin
  let hasLogo = false;
  if (state.logo.on && state.logo.img && state.logo.img.naturalWidth) {
    const box = logoBox(W, H);
    if (box) {
      const lc = document.createElement('canvas');
      lc.width = box.w; lc.height = box.h;
      const lcx = lc.getContext('2d');
      lcx.globalAlpha = Math.max(0, Math.min(1, state.logo.opacity / 100));
      lcx.drawImage(state.logo.img, 0, 0, box.w, box.h);
      await ffmpeg.writeFile('logo.png', await canvasToBytes(lc));
      inputs.push('-i', 'logo.png');
      filters.push(`[${last}][${idx}:v]overlay=${box.x}:${box.y}[vlogo]`);
      last = 'vlogo';
      idx++; hasLogo = true;
    }
  }

  // audio
  const mode = state.audio.mode;
  const hasVoice = !!clip.voice && !state.audio.mute;
  let voiceIdx = -1;
  if ((mode === 'voice' || mode === 'mix') && hasVoice) {
    const ext = (clip.voice.name.split('.').pop() || 'mp3').toLowerCase();
    const vName = `voice.${ext}`;
    await ffmpeg.writeFile(vName, new Uint8Array(await clip.voice.arrayBuffer()));
    inputs.push('-i', vName);
    voiceIdx = idx; idx++;
  }

  const d = Math.round(state.audio.voiceDelay * 1000);
  const args = [...inputs];
  const maps = [];

  if (state.audio.mute) {
    args.push('-an');
  } else if (mode === 'keep' || ((mode === 'voice' || mode === 'mix') && !hasVoice)) {
    // sin archivo de voz cargado, se conserva el audio original
    maps.push('-map', '0:a?');
    args.push('-c:a', 'aac', '-b:a', '160k');
  } else if (mode === 'voice') {
    filters.push(`[${voiceIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${d}|${d},apad=whole_dur=${dur.toFixed(2)}[aout]`);
    maps.push('-map', '[aout]');
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else if (mode === 'mix') {
    const mv = (state.audio.musicVol / 100).toFixed(2);
    filters.push(`[${voiceIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${d}|${d},volume=1.8,apad=whole_dur=${dur.toFixed(2)}[vo]`);
    filters.push(`[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${mv}[mu]`);
    filters.push(`[mu][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
    maps.push('-map', '[aout]');
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  // mismo tope de tamaño que en el celular, para que la calidad elegida en la
  // pestaña Audio signifique lo mismo en los dos motores
  const salida = medidasDeSalida(clip);
  if (salida.escalado) {
    filters.push(`[${last}]scale=${salida.w}:${salida.h}:flags=lanczos[vesc]`);
    last = 'vesc';
  }

  if (filters.length) args.push('-filter_complex', filters.join(';'));
  args.push('-map', last === '0:v' ? '0:v' : `[${last}]`);
  args.push(...maps);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-t', dur.toFixed(2), 'out.mp4');

  await ffmpeg.exec(args);
  const data = await ffmpeg.readFile('out.mp4');

  // limpieza
  const files = ['in.mp4', 'out.mp4'];
  for (let i = 0; i < n; i++) files.push(`cue${i}.png`);
  if (hasLogo) files.push('logo.png');
  if (voiceIdx >= 0) files.push(`voice.${(clip.voice.name.split('.').pop() || 'mp3').toLowerCase()}`);
  for (const f of files) { try { await ffmpeg.deleteFile(f); } catch (e) { /* ya no existe */ } }

  return { name: baseName(clip.file.name) + '-es.mp4', data: new Uint8Array(data.buffer || data) };
}

/* ---------------- flujo de exportación ---------------- */

const urlsVivas = [];

function mimeDe(name) {
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.zip')) return 'application/zip';
  return 'image/jpeg';
}

function download(name, bytes, mime) {
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Muestra los archivos terminados como enlaces para tocar.
 * En iOS la descarga automática se pierde: el usuario necesita
 * un toque propio para que aparezca el menú de guardar.
 */
function mostrarResultados(items) {
  const ul = $('resultList');
  ul.innerHTML = '';
  urlsVivas.forEach(u => URL.revokeObjectURL(u));
  urlsVivas.length = 0;

  items.forEach(item => {
    const blob = item.data instanceof Blob
      ? item.data
      : new Blob([item.data], { type: mimeDe(item.name) });
    const url = URL.createObjectURL(blob);
    urlsVivas.push(url);

    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    a.rel = 'noopener';
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg><span></span>`;
    a.querySelector('span').textContent = `${item.name} · ${(blob.size / 1048576).toFixed(1)} MB`;

    // en iOS el atributo download no basta: abrimos el menú de compartir
    a.addEventListener('click', async e => {
      if (!IS_IOS) return;
      const file = new File([blob], item.name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        e.preventDefault();
        try { await navigator.share({ files: [file] }); }
        catch (err) { window.open(url, '_blank'); }
      }
    });

    li.appendChild(a);
    ul.appendChild(li);
  });

  $('results').hidden = items.length === 0;
  if (items.length) {
    $('progressWrap').hidden = true;   // la barra tapaba los enlaces
    goTab('lote');
    setTimeout(() => $('results').scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
  }
}

async function entregarArchivos(results) {
  let items = results;

  if (state.zip && results.length > 1 && !esMovil() && typeof JSZip !== 'undefined') {
    const zip = new JSZip();
    results.forEach(r => zip.file(r.name, r.data));
    const blob = await zip.generateAsync({ type: 'blob' });
    items = [{ name: 'videos-en-espanol.zip', data: blob }];
  }

  mostrarResultados(items);

  // en el computador la descarga automática funciona bien; en el celular
  // el archivo espera en la tarjeta a que lo toquen
  if (!esMovil()) {
    items.forEach(r => download(r.name, r.data, mimeDe(r.name)));
  }
}

async function runExport(clips) {
  if (busy) return;
  if (!clips.length) { toast('No hay nada en el lote.', true); return; }

  pausarVista();          // el exportador necesita el video para él solo
  busy = true;
  actualizarBotonPlay();  // recién ahora se ve apagado: pausarVista corre antes de busy
  $('results').hidden = true;
  $('renderOne').disabled = true;
  $('renderAll').disabled = true;
  $('reExport').disabled = true;
  $('reExport').textContent = 'Armando…';
  const results = [];

  try {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      clip.status = 'exportando…';
      renderClipList();
      setBar(i / clips.length, `Exportando ${i + 1} de ${clips.length} — ${clip.file.name}`);

      const out = await conLimiteDeTiempo(
        exportClip(clip, (m, f) => setBar((i + f) / clips.length, m)),
        (clip.dur || 30) * 4000 + 90000,
        'El archivo tardó demasiado en armarse. Probá con un video más corto.'
      );
      results.push(out);
      clip.status = 'listo';
      renderClipList();
    }

    setBar(1, 'Preparando la descarga…');

    const detalleFps = ultimoFpsExport ? ` · ${ultimoFpsExport} cuadros/s` : '';
    setBar(1, `Listo: ${results.length} archivo${results.length === 1 ? '' : 's'}.${detalleFps}`);
    await entregarArchivos(results);

    toast('Exportación terminada.');
  } catch (err) {
    console.error(err);
    setBar(0, 'Se detuvo la exportación.');
    toast(textoDeError(err) || 'Algo falló al exportar. Probá con un video más corto.', true);
    clips.forEach(c => { if (c.status === 'exportando…') c.status = ''; });
    renderClipList();
  } finally {
    busy = false;
    $('renderOne').disabled = false;
    $('renderAll').disabled = false;
    $('reExport').disabled = false;
    $('reExport').textContent = 'Descargar con estos cambios';
    actualizarBotonPlay();
    setTimeout(() => { $('progressWrap').hidden = true; }, 6000);
  }
}

$('renderOne').addEventListener('click', () => {
  despertarAudio();
  const clip = currentClip();
  if (!clip) { toast('Elegí un archivo del lote.', true); return; }
  runExport([clip]);
});
$('renderAll').addEventListener('click', () => { despertarAudio(); runExport(state.clips); });

$('reExport').addEventListener('click', () => {
  despertarAudio();
  const clip = currentClip();
  if (!clip) { toast('Elegí un archivo del lote.', true); return; }
  if (!clip.cues.some(c => c.text.trim())) {
    toast('Escribí al menos una línea antes de exportar.', true);
    return;
  }
  runExport([clip]);
});


/* ============================================================
   PASO AUTOMÁTICO
   Detecta la franja del subtítulo quemado, la lee, la traduce
   y exporta el archivo listo. Un solo botón.
   ============================================================ */

let ocrWorker = null;

async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker('eng');
  return ocrWorker;
}

function seekTo(video, t) {
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.05));
    setTimeout(done, 900); // por si el navegador no dispara el evento
  });
}

/** Dilata una máscara binaria con sumas acumuladas (rápido). */
function dilate(src, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const pre = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const b = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[b + x];
    for (let x = 0; x < w; x++) {
      const a = x - r < 0 ? 0 : x - r;
      const c = x + r > w - 1 ? w - 1 : x + r;
      tmp[b + x] = (pre[c + 1] - pre[a]) > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  const pc = new Int32Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pc[y + 1] = pc[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = y - r < 0 ? 0 : y - r;
      const c = y + r > h - 1 ? h - 1 : y + r;
      out[y * w + x] = (pc[c + 1] - pc[a]) > 0 ? 1 : 0;
    }
  }
  return out;
}

const GCOLS = 32;

/**
 * Perfil de un cuadro: cuenta por fila y rejilla gruesa de "texto con borde"
 * (píxeles muy claros pegados a píxeles muy oscuros, como los subtítulos quemados).
 */
function frameProfile(cx, w, h) {
  const d = cx.getImageData(0, 0, w, h).data;
  const bright = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h);
  for (let i = 0, q = 0; i < d.length; i += 4, q++) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum > 225) bright[q] = 1;
    else if (lum < 75) dark[q] = 1;
  }
  const near = dilate(dark, w, h, 3);

  const rows = new Uint16Array(h);
  const grows = Math.ceil(h / 4);
  const grid = new Uint16Array(GCOLS * grows);
  let total = 0;

  for (let y = 0; y < h; y++) {
    const b = y * w;
    const gy = (y >> 2) * GCOLS;
    let n = 0;
    for (let x = 0; x < w; x++) {
      const q = b + x;
      if (bright[q] && near[q]) {
        n++;
        grid[gy + ((x * GCOLS / w) | 0)]++;
      }
    }
    rows[y] = n; total += n;
  }
  return { rows, grid, grows, total };
}

/** Recorre el video y devuelve la franja del subtítulo + el perfil de cada instante. */
async function scanClip(clip, onStep, maxFrames) {
  const SW = 320;
  const SH = Math.round(SW * clip.h / clip.w);
  const c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  const cx = c.getContext('2d', { willReadFrequently: true });

  const N = maxFrames || 40;
  const times = [];
  if (clip.isVideo) {
    const step = Math.max(0.25, clip.dur / N);
    for (let t = 0.05; t < clip.dur; t += step) times.push(t);
  } else times.push(0);

  const rowHits = new Float32Array(SH);
  const frames = [];

  for (let i = 0; i < times.length; i++) {
    if (clip.isVideo) await seekTo(clip.media, times[i]);
    cx.drawImage(clip.media, 0, 0, SW, SH);
    const prof = frameProfile(cx, SW, SH);
    for (let y = 0; y < SH; y++) if (prof.rows[y] > SW * 0.035) rowHits[y]++;
    frames.push({ t: times[i], grid: prof.grid, grows: prof.grows, total: prof.total });
    if (onStep && i % 4 === 0) onStep(i / times.length);
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0)); // no bloquear la interfaz
  }

  // Se agrupan las filas donde apareció texto. Un video puede tener varios
  // carteles a distintas alturas, así que se guardan todos los bloques y
  // no solo el más fuerte.
  const gap = Math.round(SH * 0.03);
  const armarBloques = (need) => {
    const groups = [];
    let run = null, blank = 0;
    for (let y = 0; y < SH; y++) {
      if (rowHits[y] >= need) {
        if (!run) run = { a: y, b: y, n: 0, peso: 0 };
        run.b = y; run.n++; run.peso += rowHits[y]; blank = 0;
      } else if (run) {
        blank++;
        if (blank > gap) { groups.push(run); run = null; blank = 0; }
      }
    }
    if (run) groups.push(run);
    return groups;
  };

  const flojo = Math.max(2, frames.length * 0.07);
  const firme = Math.max(1, frames.length * 0.25);

  let bloques = armarBloques(flojo);
  // si un bloque flojo abarca medio video, seguro agarró algo que no es texto
  if (!bloques.length || bloques.some(g => (g.b - g.a) > SH * 0.32)) {
    bloques = armarBloques(firme);
  }
  const need = flojo;

  let best = null;
  for (const g of bloques) if (!best || g.peso > best.peso) best = g;

  const aZona = (g) => {
    if (!g || g.b - g.a < 3) return null;
    const soft = need * 0.55;
    let a = g.a, b = g.b;
    const limit = Math.round(SH * 0.03);
    for (let k = 0; k < limit && a > 0 && rowHits[a - 1] >= soft; k++) a--;
    for (let k = 0; k < limit && b < SH - 1 && rowHits[b + 1] >= soft; k++) b++;

    const pad = Math.max(2, Math.round(SH * 0.008));
    a = Math.max(0, a - pad);
    b = Math.min(SH - 1, b + pad);

    let y = a / SH * 100;
    let h = (b - a) / SH * 100;
    if (h < 3.5) { const extra = (3.5 - h) / 2; y = Math.max(0, y - extra); h = 3.5; }
    return { y, h: Math.min(100 - y, h), peso: g.peso };
  };

  // se guardan las zonas con peso suficiente frente a la principal
  const corte = best ? best.peso * 0.12 : 0;
  const zones = bloques
    .filter(g => g.peso >= corte)
    .map(aZona)
    .filter(Boolean)
    .sort((p, q) => p.y - q.y);

  const band = zones.length ? aZona(best) : null;
  return { frames, band, zones, SW, SH };
}

/** Agrupa los cuadros en tramos que muestran el mismo texto. */
function segmentFrames(scan, clip, zona) {
  const { frames, SH } = scan;
  const grows = frames[0].grows;
  const band = zona || scan.band || { y: 55, h: 40 };
  const ga = Math.max(0, Math.floor(band.y / 100 * SH / 4));
  const gb = Math.min(grows, Math.ceil((band.y + band.h) / 100 * SH / 4));
  const cells = (gb - ga) * GCOLS;
  if (cells <= 0) return [];

  const sigs = frames.map(f => {
    const s = new Uint8Array(cells);
    let count = 0;
    for (let gy = ga; gy < gb; gy++) {
      for (let gx = 0; gx < GCOLS; gx++) {
        const v = f.grid[gy * GCOLS + gx];
        count += v;
        if (v > 2) s[(gy - ga) * GCOLS + gx] = 1;
      }
    }
    return { s, count };
  });

  const inked = sigs.map(x => x.count).filter(v => v > 0).sort((a, b) => a - b);
  const ref = inked.length ? inked[Math.floor(inked.length * 0.6)] : 0;
  const minInk = Math.max(40, ref * 0.25);

  const segs = [];
  let cur = null;
  for (let i = 0; i < frames.length; i++) {
    if (sigs[i].count < minInk) { if (cur) { segs.push(cur); cur = null; } continue; }
    if (!cur) { cur = { a: i, b: i }; continue; }
    let diff = 0;
    const prev = sigs[cur.b].s, now = sigs[i].s;
    for (let k = 0; k < cells; k++) if (prev[k] !== now[k]) diff++;
    if (diff / cells > 0.11) { segs.push(cur); cur = { a: i, b: i }; }
    else cur.b = i;
  }
  if (cur) segs.push(cur);

  const dur = clip.isVideo ? clip.dur : 0;
  const out = segs
    .map(s => ({
      start: Math.max(0, frames[s.a].t - 0.2),
      end: Math.min(dur, frames[s.b].t + 0.4),
      mid: frames[Math.floor((s.a + s.b) / 2)].t
    }))
    .filter(s => s.end - s.start > 0.4);

  // que no se pisen entre sí
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start - 0.02;
  }
  return out.filter(s => s.end > s.start);
}

function applyBand(band, zones) {
  if (!band && (!zones || !zones.length)) return;
  const lista = (zones && zones.length) ? zones : [band];

  // la franja abarca desde la primera hasta la última zona con texto;
  // en el modo "solo el texto" solo sirve como región de búsqueda
  const arriba = Math.min(...lista.map(z => z.y));
  const abajo = Math.max(...lista.map(z => z.y + z.h));

  state.cover.on = true;
  state.cover.zones = lista.map(z => ({ y: z.y, h: z.h }));
  state.cover.y = Math.round(arriba * 2) / 2;
  state.cover.h = Math.round((abajo - arriba) * 2) / 2;
  $('coverOn').checked = true;
  $('coverY').value = state.cover.y; $('coverYv').textContent = state.cover.y + '%';
  $('coverH').value = state.cover.h; $('coverHv').textContent = state.cover.h + '%';

  // el texto nuevo arranca donde arrancaba el original
  state.style.y = Math.round(arriba * 2) / 2;
  $('textY').value = state.style.y; $('textYv').textContent = state.style.y + '%';
}

/** Zonas a revisar: las detectadas, o la franja manual si no hay. */
function zonasActivas() {
  if (state.cover.zones && state.cover.zones.length) return state.cover.zones;
  return [{ y: state.cover.y, h: state.cover.h }];
}

/** Detección rápida al elegir un archivo, para que la franja caiga en su sitio sola. */
async function quickBand(clip) {
  if (clip.band !== undefined) { applyBand(clip.band, clip.zones); paint(); return; }
  clip.band = null;
  try {
    const scan = await scanClip(clip, null, 8);
    clip.band = scan.band;
    if (clip.isVideo) await seekTo(clip.media, clip.time);
    clip.zones = scan.zones;
    clip._masks = null; clip._maskSig = null;
    if (currentClip() === clip) { applyBand(scan.band, scan.zones); paint(); }
  } catch (e) { /* si falla, queda la franja manual */ }
}

async function ocrAt(clip, t, zona) {
  if (clip.isVideo) await seekTo(clip.media, t);
  const W = clip.w, H = clip.h;
  const by = (zona ? zona.y : 55) / 100 * H;
  const bh = (zona ? zona.h : 40) / 100 * H;

  const c = document.createElement('canvas');
  const scale = Math.min(3, 1400 / W);
  c.width = Math.round(W * scale);
  c.height = Math.round(bh * scale);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(clip.media, 0, by, W, bh, 0, 0, c.width, c.height);

  const img = cx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = lum > 205 ? 0 : 255;      // texto claro -> negro sobre blanco
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  cx.putImageData(img, 0, 0);

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(c);
  const texto = (data.text || '')
    .replace(/[|_~^`]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return textoCreible(texto) ? texto : '';
}

/**
 * Descarta lecturas que son ruido. Sin esto, un cartel chico o borroso
 * termina como subtítulo con cosas como "29 i!y".
 */
function textoCreible(t) {
  if (!t || t.length < 4) return false;
  const letras = (t.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  if (letras < 4) return false;
  if (letras / t.length < 0.5) return false;
  // al menos una palabra de verdad, no letras sueltas
  const palabras = t.split(/\s+/).filter(p => (p.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length >= 3);
  return palabras.length >= 1;
}

class TranslateError extends Error {
  constructor(msg) { super(msg); this.name = 'TranslateError'; }
}

async function translateMany(texts) {
  let res;
  try {
    res = await fetch('/.netlify/functions/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts })
    });
  } catch {
    throw new TranslateError('No hay conexión con el servicio de traducción.');
  }

  if (res.status === 404) {
    throw new TranslateError('La función de traducción no está publicada en el sitio. Subilo desde GitHub en vez de arrastrar el ZIP.');
  }

  let body = null;
  try { body = await res.json(); } catch { /* respuesta no JSON */ }

  if (!res.ok) {
    const detail = body && body.error ? body.error : `El servidor respondió ${res.status}.`;
    throw new TranslateError(detail);
  }
  if (!body || !Array.isArray(body.translations)) {
    throw new TranslateError('La traducción llegó en un formato que no se entiende.');
  }
  return body.translations;
}

/** Detecta, lee y traduce un archivo. Deja todo listo para exportar. */
async function autoPrepare(clip, report) {
  report('Buscando el subtítulo…', 0.05);
  const scan = await scanClip(clip, f => report('Revisando el video…', 0.05 + f * 0.25));
  clip.band = scan.band;
  clip.zones = scan.zones;
  applyBand(scan.band, scan.zones);

  // cada zona con texto se lee por separado: un video puede tener
  // un cartel arriba y otro en el medio, con mensajes distintos
  const zonas = (scan.zones && scan.zones.length) ? scan.zones : (scan.band ? [scan.band] : []);
  if (!zonas.length) throw new Error('sin-texto');

  const merged = [];
  let leidos = 0, total = 0;
  const porZona = [];

  for (const zona of zonas) {
    const segs = clip.isVideo
      ? segmentFrames(scan, clip, zona)
      : [{ start: 0, end: 0, mid: 0 }];
    porZona.push({ zona, segs });
    total += segs.length;
  }
  if (!total) throw new Error('sin-texto');

  // los momentos en que cambia algún texto: sirven para las siluetas
  // aunque el reconocimiento después no lea nada
  const cortes = new Set([0]);
  porZona.forEach(({ segs }) => segs.forEach(s => cortes.add(+s.start.toFixed(2))));
  const orden = [...cortes].sort((a, b) => a - b);
  clip._segPlan = orden.map((s, i) => ({
    start: s,
    end: i + 1 < orden.length ? orden[i + 1] : (clip.dur || s)
  })).filter(s => s.end > s.start);
  clip._masks = null; clip._maskSig = null;

  for (const { zona, segs } of porZona) {
    const deZona = [];
    for (const s of segs) {
      leidos++;
      report(`Leyendo el texto ${leidos} de ${total}…`, 0.3 + (leidos / total) * 0.3);
      const t = await ocrAt(clip, s.mid, zona);
      if (!t) continue;
      const prev = deZona[deZona.length - 1];
      if (prev && prev.text === t && s.start - prev.end < 1.2) prev.end = s.end;
      else deZona.push({ text: t, start: s.start, end: s.end, y: +zona.y.toFixed(1) });
    }
    merged.push(...deZona);
  }

  if (!merged.length) throw new Error('sin-texto');

  report('Traduciendo al español…', 0.62);
  const es = await translateMany(merged.map(m => m.text));

  if (clip.isVideo) await seekTo(clip.media, clip.time);

  clip.cues = merged
    .map((m, i) => ({
      text: es[i] || m.text,
      start: clip.isVideo ? +m.start.toFixed(2) : 0,
      end: clip.isVideo ? +m.end.toFixed(2) : 0,
      y: m.y
    }))
    .sort((a, b) => a.start - b.start || a.y - b.y);

  if (state.cover.on && coverUsesMask()) {
    report('Recortando el texto original…', 0.7);
    await prepararMascaras(clip);
  }
}

async function runAuto(clips) {
  if (busy) return;
  if (!clips.length) { toast('Primero cargá un video o una imagen.', true); return; }

  pausarVista();          // el exportador necesita el video para él solo
  busy = true;
  actualizarBotonPlay();  // recién ahora se ve apagado: pausarVista corre antes de busy
  $('results').hidden = true;
  const btn = $('autoRun');
  btn.disabled = true; btn.textContent = 'Trabajando…';
  $('renderOne').disabled = true; $('renderAll').disabled = true;

  const results = [];
  const fallos = [];
  let motivoTraduccion = null;

  try {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const tag = clips.length > 1 ? `(${i + 1}/${clips.length}) ` : '';
      const report = (msg, f) => setBar((i + f) / clips.length, tag + msg);

      clip.status = 'procesando…';
      renderClipList();

      try {
        await conLimiteDeTiempo(
          autoPrepare(clip, report),
          (clip.dur || 30) * 6000 + 120000,
          'La lectura del video tardó demasiado.'
        );
      } catch (err) {
        if (err.message === 'sin-texto') {
          fallos.push(`${clip.file.name}: no se encontró texto en pantalla`);
        } else if (err.name === 'TranslateError') {
          fallos.push(err.message);
          motivoTraduccion = err.message;
        } else {
          const detalle = textoDeError(err);
          fallos.push(detalle || `${clip.file.name}: no se pudo procesar`);
          motivoTraduccion = motivoTraduccion || detalle;
        }
        clip.status = 'revisar a mano';
        renderClipList();
        continue;
      }

      report('Armando el archivo…', 0.72);
      const out = await conLimiteDeTiempo(
        exportClip(clip, (m, f) => report(m, 0.72 + f * 0.26)),
        (clip.dur || 30) * 4000 + 90000,
        'El archivo tardó demasiado en armarse. Probá con un video más corto.'
      );
      results.push(out);
      clip.status = 'listo';
      renderClipList();
      if (state.sel === i) { renderStage(); }
    }

    if (!results.length) {
      setBar(0, 'No se pudo completar.');
      toast(motivoTraduccion || fallos[0] || 'No se encontró texto para traducir. Podés escribirlo a mano en la pestaña Texto.', true);
      return;
    }

    const detalleFps = ultimoFpsExport ? ` · ${ultimoFpsExport} cuadros/s` : '';
    setBar(1, `Listo: ${results.length} archivo${results.length === 1 ? '' : 's'}.${detalleFps}`);
    await entregarArchivos(results);

    toast(fallos.length
      ? `Descargados ${results.length}. Quedaron ${fallos.length} para revisar a mano.`
      : 'Descarga lista. Revisá el resultado y retocá si hace falta.');
  } catch (err) {
    console.error(err);
    setBar(0, 'Se detuvo el proceso.');
    toast('Algo falló. Probá con un video más corto, o hacelo por pasos en las otras pestañas.', true);
    clips.forEach(c => { if (c.status === 'procesando…') c.status = ''; });
    renderClipList();
  } finally {
    busy = false;
    btn.disabled = false; btn.textContent = 'Traducir y descargar';
    $('renderOne').disabled = false; $('renderAll').disabled = false;
    $('reExport').disabled = false;
    actualizarBotonPlay();
    setTimeout(() => { $('progressWrap').hidden = true; }, 7000);
  }
}

$('autoRun').addEventListener('click', () => { despertarAudio(); runAuto(state.clips); });


/* ============================================================
   MOTOR DIRECTO (iPhone / iPad)
   Safari no aguanta bien FFmpeg en WebAssembly, así que en iOS
   el video se arma reproduciéndolo y grabando el lienzo.
   Tarda lo que dura el clip, pero funciona.
   ============================================================ */

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function liveSupported() {
  return typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function recorderMime() {
  const opciones = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const m of opciones) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * Medidas del archivo final. Un cuadro de 1080x1920 son dos millones de
 * píxeles que hay que copiar Y comprimir treinta veces por segundo; medido en
 * un iPhone, ahí salían 14 cuadros por segundo. Topando el lado largo es
 * menos de la mitad de trabajo y el video sale parejo. Para TikTok/Reels
 * 720x1280 es tamaño de sobra: lo reencodifican igual.
 */
function medidasDeSalida(clip) {
  let w = clip.w, h = clip.h;
  const tope = state.exportLado;
  const largo = Math.max(w, h);
  if (tope && largo > tope) {
    const k = tope / largo;
    // pares: H.264 no acepta dimensiones impares
    w = Math.max(2, Math.round(w * k / 2) * 2);
    h = Math.max(2, Math.round(h * k / 2) * 2);
  }
  return { w, h, escalado: w !== clip.w || h !== clip.h };
}

async function exportVideoLive(clip, report) {
  const { w: W, h: H } = medidasDeSalida(clip);
  const v = clip.media;
  const dur = clip.dur;

  try { v.pause(); } catch (e) { /* no estaba reproduciendo */ }

  if (state.cover.on && coverUsesMask()) {
    if (report) report('Ubicando el texto original…', 0.02);
    await prepararMascaras(clip);
  }

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  // el lienzo debe estar en la página: si queda suelto, algunos navegadores
  // no lo componen y la grabación sale con saltos
  cv.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:4px;opacity:.01;pointer-events:none;z-index:-1';
  document.body.appendChild(cv);
  // sin canal alfa: el cuadro del video tapa todo el lienzo igual, y así el
  // navegador compone y codifica bastante más rápido
  const cx = cv.getContext('2d', { alpha: false });

  const mime = recorderMime();
  if (!mime) throw new Error('Este navegador no puede grabar video.');

  // el navegador captura el lienzo a 30 por segundo; nosotros solo lo mantenemos pintado
  const stream = cv.captureStream(30);

  // ---- audio ----
  // El elemento de video se queda mudo SIEMPRE: es la única forma de que
  // Safari deje reproducirlo sin que el dedo esté encima. El sonido del
  // resultado sale del archivo de voz, que se mezcla aparte.
  v.muted = true;
  v.defaultMuted = true;
  v.volume = 0;

  const mode = state.audio.mode;
  const conVoz = (mode === 'voice' || mode === 'mix') && !!clip.voice;
  // el audio del video se saca decodificando el archivo, no del elemento:
  // así el video reproduce mudo y Safari nunca bloquea nada
  const conOriginal = !state.audio.mute && (mode === 'keep' || mode === 'mix' || !conVoz);

  let ac = null, voiceSrc = null, musicSrc = null, avisoSinAudio = false;

  if (!state.audio.mute && (conVoz || conOriginal) && audioCtx && audioCtx.state === 'running') {
    ac = audioCtx;

    // decodificar nunca puede colgar la app: si tarda, se sigue sin esa pista
    const decodificar = async (blob, guardarEn) => {
      if (guardarEn && clip[guardarEn]) return clip[guardarEn];
      const datos = await Promise.race([
        blob.arrayBuffer(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 15000))
      ]);
      const buf = await Promise.race([
        ac.decodeAudioData(datos),
        new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 15000))
      ]);
      if (guardarEn) clip[guardarEn] = buf;
      return buf;
    };

    try {
      const dest = ac.createMediaStreamDestination();
      let algo = false;

      if (conOriginal) {
        try {
          const buf = await decodificar(clip.file, '_audioBuf');
          musicSrc = ac.createBufferSource();
          musicSrc.buffer = buf;
          const g = ac.createGain();
          g.gain.value = (mode === 'mix' && conVoz) ? state.audio.musicVol / 100 : 1;
          musicSrc.connect(g); g.connect(dest);
          algo = true;
        } catch (e) {
          musicSrc = null;
          avisoSinAudio = true;   // sin pista de audio legible en ese archivo
        }
      }

      if (conVoz) {
        try {
          const buf = await decodificar(clip.voice, null);
          voiceSrc = ac.createBufferSource();
          voiceSrc.buffer = buf;
          const g = ac.createGain();
          g.gain.value = 1;
          voiceSrc.connect(g); g.connect(dest);
          algo = true;
        } catch (e) { voiceSrc = null; }
      }

      if (algo) dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      else ac = null;
    } catch (e) { ac = null; }
  } else if (!state.audio.mute && (conVoz || conOriginal)) {
    avisoSinAudio = true;
  }

  // ---- grabación ----
  // ritmo de datos acorde al tamaño: pedirle 6 Mbps a un cuadro chico solo
  // le da trabajo de más al codificador sin que se vea mejor
  const bits = Math.min(8000000, Math.max(3500000, Math.round(W * H * 30 * 0.12)));

  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits });
  } catch (e) {
    try { rec = new MediaRecorder(stream); }
    catch (e2) { cv.remove(); throw new Error('Este navegador no dejó iniciar la grabación del video.'); }
  }
  const trozos = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) trozos.push(e.data); };
  const grabado = new Promise(r => { rec.onstop = r; });

  let dibujando = true;
  let cuadros = 0;
  let rafId = null;
  let wake = null;

  // Cada línea y el logo se dibujan UNA sola vez a su propia imagen. Durante la
  // grabación solo se pegan, ya listos. Antes se medía, se partía en renglones y
  // se trazaba el texto en cada cuadro: ese trabajo repetido era lo que hacía
  // que al reproductor le faltaran cuadros y el video se viera con tirones.
  const capasTexto = [];
  for (const cue of clip.cues) {
    if (!cue.text.trim()) continue;
    const ov = cueOverlay(clip, cue, W, H);
    if (!ov) continue;
    // mismo criterio que el motor de escritorio: sin "hasta" válido, hasta el final
    capasTexto.push({
      start: Math.max(0, cue.start),
      end: Math.min(dur, cue.end > cue.start ? cue.end : dur),
      canvas: ov.canvas, x: ov.x, y: ov.y
    });
  }

  let capaLogo = null;
  if (state.logo.on && state.logo.img && state.logo.img.naturalWidth) {
    const caja = logoBox(W, H);
    if (caja) {
      const lc = document.createElement('canvas');
      lc.width = caja.w; lc.height = caja.h;
      const lcx = lc.getContext('2d');
      lcx.globalAlpha = Math.max(0, Math.min(1, state.logo.opacity / 100));
      lcx.drawImage(state.logo.img, 0, 0, caja.w, caja.h);
      capaLogo = { canvas: lc, x: caja.x, y: caja.y };
    }
  }

  let ultimoPintado = 0;

  const pintarUno = () => {
    // se marca al EMPEZAR: si se marcara al terminar, el tiempo que tarda el
    // dibujo se sumaría al límite de abajo y el ritmo caería solo
    ultimoPintado = performance.now();
    try {
      const t = v.currentTime;
      cx.drawImage(v, 0, 0, W, H);
      drawCover(cx, v, W, H, clip, t);
      for (const capa of capasTexto) {
        if (t >= capa.start && t <= capa.end) cx.drawImage(capa.canvas, capa.x, capa.y);
      }
      if (capaLogo) cx.drawImage(capaLogo.canvas, capaLogo.x, capaLogo.y);
      cuadros++;
    } catch (e) { /* un cuadro perdido no rompe nada */ }
  };

  // Motor de dibujo, atado al refresco de la pantalla. Se pinta más seguido
  // que la captura (30 por segundo) para que nunca encuentre el lienzo viejo:
  // si un dibujo se demora, el navegador reusa el anterior en vez de dejar un
  // hueco. Probado con captura a demanda (requestFrame) y limitando a 30: bajo
  // carga rendía peor, porque cada dibujo demorado se perdía como cuadro.
  const bucle = () => {
    if (!dibujando) return;
    pintarUno();
    rafId = requestAnimationFrame(bucle);
  };

  // Red de seguridad: si el refresco se frena (la pantalla se atenúa, el
  // sistema baja la prioridad de la pestaña), el dibujo se detiene y el
  // archivo queda con un cuadro congelado de varios segundos. Este vigilante
  // pinta igual cuando pasó demasiado tiempo sin dibujar nada.
  let vigilante = setInterval(() => {
    if (dibujando && performance.now() - ultimoPintado > 120) pintarUno();
  }, 100);

  try {
    if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen');
  } catch (e) { /* si no se puede, seguimos */ }

  // ---- precalentamiento ----
  // Medido en el archivo de un iPhone: los primeros 3,5 segundos salían a ~7
  // cuadros por segundo y después el video levantaba solo a ~29. Es el
  // decodificador arrancando, el lienzo estrenándose y el código
  // compilándose, todo mientras ya se estaba grabando. Así que primero se
  // reproduce un momento en vano, y recién con todo caliente se graba.
  await seekTo(v, 0);
  for (let i = 0; i < 5; i++) pintarUno();   // compila el pintado
  try {
    await v.play();
    const finCalentado = performance.now() + 600;
    while (performance.now() < finCalentado) {
      pintarUno();
      await new Promise(r => requestAnimationFrame(r));
    }
    v.pause();
  } catch (e) { /* si no dejó reproducir acá, se reintenta abajo */ }
  await seekTo(v, 0);
  pintarUno();          // primer cuadro para que el archivo no empiece en negro
  rafId = requestAnimationFrame(bucle);
  cuadros = 0;          // lo de recién no cuenta: todavía no se grababa

  const abortar = async (msg) => {
    dibujando = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (vigilante) { clearInterval(vigilante); vigilante = null; }
    try { v.pause(); } catch (e) { /* ya detenido */ }
    try { rec.stop(); } catch (e) { /* ya detenido */ }
    await Promise.race([grabado, new Promise(r => setTimeout(r, 3000))]);
    if (wake) { try { await wake.release(); } catch (e) { /* ya liberado */ } }
    cv.remove();
    throw new Error(msg);
  };

  try {
    await v.play();
  } catch (e) {
    await abortar('Safari no dejó reproducir el video. Tocá "Traducir y descargar" otra vez sin cambiar de app.');
  }

  // Se graba recién cuando el video ya está rodando. Si se arrancaba antes,
  // el principio quedaba congelado esperando a que Safari largara la
  // reproducción, y el audio entraba corrido respecto a la imagen.
  // Sin trocear: cada volcado de datos frenaba un instante al grabador y ahí
  // se perdía un cuadro. Al parar se entrega todo junto igual.
  rec.start();

  if (ac) {
    const t0 = ac.currentTime + 0.03;
    if (musicSrc) { try { musicSrc.start(t0); } catch (e) { /* sin música */ } }
    if (voiceSrc) { try { voiceSrc.start(t0 + state.audio.voiceDelay); } catch (e) { /* sin voz */ } }
  }

  // espera con vigilancia: si el video no avanza, se corta en vez de colgarse
  const limiteTotal = (dur || 30) * 3000 + 25000;
  const arranque = Date.now();
  let ultimoT = -1, ultimoAvance = Date.now();

  const motivo = await new Promise(resolve => {
    const tic = setInterval(() => {
      const t = v.currentTime;
      if (report && dur) report('Armando el archivo…', Math.min(0.98, t / dur));

      if (t > ultimoT + 0.02) { ultimoT = t; ultimoAvance = Date.now(); }

      if (v.ended || (dur && t >= dur - 0.08)) { clearInterval(tic); resolve(null); }
      else if (Date.now() - ultimoAvance > 8000) { clearInterval(tic); resolve('atascado'); }
      else if (Date.now() - arranque > limiteTotal) { clearInterval(tic); resolve('lento'); }
    }, 250);
    v.addEventListener('ended', () => { clearInterval(tic); resolve(null); }, { once: true });
  });

  if (motivo === 'atascado' && ultimoT < 0.5) {
    await abortar('El video no arrancó. Volvé a tocar el botón con la pantalla encendida y esta pestaña al frente.');
  }
  // si se atascó a mitad de camino, igual guardamos lo grabado hasta ahí

  await new Promise(r => setTimeout(r, 400));   // el último trozo
  dibujando = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (vigilante) { clearInterval(vigilante); vigilante = null; }
  try { v.pause(); } catch (e) { /* ya estaba detenido */ }
  if (voiceSrc) { try { voiceSrc.stop(); } catch (e) { /* ya terminó */ } }
  if (musicSrc) { try { musicSrc.stop(); } catch (e) { /* ya terminó */ } }
  try { rec.stop(); } catch (e) { /* ya detenido */ }
  await Promise.race([grabado, new Promise(r => setTimeout(r, 6000))]);
  if (wake) { try { await wake.release(); } catch (e) { /* ya liberado */ } }
  cv.remove();
  clip._srcNode = null;

  // se pinta al ritmo de la pantalla (~60/s) para alimentar sobrado la captura
  // de 30; por debajo de 18 el resultado ya se nota entrecortado
  // Se guarda para poder mostrarlo: si el video sale trabado, este número dice
  // si fue el teléfono que no alcanzó a dibujar o si el problema es otro.
  const fps = dur ? cuadros / dur : 60;
  // el archivo se graba a 30 como mucho; se informa lo que realmente quedó
  ultimoFpsExport = Math.min(30, Math.round(fps));
  if (fps < 20) {
    toast(`El teléfono solo alcanzó ${Math.round(fps)} cuadros por segundo, por eso puede verse trabado. Probá bajando la calidad a "Suave" en la pestaña Audio, con la pantalla encendida y otras apps cerradas.`, true);
  }

  if (avisoSinAudio) toast('No se pudo copiar el audio de ese archivo; el video quedó sin sonido.', true);

  if (!trozos.length) throw new Error('No se grabó nada. Volvé a intentar con la pantalla encendida.');

  const blob = new Blob(trozos, { type: mime });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  return {
    name: baseName(clip.file.name) + '-es.' + ext,
    data: new Uint8Array(await blob.arrayBuffer())
  };
}

function esMovil() {
  return IS_IOS || /Android/i.test(navigator.userAgent) ||
    window.matchMedia('(pointer:coarse)').matches;
}

/** Elige el motor según el dispositivo. */
async function exportClip(clip, report) {
  if (!clip.isVideo) return exportImage(clip);

  if (esMovil()) {
    if (!liveSupported()) {
      throw new Error('Este navegador no puede armar videos. Actualizá iOS/Safari o usá el computador.');
    }
    setEngine('modo directo', 'chip-ready');
    try {
      return await exportVideoLive(clip, report);
    } catch (err) {
      // el audio es la parte más frágil en Safari: se reintenta sin él
      if (state.audio.mute) throw err;
      const antes = state.audio.mute;
      state.audio.mute = true;
      try {
        const salida = await exportVideoLive(clip, report);
        toast('Hubo un problema con el audio, así que el video salió sin sonido.', true);
        return salida;
      } finally {
        state.audio.mute = antes;
      }
    }
  }

  try {
    return await exportVideo(clip);
  } catch (err) {
    if (liveSupported()) {
      toast('El motor rápido no arrancó. Armando el video en modo directo.');
      return exportVideoLive(clip, report);
    }
    throw err;
  }
}

/* ---------------- pestañas (celular) ---------------- */

function isPhone() { return window.matchMedia('(max-width: 899px)').matches; }

function goTab(name) {
  document.body.dataset.tab = name;
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.go === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'true' : 'false');
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
  requestAnimationFrame(paint);
}

document.querySelectorAll('.tab').forEach(b => {
  b.addEventListener('click', () => goTab(b.dataset.go));
});

window.addEventListener('resize', () => {
  $('mobileNote').hidden = !isPhone();
  paint();
});

/* ---------------- arranque ---------------- */

document.fonts.ready.then(() => paint());
renderClipList();
renderStage();
actualizarBotonPlay();
setEngine('en espera', 'chip-idle');
$('mobileNote').hidden = !isPhone();
goTab('lote');
