const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/resolve', async (req, res) => {
  try {
    const { url: rawUrl } = req.body || {};

    if (!rawUrl || typeof rawUrl !== 'string') {
      return res.status(400).json({ error: 'Falta la URL del post de Instagram.' });
    }

    if (!INSTAGRAM_URL_RE.test(rawUrl.trim())) {
      return res.status(400).json({
        error:
          'URL invalida. Debe ser un enlace de Instagram del tipo /p/, /reel/ o /tv/.',
      });
    }

    const postUrl = normalizeInstagramUrl(rawUrl);
    const metadata = await fetchPostMetadata(postUrl);

    res.json({
      videoUrl: metadata.videoUrl,
      thumbnailUrl: metadata.imageUrl || null,
      title: metadata.title,
      sourceUrl: postUrl,
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al procesar la URL.' });
  }
});

app.listen(PORT, () => {
  console.log(`InstaSaver escuchando en http://localhost:${PORT}`);
});
