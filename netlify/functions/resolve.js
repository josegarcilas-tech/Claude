const TIKTOK_URL_REGEX = /https?:\/\/(www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;

function normalizeUrl(rawUrl) {
  const match = rawUrl.match(TIKTOK_URL_REGEX);
  return match ? match[0] : null;
}

async function resolveRedirect(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.url || url;
  } catch {
    return url;
  }
}

async function fetchFromTikwm(tiktokUrl) {
  const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
  const res = await fetch(endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokDownloader/1.0)' },
  });
  if (!res.ok) throw new Error(`tikwm respondió ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(json.msg || 'No se pudo procesar el video');
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

  try {
    const finalUrl = await resolveRedirect(cleanUrl);
    const data = await fetchFromTikwm(finalUrl);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
  } catch (err) {
    console.error('Error resolviendo video:', err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'No se pudo obtener el video. Intenta de nuevo en unos segundos.' }),
    };
  }
};
