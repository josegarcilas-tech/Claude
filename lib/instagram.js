const cheerio = require('cheerio');

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

const INSTAGRAM_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?/i;

function normalizeInstagramUrl(rawUrl) {
  const url = new URL(rawUrl.trim());
  url.search = '';
  url.hash = '';
  let pathname = url.pathname;
  if (!pathname.endsWith('/')) pathname += '/';
  return `https://www.instagram.com${pathname}`;
}

async function fetchPostMetadata(postUrl) {
  const response = await fetch(postUrl, { headers: BROWSER_HEADERS });

  if (!response.ok) {
    throw new Error(
      `Instagram respondio con estado ${response.status}. El post puede ser privado, no existir, o Instagram esta bloqueando la solicitud.`
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const videoUrl = $('meta[property="og:video"]').attr('content');
  const imageUrl = $('meta[property="og:image"]').attr('content');
  const title = $('meta[property="og:title"]').attr('content');

  if (!videoUrl) {
    throw new Error(
      'No se encontro un video en esa URL. Puede ser un post privado, una foto (no video), o Instagram cambio su estructura de pagina.'
    );
  }

  return { videoUrl, imageUrl, title: title || '' };
}

async function resolveInstagramVideo(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    const err = new Error('Falta la URL del post de Instagram.');
    err.statusCode = 400;
    throw err;
  }

  if (!INSTAGRAM_URL_RE.test(rawUrl.trim())) {
    const err = new Error(
      'URL invalida. Debe ser un enlace de Instagram del tipo /p/, /reel/ o /tv/.'
    );
    err.statusCode = 400;
    throw err;
  }

  const postUrl = normalizeInstagramUrl(rawUrl);
  const metadata = await fetchPostMetadata(postUrl);

  return {
    videoUrl: metadata.videoUrl,
    thumbnailUrl: metadata.imageUrl || null,
    title: metadata.title,
    sourceUrl: postUrl,
  };
}

module.exports = { resolveInstagramVideo, INSTAGRAM_URL_RE };
