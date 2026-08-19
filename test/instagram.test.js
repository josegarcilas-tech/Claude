const assert = require('node:assert');
const { test } = require('node:test');

const {
  parseVideoFromHtml,
  parseVideoFromApiJson,
  extractShortcode,
  isAllowedMediaHost,
  resolveInstagramVideo,
} = require('../lib/instagram');

/** Sustituye fetch por una tabla de respuestas por fragmento de URL. */
function stubFetch(routes) {
  const original = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const target = String(url);
    const match = Object.keys(routes).find((key) => target.includes(key));
    const { status = 200, body = '' } = match ? routes[match] : { status: 404 };
    return new Response(body, { status });
  };

  return () => {
    globalThis.fetch = original;
  };
}

test('extractShortcode acepta las rutas de post validas', () => {
  assert.strictEqual(
    extractShortcode('https://www.instagram.com/reel/CyEGK7xril5/'),
    'CyEGK7xril5'
  );
  assert.strictEqual(extractShortcode('https://instagram.com/p/ABC123_-x'), 'ABC123_-x');
  assert.strictEqual(extractShortcode('https://www.instagram.com/tv/XyZ/'), 'XyZ');
  assert.strictEqual(
    extractShortcode('https://www.instagram.com/reel/CyEGK7xril5/?igshid=abc'),
    'CyEGK7xril5'
  );
});

test('extractShortcode rechaza lo que no es un post', () => {
  assert.strictEqual(extractShortcode('https://www.instagram.com/someuser/'), null);
  assert.strictEqual(extractShortcode('https://tiktok.com/p/abc'), null);
});

test('parseVideoFromHtml lee las meta etiquetas og:', () => {
  const html = `<html><head>
    <meta property="og:video" content="https://scontent.cdninstagram.com/v/vid.mp4?efg=1&amp;oh=2">
    <meta property="og:image" content="https://scontent.cdninstagram.com/thumb.jpg">
    <meta property="og:title" content="Mi Reel">
  </head></html>`;

  const result = parseVideoFromHtml(html);
  assert.strictEqual(
    result.videoUrl,
    'https://scontent.cdninstagram.com/v/vid.mp4?efg=1&oh=2'
  );
  assert.strictEqual(result.title, 'Mi Reel');
});

test('parseVideoFromHtml lee el blob JSON del endpoint /embed/', () => {
  const html = String.raw`<script>window.__additionalData={"video_url":"https:\/\/scontent.cdninstagram.com\/v\/clip.mp4?_nc=1&oe=ABC","display_url":"https:\/\/scontent.cdninstagram.com\/thumb2.jpg"}</script>`;

  const result = parseVideoFromHtml(html);
  assert.strictEqual(
    result.videoUrl,
    'https://scontent.cdninstagram.com/v/clip.mp4?_nc=1&oe=ABC'
  );
  assert.strictEqual(result.thumbnailUrl, 'https://scontent.cdninstagram.com/thumb2.jpg');
});

test('parseVideoFromHtml recurre a la etiqueta <video>', () => {
  const html = '<video src="https://scontent.cdninstagram.com/direct.mp4"></video>';
  assert.strictEqual(
    parseVideoFromHtml(html).videoUrl,
    'https://scontent.cdninstagram.com/direct.mp4'
  );
});

test('parseVideoFromHtml devuelve null cuando el post no tiene video', () => {
  const html = '<head><meta property="og:image" content="https://x/photo.jpg"></head>';
  assert.strictEqual(parseVideoFromHtml(html), null);
});

test('parseVideoFromApiJson lee la forma xdt_shortcode_media', () => {
  const payload = {
    data: {
      xdt_shortcode_media: {
        video_url: 'https://scontent.cdninstagram.com/v/api.mp4',
        display_url: 'https://scontent.cdninstagram.com/api-thumb.jpg',
        edge_media_to_caption: { edges: [{ node: { text: 'Pie de foto' } }] },
      },
    },
  };

  const result = parseVideoFromApiJson(payload);
  assert.strictEqual(result.videoUrl, 'https://scontent.cdninstagram.com/v/api.mp4');
  assert.strictEqual(result.thumbnailUrl, 'https://scontent.cdninstagram.com/api-thumb.jpg');
  assert.strictEqual(result.title, 'Pie de foto');
});

test('parseVideoFromApiJson lee la forma items/video_versions', () => {
  const payload = {
    items: [
      {
        video_versions: [{ url: 'https://scontent.cdninstagram.com/v/best.mp4' }],
        image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/c.jpg' }] },
        caption: { text: 'Otro pie' },
      },
    ],
  };

  const result = parseVideoFromApiJson(payload);
  assert.strictEqual(result.videoUrl, 'https://scontent.cdninstagram.com/v/best.mp4');
  assert.strictEqual(result.title, 'Otro pie');
});

test('parseVideoFromApiJson devuelve null si no hay video', () => {
  assert.strictEqual(parseVideoFromApiJson({}), null);
  assert.strictEqual(
    parseVideoFromApiJson({ data: { xdt_shortcode_media: { display_url: 'https://x/a.jpg' } } }),
    null
  );
});

test('un 404 de la API no aborta la cascada: el embed todavia puede resolver', async () => {
  // Instagram devuelve 404 en web_info cuando bloquea la peticion, no solo
  // cuando el post no existe. Antes eso cortaba el resto de estrategias.
  const restore = stubFetch({
    'api/v1/media/web_info': { status: 404 },
    '/embed/': {
      status: 200,
      body: String.raw`<script>{"video_url":"https:\/\/scontent.cdninstagram.com\/v\/ok.mp4"}</script>`,
    },
  });

  try {
    const result = await resolveInstagramVideo('https://www.instagram.com/reel/ABC123/');
    assert.strictEqual(result.videoUrl, 'https://scontent.cdninstagram.com/v/ok.mp4');
  } finally {
    restore();
  }
});

test('cuando todo devuelve 404 el error no afirma que el post no existe', async () => {
  const restore = stubFetch({ 'instagram.com': { status: 404 } });

  try {
    await assert.rejects(
      resolveInstagramVideo('https://www.instagram.com/reel/ABC123/'),
      (err) => {
        assert.match(err.message, /bloquea la IP/);
        assert.strictEqual(err.statusCode, 502);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('isAllowedMediaHost solo admite el CDN de Instagram/Meta', () => {
  assert.strictEqual(
    isAllowedMediaHost('https://scontent-mad1-1.cdninstagram.com/v/x.mp4'),
    true
  );
  assert.strictEqual(isAllowedMediaHost('https://video.xx.fbcdn.net/v/x.mp4'), true);
});

test('isAllowedMediaHost bloquea intentos de proxy abierto y SSRF', () => {
  assert.strictEqual(isAllowedMediaHost('https://evil.com/x.mp4'), false);
  // Sufijo pegado al dominio, sin punto separador.
  assert.strictEqual(isAllowedMediaHost('https://evilcdninstagram.com/x.mp4'), false);
  // Dominio permitido usado como subdominio de uno malicioso.
  assert.strictEqual(isAllowedMediaHost('https://cdninstagram.com.evil.com/x.mp4'), false);
  assert.strictEqual(isAllowedMediaHost('http://scontent.cdninstagram.com/x.mp4'), false);
  assert.strictEqual(isAllowedMediaHost('http://localhost:3000/admin'), false);
  assert.strictEqual(isAllowedMediaHost('no-es-url'), false);
});
