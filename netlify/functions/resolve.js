const TIKTOK_URL_REGEX = /https?:\/\/(www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;

function normalizeUrl(rawUrl) {
  const match = rawUrl.match(TIKTOK_URL_REGEX);
  return match ? match[0] : null;
}

async function conTiempoLimite(promesa, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promesa(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resuelve enlaces cortos (vt.tiktok.com / vm.tiktok.com) a su URL final.
 * Algunos servidores de TikTok no responden bien a HEAD, así que se
 * prueba con GET si hace falta; si nada funciona, se sigue con el
 * enlace original — tikwm suele poder resolverlo por su cuenta igual.
 */
async function resolveRedirect(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await conTiempoLimite(
        (signal) => fetch(url, {
          method,
          redirect: 'follow',
          signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokDownloader/1.0)' },
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TikTokDownloader/1.0)',
          'Referer': 'https://www.tikwm.com/',
        },
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

  if (json.code !== 0 || !json.data) {
    throw new Error(mensajeDeTikwm(json.msg));
  }

  const d = json.data;
  const base = 'https://www.tikwm.com';
  const abs = (p) => (p ? (p.startsWith('http') ? p : base + p) : null);

  return {
    id: d.id,
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

/** Traduce los mensajes típicos de tikwm a algo más claro; si no reconoce ninguno, deja el original. */
function mensajeDeTikwm(msg) {
  const m = (msg || '').toLowerCase();
  if (!msg) return 'No se pudo procesar ese video.';
  if (m.includes('not exist') || m.includes('not found')) {
    return 'Ese video no existe o ya no está disponible.';
  }
  if (m.includes('private') || m.includes('permission')) {
    return 'Ese video es privado; no se puede descargar.';
  }
  if (m.includes('limit') || m.includes('frequent') || m.includes('too many')) {
    return 'El servicio de descarga está saturado ahora mismo. Probá de nuevo en un minuto.';
  }
  if (m.includes('failed to fetch') || m.includes('try again') || m.includes('another link')) {
    return 'TikTok no dejó traer ese video justo ahora. Probá de nuevo en unos segundos, o pegá el enlace completo (abrí el video en la app de TikTok, tocá Compartir → Copiar enlace).';
  }
  return msg;
}

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

  const cleanUrl = normalizeUrl(raw);
  if (!cleanUrl) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Eso no parece un enlace de TikTok válido.' }),
    };
  }

  // primero se prueba con el enlace tal cual: tikwm suele resolver los
  // enlaces cortos por su cuenta. Si falla, se intenta resolver el
  // redirect nosotros mismos y se reintenta una vez con esa URL.
  let ultimoError = null;
  try {
    const data = await fetchFromTikwm(cleanUrl);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
  } catch (err) {
    ultimoError = err;
  }

  try {
    const finalUrl = await resolveRedirect(cleanUrl);
    if (finalUrl && finalUrl !== cleanUrl) {
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
