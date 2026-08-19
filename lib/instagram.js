const cheerio = require('cheerio');

const INSTAGRAM_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

const FETCH_TIMEOUT_MS = 8000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Instagram sirve las meta etiquetas og: a los crawlers reconocidos de Meta,
// incluso cuando muestra un muro de login a un navegador anonimo.
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const BASE_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Mode': 'navigate',
  'Upgrade-Insecure-Requests': '1',
};

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
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
  return (
    /"__isLoggedIn"\s*:\s*false/.test(html) === false &&
    /accounts\/login/.test(html) &&
    !/og:video/.test(html)
  );
}

/**
 * Busca la URL del video en el HTML usando varias señales, de la mas fiable
 * a la mas heuristica. Instagram cambia su marcado con frecuencia, asi que
 * no dependemos de una sola.
 */
function parseVideoFromHtml(html) {
  const $ = cheerio.load(html);

  const result = {
    videoUrl: $('meta[property="og:video"]').attr('content') ||
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

async function fetchHtml(url, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { ...BASE_HEADERS, 'User-Agent': userAgent },
      signal: controller.signal,
      redirect: 'follow',
    });

    const html = await response.text();
    return { status: response.status, html };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 0, html: '', timedOut: true };
    }
    return { status: 0, html: '', networkError: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prueba varias rutas publicas de Instagram. El endpoint /embed/ suele
 * responder sin sesion, por eso va primero.
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

  const attempts = [
    { url: `https://www.instagram.com/p/${shortcode}/embed/captioned/`, ua: BROWSER_UA },
    { url: `https://www.instagram.com/reel/${shortcode}/embed/`, ua: BROWSER_UA },
    { url: sourceUrl, ua: CRAWLER_UA },
    { url: sourceUrl, ua: BROWSER_UA },
  ];

  let sawLoginWall = false;
  let lastStatus = null;

  for (const attempt of attempts) {
    const { status, html, timedOut } = await fetchHtml(attempt.url, attempt.ua);

    if (timedOut) continue;
    lastStatus = status;

    if (status === 404) {
      throw badRequest('Ese post no existe o fue eliminado.');
    }

    if (status !== 200 || !html) continue;

    const parsed = parseVideoFromHtml(html);
    if (parsed) {
      return { ...parsed, sourceUrl };
    }

    if (looksLikeLoginWall(html)) sawLoginWall = true;
  }

  if (sawLoginWall || lastStatus === 401 || lastStatus === 403) {
    const err = new Error(
      'Instagram bloqueo la solicitud y devolvio un muro de inicio de sesion. ' +
        'Esto pasa sobre todo cuando la app corre en un servidor cloud (Netlify, Vercel, AWS), ' +
        'porque Instagram bloquea las IPs de centros de datos. Ver las notas del README.'
    );
    err.statusCode = 502;
    throw err;
  }

  const err = new Error(
    'No se pudo extraer el video. El post puede ser privado, ser una foto (no video), ' +
      'o Instagram cambio su estructura de pagina.'
  );
  err.statusCode = 502;
  throw err;
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
  extractShortcode,
  isAllowedMediaHost,
  INSTAGRAM_URL_RE,
};
