const assert = require('node:assert');
const { test, before } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// La edge function es ESM para el runtime Deno, y este paquete es CJS, asi que
// para importarla se copia tal cual a un .mjs temporal. Se prueba el archivo
// real, no una reimplementacion.
let handler;

before(async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'edge-functions', 'resolve.js'),
    'utf8'
  );
  const tempFile = path.join(os.tmpdir(), `edge-resolve-${process.pid}.mjs`);
  fs.writeFileSync(tempFile, source);

  handler = (await import(`file://${tempFile}`)).default;

  // Deno solo se usa para leer IG_SESSIONID en tiempo de peticion.
  globalThis.Deno = { env: { get: () => '' } };
});

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

function post(url) {
  return new Request('https://site.netlify.app/api/resolve', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

test('rechaza los metodos que no son POST', async () => {
  const response = await handler(new Request('https://site.netlify.app/api/resolve'));
  assert.strictEqual(response.status, 405);
});

test('rechaza una URL que no es un post de Instagram', async () => {
  const response = await handler(post('https://www.instagram.com/algun_perfil/'));
  assert.strictEqual(response.status, 400);
});

test('resuelve desde la API interna', async () => {
  const restore = stubFetch({
    'api/v1/media/web_info': {
      body: JSON.stringify({
        items: [
          {
            video_versions: [{ url: 'https://scontent.cdninstagram.com/v/edge.mp4' }],
            caption: { text: 'Desde la API' },
          },
        ],
      }),
    },
  });

  try {
    const response = await handler(post('https://www.instagram.com/reel/C63sA_Sr9vn/'));
    const data = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.videoUrl, 'https://scontent.cdninstagram.com/v/edge.mp4');
    assert.strictEqual(data.via, 'edge-api');
  } finally {
    restore();
  }
});

test('cae al HTML del embed cuando la API devuelve 404', async () => {
  const restore = stubFetch({
    'api/v1/media/web_info': { status: 404 },
    '/embed/': {
      body: String.raw`<script>{"video_url":"https:\/\/scontent.cdninstagram.com\/v\/emb.mp4"}</script>`,
    },
  });

  try {
    const response = await handler(post('https://www.instagram.com/reel/C63sA_Sr9vn/'));
    const data = await response.json();
    assert.strictEqual(data.videoUrl, 'https://scontent.cdninstagram.com/v/emb.mp4');
    assert.strictEqual(data.via, 'edge-html');
  } finally {
    restore();
  }
});

test('lee las meta og: con los atributos en cualquier orden', async () => {
  const restore = stubFetch({
    'api/v1/media/web_info': { status: 404 },
    '/embed/': { status: 404 },
    'instagram.com/p/': {
      body:
        '<meta content="https://scontent.cdninstagram.com/v/og.mp4?a=1&amp;b=2" property="og:video">' +
        '<meta property="og:title" content="Titulo">',
    },
  });

  try {
    const response = await handler(post('https://www.instagram.com/reel/C63sA_Sr9vn/'));
    const data = await response.json();
    assert.strictEqual(
      data.videoUrl,
      'https://scontent.cdninstagram.com/v/og.mp4?a=1&b=2'
    );
    assert.strictEqual(data.title, 'Titulo');
  } finally {
    restore();
  }
});

test('informa del bloqueo cuando todas las vias fallan', async () => {
  const restore = stubFetch({ 'instagram.com': { status: 403 } });

  try {
    const response = await handler(post('https://www.instagram.com/reel/C63sA_Sr9vn/'));
    const data = await response.json();
    assert.strictEqual(response.status, 502);
    assert.match(data.error, /IG_SESSIONID/);
  } finally {
    restore();
  }
});
