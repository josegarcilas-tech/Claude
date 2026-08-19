// Edge Function (runtime Deno, no Node): corre en la red de Deno Deploy, con
// rangos de IP distintos a los de AWS donde viven las Netlify Functions
// normales. Instagram bloquea las IPs de AWS de forma mucho mas agresiva, asi
// que esta ruta tiene mas posibilidades de pasar sin cookie de sesion.
//
// Es codigo aparte a proposito: aqui no hay require ni cheerio, asi que el
// parseo se hace con expresiones regulares sobre el HTML crudo.

const INSTAGRAM_URL_RE = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CRAWLER_UA =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const IG_WEB_APP_ID = '936619743392459';

const FETCH_TIMEOUT_MS = 8000;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unescapeJsonString(value) {
  return value
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

/** Lee una meta etiqueta og: sin depender del orden de los atributos. */
function readMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return match[1].replace(/&amp;/g, '&');
  }
  return null;
}

function parseVideoFromHtml(html) {
  let videoUrl = readMeta(html, 'og:video') || readMeta(html, 'og:video:secure_url');

  if (!videoUrl) {
    const inline = /<video[^>]+src=["'](https:[^"']+)["']/i.exec(html);
    if (inline) videoUrl = inline[1];
  }

  if (!videoUrl) {
    for (const pattern of [
      /"video_url"\s*:\s*"([^"]+)"/,
      /"playback_url"\s*:\s*"([^"]+)"/,
      /"src"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/,
    ]) {
      const match = pattern.exec(html);
      if (match) {
        videoUrl = unescapeJsonString(match[1]);
        break;
      }
    }
  }

  if (!videoUrl) return null;

  const displayUrl = /"display_url"\s*:\s*"([^"]+)"/.exec(html);

  return {
    videoUrl: unescapeJsonString(videoUrl),
    thumbnailUrl:
      readMeta(html, 'og:image') ||
      (displayUrl ? unescapeJsonString(displayUrl[1]) : null),
    title: readMeta(html, 'og:title') || '',
  };
}

function parseVideoFromApiJson(payload) {
  const media =
    payload?.data?.xdt_shortcode_media ||
    payload?.graphql?.shortcode_media ||
    payload?.items?.[0];

  if (!media) return null;

  const videoUrl = media.video_url || media.video_versions?.[0]?.url;
  if (!videoUrl) return null;

  return {
    videoUrl,
    thumbnailUrl:
      media.display_url || media.image_versions2?.candidates?.[0]?.url || null,
    title:
      media.edge_media_to_caption?.edges?.[0]?.node?.text ||
      media.caption?.text ||
      '',
  };
}

async function fetchText(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } catch {
    return { status: 0, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

function sessionHeaders() {
  const sessionId = (Deno.env.get('IG_SESSIONID') || '').trim();
  return sessionId ? { Cookie: `sessionid=${sessionId}` } : {};
}

export default async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Metodo no permitido.' }, 405);
  }

  let rawUrl;
  try {
    ({ url: rawUrl } = await request.json());
  } catch {
    return json({ error: 'Cuerpo de la peticion invalido.' }, 400);
  }

  const match = typeof rawUrl === 'string' ? INSTAGRAM_URL_RE.exec(rawUrl.trim()) : null;
  if (!match) {
    return json(
      { error: 'URL invalida. Debe ser un enlace de Instagram del tipo /p/, /reel/ o /tv/.' },
      400
    );
  }

  const shortcode = match[3];
  const sourceUrl = `https://www.instagram.com/p/${shortcode}/`;
  const cookie = sessionHeaders();

  // 1. API interna.
  const api = await fetchText(
    `https://www.instagram.com/api/v1/media/web_info/?shortcode=${encodeURIComponent(shortcode)}`,
    {
      'User-Agent': BROWSER_UA,
      'X-IG-App-ID': IG_WEB_APP_ID,
      Accept: 'application/json',
      Referer: sourceUrl,
      ...cookie,
    }
  );

  if (api.status === 200 && api.body) {
    try {
      const parsed = parseVideoFromApiJson(JSON.parse(api.body));
      if (parsed) return json({ ...parsed, sourceUrl, via: 'edge-api' }, 200);
    } catch {
      // Respuesta no JSON: seguimos con las rutas HTML.
    }
  }

  // 2. Rutas HTML.
  const htmlAttempts = [
    [`https://www.instagram.com/p/${shortcode}/embed/captioned/`, BROWSER_UA],
    [`https://www.instagram.com/reel/${shortcode}/embed/`, BROWSER_UA],
    [sourceUrl, CRAWLER_UA],
    [sourceUrl, BROWSER_UA],
  ];

  for (const [url, ua] of htmlAttempts) {
    const { status, body } = await fetchText(url, {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      ...cookie,
    });

    if (status !== 200 || !body) continue;

    const parsed = parseVideoFromHtml(body);
    if (parsed) return json({ ...parsed, sourceUrl, via: 'edge-html' }, 200);
  }

  return json(
    {
      error:
        'Instagram tambien bloqueo la ruta edge. Ya no quedan vias anonimas: ' +
        'configura IG_SESSIONID o ejecuta la app en local. Ver el README.',
    },
    502
  );
};

export const config = { path: '/api/resolve' };
