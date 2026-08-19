const cheerio = require('cheerio');

const INSTAGRAM_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

const FETCH_TIMEOUT_MS = 8000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Instagram sirve las meta etiquetas og: a los crawlers reconocidos de Meta,
// incluso cuando muestra un muro de login a un navegador anonimo.
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

// ID publico de la app web de Instagram. Su API interna lo exige para
// responder JSON en lugar de redirigir al login.
const IG_WEB_APP_ID = '936619743392459';

const BASE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Mode': 'navigate',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Cookie de sesion opcional (variable de entorno IG_SESSIONID). Sin ella la app
 * solo puede usar las rutas anonimas, que Instagram bloquea desde IPs de
 * centros de datos. Ver la seccion correspondiente del README.
 */
function sessionCookie() {
  const sessionId = (process.env.IG_SESSIONID || '').trim();
  return sessionId ? { Cookie: `sessionid=${sessionId}` } : {};
}

function hasSession() {
  return Boolean((process.env.IG_SESSIONID || '').trim());
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function upstreamError(message) {
  const err = new Error(message);
  err.statusCode = 502;
  return err;
}

function extractShortcode(rawUrl) {
  const match = INSTAGRAM_URL_RE.exec(rawUrl.trim());
  return match ? match[3] : null;
}

/** Convierte una cadena escapada dentro de JSON embebido en una URL usable. */
function unescapeJsonString(value) {
  return value
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

function looksLikeLoginWall(html) {
  return /accounts\/login/.test(html) && !/og:video/.test(html);
}

/**
 * Busca la URL del video en el HTML usando varias senales, de la mas fiable
 * a la mas heuristica. Instagram cambia su marcado con frecuencia, asi que
 * no dependemos de una sola.
 */
function parseVideoFromHtml(html) {
  const $ = cheerio.load(html);

  const result = {
    videoUrl:
      $('meta[property="og:video"]').attr('content') ||
      $('meta[property="og:video:secure_url"]').attr('content') ||
      null,
    thumbnailUrl: $('meta[property="og:image"]').attr('content') || null,
    title: $('meta[property="og:title"]').attr('content') || '',
  };

  if (!result.videoUrl) {
    const videoTagSrc = $('video').attr('src');
    if (videoTagSrc && videoTagSrc.startsWith('http')) {
      result.videoUrl = videoTagSrc;
    }
  }

  // El endpoint /embed/ incrusta un blob JSON con la URL real del mp4.
  if (!result.videoUrl) {
    const patterns = [
      /"video_url"\s*:\s*"([^"]+)"/,
      /"playback_url"\s*:\s*"([^"]+)"/,
      /"src"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) {
        result.videoUrl = unescapeJsonString(match[1]);
        break;
      }
    }
  }

  if (!result.thumbnailUrl) {
    const thumb = /"display_url"\s*:\s*"([^"]+)"/.exec(html);
    if (thumb) result.thumbnailUrl = unescapeJsonString(thumb[1]);
  }

  if (result.videoUrl) result.videoUrl = unescapeJsonString(result.videoUrl);

  return result.videoUrl ? result : null;
}

/** Extrae el video de la respuesta JSON de la API interna de Instagram. */
function parseVideoFromApiJson(payload) {
  const media =
    payload?.data?.xdt_shortcode_media ||
    payload?.graphql?.shortcode_media ||
    payload?.items?.[0];

  if (!media) return null;

  const videoUrl =
    media.video_url ||
    media.video_versions?.[0]?.url ||
    null;

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

async function requestWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return { status: response.status, body };
  } catch (err) {
    return { status: 0, body: '', failed: true, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * API interna que usa la propia web de Instagram. Es la via mas fiable cuando
 * hay cookie de sesion, y a veces responde incluso sin ella.
 */
async function tryApi(shortcode) {
  const endpoint = `https://www.instagram.com/api/v1/media/web_info/?shortcode=${encodeURIComponent(shortcode)}`;

  const { status, body } = await requestWithTimeout(endpoint, {
    headers: {
      'User-Agent': BROWSER_UA,
      'X-IG-App-ID': IG_WEB_APP_ID,
      Accept: 'application/json',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      Referer: `https://www.instagram.com/p/${shortcode}/`,
      ...sessionCookie(),
    },
  });

  if (status !== 200 || !body) return { parsed: null, status };

  try {
    return { parsed: parseVideoFromApiJson(JSON.parse(body)), status };
  } catch {
    return { parsed: null, status };
  }
}

async function tryHtml(url, userAgent) {
  const { status, body } = await requestWithTimeout(url, {
    headers: { ...BASE_HEADERS, 'User-Agent': userAgent, ...sessionCookie() },
    redirect: 'follow',
  });

  if (status !== 200 || !body) return { parsed: null, status, html: body };

  return { parsed: parseVideoFromHtml(body), status, html: body };
}

/**
 * Prueba varias rutas publicas de Instagram en cascada. Las que responden sin
 * sesion van primero para no depender de la cookie cuando no hace falta.
 */
async function resolveInstagramVideo(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw badRequest('Falta la URL del post de Instagram.');
  }

  const shortcode = extractShortcode(rawUrl);
  if (!shortcode) {
    throw badRequest(
      'URL invalida. Debe ser un enlace de Instagram del tipo /p/, /reel/ o /tv/.'
    );
  }

  const sourceUrl = `https://www.instagram.com/p/${shortcode}/`;
  const seen = { loginWall: false, forbidden: false, notFound: false };

  function record(status, html) {
    if (status === 401 || status === 403) seen.forbidden = true;
    // Instagram devuelve 404 tanto para un post borrado como para una peticion
    // que decide bloquear, asi que no se puede concluir nada de un 404 suelto:
    // se anota y se sigue probando el resto de estrategias.
    if (status === 404) seen.notFound = true;
    if (html && looksLikeLoginWall(html)) seen.loginWall = true;
  }

  const api = await tryApi(shortcode);
  if (api.parsed) return { ...api.parsed, sourceUrl };
  record(api.status);

  const htmlAttempts = [
    { url: `https://www.instagram.com/p/${shortcode}/embed/captioned/`, ua: BROWSER_UA },
    { url: `https://www.instagram.com/reel/${shortcode}/embed/`, ua: BROWSER_UA },
    { url: sourceUrl, ua: CRAWLER_UA },
    { url: sourceUrl, ua: BROWSER_UA },
  ];

  for (const attempt of htmlAttempts) {
    const { parsed, status, html } = await tryHtml(attempt.url, attempt.ua);
    if (parsed) return { ...parsed, sourceUrl };
    record(status, html);
  }

  if (hasSession() && (seen.loginWall || seen.forbidden || seen.notFound)) {
    throw upstreamError(
      'Instagram rechazo la solicitud pese a la cookie de sesion configurada. ' +
        'Lo mas probable es que IG_SESSIONID haya caducado: vuelve a copiarla desde el navegador.'
    );
  }

  if (seen.loginWall || seen.forbidden || seen.notFound) {
    throw upstreamError(
      'Instagram rechazo todas las vias de acceso (muro de login, 403 o 404). ' +
        'Desde un servidor cloud como Netlify esto casi siempre significa que bloquea la IP, ' +
        'no que el post no exista: comprueba el enlace en tu navegador. ' +
        'Configura IG_SESSIONID o ejecuta la app en local. Ver el README.'
    );
  }

  throw upstreamError(
    'No se pudo extraer el video. El post puede ser privado, ser una foto (no video), ' +
      'o Instagram cambio su estructura de pagina.'
  );
}

/**
 * El proxy de descarga solo debe reenviar peticiones al CDN de Instagram/Meta.
 * Sin esta comprobacion la funcion seria un proxy abierto.
 */
function isAllowedMediaHost(rawUrl) {
  let host;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  return (
    host === 'cdninstagram.com' ||
    host === 'fbcdn.net' ||
    host.endsWith('.cdninstagram.com') ||
    host.endsWith('.fbcdn.net')
  );
}

module.exports = {
  resolveInstagramVideo,
  parseVideoFromHtml,
  parseVideoFromApiJson,
  extractShortcode,
  isAllowedMediaHost,
  hasSession,
  INSTAGRAM_URL_RE,
};
