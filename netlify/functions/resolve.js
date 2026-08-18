/**
 * Resuelve el enlace directo de un video de TikTok o de Instagram.
 *
 * TikTok pasa por tikwm.com, que devuelve la versión sin marca de agua.
 * Instagram no tiene un servicio equivalente sin llave, así que se lee la
 * propia página pública del post y se saca la URL del video de ahí. Funciona
 * con posts públicos; los privados no se pueden y se avisa como corresponde.
 */

const TIKTOK_URL_REGEX = /https?:\/\/(www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
const INSTAGRAM_URL_REGEX = /https?:\/\/(www\.|m\.)?instagram\.com\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+/i;

const UA_NAVEGADOR =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function queSitio(raw) {
  const ig = raw.match(INSTAGRAM_URL_REGEX);
  if (ig) return { sitio: 'instagram', url: ig[0] };
  const tt = raw.match(TIKTOK_URL_REGEX);
  if (tt) return { sitio: 'tiktok', url: tt[0] };
  return null;
}

async function conTiempoLimite(hacer, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await hacer(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- TikTok ---------------- */

async function resolveRedirect(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await conTiempoLimite(
        (signal) => fetch(url, {
          method,
          redirect: 'follow',
          signal,
          headers: { 'User-Agent': UA_NAVEGADOR },
        }),
        8000
      );
      if (res.url) return res.url;
    } catch { /* se prueba el siguiente método */ }
  }
  return url;
}

async function fetchFromTikwm(tiktokUrl) {
  const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
  let res;
  try {
    res = await conTiempoLimite(
      (signal) => fetch(endpoint, {
        signal,
        headers: { 'User-Agent': UA_NAVEGADOR, 'Referer': 'https://www.tikwm.com/' },
      }),
      9000
    );
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('El servicio de descarga tardó demasiado en responder.');
    throw new Error('No se pudo conectar con el servicio de descarga.');
  }

  if (!res.ok) throw new Error(`El servicio de descarga respondió ${res.status}.`);

  let json;
  try { json = await res.json(); }
  catch { throw new Error('El servicio de descarga devolvió algo que no se pudo leer.'); }

  if (json.code !== 0 || !json.data) throw new Error(mensajeDeTikwm(json.msg));

  const d = json.data;
  const base = 'https://www.tikwm.com';
  const abs = (p) => (p ? (p.startsWith('http') ? p : base + p) : null);

  return {
    id: d.id,
    fuente: 'tiktok',
    title: d.title || '',
    author: {
      username: d.author?.unique_id || '',
      nickname: d.author?.nickname || '',
      avatar: abs(d.author?.avatar),
    },
    cover: abs(d.cover || d.origin_cover),
    duration: d.duration || null,
    music: d.music ? { title: d.music_info?.title || '', url: abs(d.music) } : null,
    stats: {
      plays: d.play_count,
      likes: d.digg_count,
      comments: d.comment_count,
      shares: d.share_count,
    },
    downloads: {
      noWatermark: abs(d.hdplay || d.play),
      watermark: abs(d.wmplay),
      audio: abs(d.music),
    },
  };
}

function mensajeDeTikwm(msg) {
  const m = (msg || '').toLowerCase();
  if (!msg) return 'No se pudo procesar ese video.';
  if (m.includes('not exist') || m.includes('not found')) return 'Ese video no existe o ya no está disponible.';
  if (m.includes('private') || m.includes('permission')) return 'Ese video es privado; no se puede descargar.';
  if (m.includes('limit') || m.includes('frequent') || m.includes('too many')) {
    return 'El servicio de descarga está saturado ahora mismo. Probá de nuevo en un minuto.';
  }
  if (m.includes('failed to fetch') || m.includes('try again') || m.includes('another link')) {
    return 'TikTok no dejó traer ese video justo ahora. Probá de nuevo en unos segundos, o pegá el enlace completo (abrí el video en la app, tocá Compartir → Copiar enlace).';
  }
  return msg;
}

/* ---------------- Instagram ---------------- */

function codigoDeInstagram(url) {
  const m = url.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function desescapar(s) {
  if (!s) return s;
  return s
    .replace(/\\u0026/gi, '&')
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

/** Saca la URL del video de cualquier página de Instagram, venga como venga. */
function buscarVideoEnHtml(html) {
  const patrones = [
    /"video_url"\s*:\s*"([^"]+)"/,
    /"playback_url"\s*:\s*"([^"]+)"/,
    /property=["']og:video["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:video["']/i,
    /"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/,
    /(https:\/\/[^"'\s\\]+\.fbcdn\.net\/[^"'\s\\]+\.mp4[^"'\s\\]*)/,
  ];
  for (const re of patrones) {
    const m = html.match(re);
    if (m && m[1]) {
      const url = desescapar(m[1]);
      if (/^https:\/\//i.test(url)) return url;
    }
  }
  return null;
}

function buscarPortadaEnHtml(html) {
  const patrones = [
    /property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /"display_url"\s*:\s*"([^"]+)"/,
    /"thumbnail_src"\s*:\s*"([^"]+)"/,
  ];
  for (const re of patrones) {
    const m = html.match(re);
    if (m && m[1]) return desescapar(m[1]);
  }
  return null;
}

async function pedirTexto(url, extra) {
  const res = await conTiempoLimite(
    (signal) => fetch(url, {
      signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA_NAVEGADOR,
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        ...(extra || {}),
      },
    }),
    9000
  );
  if (!res.ok) return { ok: false, status: res.status, texto: '' };
  return { ok: true, status: res.status, texto: await res.text() };
}

/**
 * Los códigos de los enlaces (el "DxAbC_1" de /reel/DxAbC_1/) son el número
 * interno del post escrito en base 64 con este alfabeto. Convertirlo permite
 * preguntar por el post directamente, que es lo que mejor funciona.
 */
const ALFABETO_IG = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function idDeMedioInstagram(code) {
  let id = 0n;
  for (const ch of code) {
    const i = ALFABETO_IG.indexOf(ch);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  return id > 0n ? id.toString() : null;
}

/** Saca el video de la respuesta del endpoint de medios. */
function videoDeJsonInstagram(json) {
  const item = json && Array.isArray(json.items) && json.items[0];
  if (!item) return null;

  const deUno = (m) => {
    const vs = m && m.video_versions;
    if (!Array.isArray(vs) || !vs.length) return null;
    // el primero suele ser el de mayor calidad; por las dudas, el más ancho
    const mejor = vs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return mejor && mejor.url ? mejor.url : null;
  };

  let url = deUno(item);
  if (!url && Array.isArray(item.carousel_media)) {
    for (const m of item.carousel_media) {
      url = deUno(m);
      if (url) break;
    }
  }
  if (!url) return null;

  const cand = item.image_versions2 && item.image_versions2.candidates;
  return {
    url,
    portada: Array.isArray(cand) && cand.length ? cand[0].url : null,
    usuario: (item.user && item.user.username) || '',
    titulo: (item.caption && item.caption.text) || '',
    duracion: item.video_duration || null,
  };
}

async function pedirJson(url, extra) {
  const res = await conTiempoLimite(
    (signal) => fetch(url, {
      signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA_NAVEGADOR,
        'Accept': '*/*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        ...(extra || {}),
      },
    }),
    9000
  );
  if (!res.ok) return { ok: false, status: res.status, json: null };
  try { return { ok: true, status: res.status, json: await res.json() }; }
  catch { return { ok: false, status: res.status, json: null }; }
}

async function fetchDeInstagram(postUrl) {
  const code = codigoDeInstagram(postUrl);
  if (!code) throw new Error('No se reconoce el enlace de Instagram. Copiá el enlace del post o del reel.');

  const limpio = `https://www.instagram.com/p/${code}/`;
  const mediaId = idDeMedioInstagram(code);
  const diag = [];   // queda en el mensaje de error: sin esto no hay forma de saber qué falló
  let portada = null;
  let esFoto = false;

  const armar = (url, extra) => ({
    id: code,
    fuente: 'instagram',
    title: (extra && extra.titulo) || '',
    author: { username: (extra && extra.usuario) || '', nickname: '', avatar: null },
    cover: (extra && extra.portada) || portada,
    duration: (extra && extra.duracion) || null,
    music: null,
    stats: {},
    downloads: { noWatermark: url, watermark: null, audio: null },
  });

  // 1) el endpoint de medios: es el que mejor anda sin sesión iniciada
  if (mediaId) {
    const cabeceras = {
      'x-ig-app-id': '936619743392459',
      'Referer': limpio,
      'Origin': 'https://www.instagram.com',
    };
    for (const host of ['https://www.instagram.com', 'https://i.instagram.com']) {
      const via = `${host}/api/v1/media/${mediaId}/info/`;
      let r;
      try { r = await pedirJson(via, cabeceras); }
      catch (err) { diag.push(`api:${err.name === 'AbortError' ? 'lento' : 'error'}`); continue; }
      if (!r.ok) { diag.push(`api:${r.status}`); continue; }

      const dato = videoDeJsonInstagram(r.json);
      if (dato) return armar(dato.url, dato);

      const item = r.json && Array.isArray(r.json.items) && r.json.items[0];
      if (item && !item.video_versions && !item.carousel_media) esFoto = true;
      diag.push('api:sin-video');
    }
  }

  // 2) leer la página pública, por si el endpoint estuviera cerrado
  const paginas = [
    `https://www.instagram.com/reel/${code}/embed/captioned/`,
    `https://www.instagram.com/p/${code}/embed/captioned/`,
    limpio,
  ];
  for (const via of paginas) {
    let r;
    try { r = await pedirTexto(via); }
    catch (err) { diag.push(`web:${err.name === 'AbortError' ? 'lento' : 'error'}`); continue; }
    if (!r.ok) { diag.push(`web:${r.status}`); continue; }

    if (!portada) portada = buscarPortadaEnHtml(r.texto);
    const video = buscarVideoEnHtml(r.texto);
    if (video) return armar(video, null);

    if (/og:image/i.test(r.texto) && !/og:video/i.test(r.texto)) esFoto = true;
    diag.push('web:sin-video');
  }

  if (esFoto) throw new Error('Ese post de Instagram es una foto, no un video.');

  const detalle = diag.length ? ` (${diag.join(', ')})` : '';
  if (diag.some(d => d.endsWith(':404'))) {
    throw new Error('Ese post de Instagram no existe o fue borrado.' + detalle);
  }
  if (diag.some(d => d.endsWith(':401') || d.endsWith(':403'))) {
    throw new Error('Instagram pidió iniciar sesión para ver ese post, así que no se puede traer desde acá. Suele pasar con cuentas privadas y con los bloqueos que Instagram le pone a los servidores. Guardá el video en tu teléfono y subilo con "Elegí tus videos".' + detalle);
  }
  throw new Error('Instagram no entregó el video; bloquea bastante las descargas automáticas. Guardá el video en tu teléfono y subilo con "Elegí tus videos o imágenes".' + detalle);
}

/* ---------------- handler ---------------- */

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let raw = '';
  try {
    raw = (JSON.parse(event.body || '{}').url || '').trim();
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cuerpo de la petición inválido.' }) };
  }

  if (!raw) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta la URL del video.' }) };
  }

  const destino = queSitio(raw);
  if (!destino) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Eso no parece un enlace de TikTok ni de Instagram.' }),
    };
  }

  if (destino.sitio === 'instagram') {
    try {
      const data = await fetchDeInstagram(destino.url);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
    } catch (err) {
      console.error('Instagram:', err.message);
      return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // TikTok: primero el enlace tal cual (tikwm resuelve los cortos por su
  // cuenta); si falla, se resuelve el redirect acá y se reintenta una vez.
  let ultimoError = null;
  try {
    const data = await fetchFromTikwm(destino.url);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
  } catch (err) {
    ultimoError = err;
  }

  try {
    const finalUrl = await resolveRedirect(destino.url);
    if (finalUrl && finalUrl !== destino.url) {
      const data = await fetchFromTikwm(finalUrl);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
    }
  } catch (err) {
    ultimoError = err;
  }

  console.error('Error resolviendo video:', ultimoError && ultimoError.message);
  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({
      error: (ultimoError && ultimoError.message) || 'No se pudo obtener el video. Intentá de nuevo en unos segundos.',
    }),
  };
};
