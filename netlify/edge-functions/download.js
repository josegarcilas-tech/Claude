// Streams a remote video/audio file back through our own domain with a
// Content-Disposition: attachment header, so mobile Safari saves it into
// its Downloads panel instead of just opening the file in the video player.
const ALLOWED_HOST_RE = /(^|\.)(tikwm\.com|tiktokcdn[a-z0-9.-]*\.com|tiktokcdn-[a-z0-9.-]*\.com|tiktokv\.com|muscdn\.com|byteoversea\.com|bytedance\.com|cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;

function sanitizeFilename(name) {
  return (name || 'tiktok.mp4').replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 150);
}

export default async (request) => {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');
  const filename = sanitizeFilename(searchParams.get('filename'));

  if (!target) {
    return new Response('Falta el parámetro url.', { status: 400 });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('URL inválida.', { status: 400 });
  }

  if (targetUrl.protocol !== 'https:' || !ALLOWED_HOST_RE.test(targetUrl.hostname)) {
    return new Response('Dominio no permitido.', { status: 400 });
  }

  // Los CDN de Instagram rechazan lo que no parezca un navegador, y quieren
  // ver de dónde viene el pedido. Los de TikTok aceptan lo mismo sin drama.
  const esInstagram = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i
    .test(targetUrl.hostname);

  const salida = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  };
  if (esInstagram) {
    salida['Referer'] = 'https://www.instagram.com/';
    salida['Origin'] = 'https://www.instagram.com';
    // sin esto el CDN suele contestar 403 al pedir un video entero
    salida['Range'] = 'bytes=0-';
  }

  const upstream = await fetch(targetUrl, { headers: salida });

  // 206 (contenido parcial) es una respuesta válida cuando se pide un rango
  if ((!upstream.ok && upstream.status !== 206) || !upstream.body) {
    return new Response(
      `No se pudo descargar el archivo (el servidor de origen respondió ${upstream.status}).`,
      { status: 502 }
    );
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  const length = upstream.headers.get('content-length');
  if (length) headers.set('Content-Length', length);
  headers.set('Cache-Control', 'no-store');

  return new Response(upstream.body, { status: 200, headers });
};

export const config = { path: '/dl' };
