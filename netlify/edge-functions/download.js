// Streams a remote video/audio file back through our own domain with a
// Content-Disposition: attachment header, so mobile Safari saves it into
// its Downloads panel instead of just opening the file in the video player.
const ALLOWED_HOST_RE = /(^|\.)(tikwm\.com|tiktokcdn[a-z0-9.-]*\.com|tiktokcdn-[a-z0-9.-]*\.com|tiktokv\.com|muscdn\.com|byteoversea\.com|bytedance\.com)$/i;

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

  const upstream = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokDownloader/1.0)' },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response('No se pudo descargar el archivo.', { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  const length = upstream.headers.get('content-length');
  if (length) headers.set('Content-Length', length);
  headers.set('Cache-Control', 'no-store');

  return new Response(upstream.body, { status: 200, headers });
};

export const config = { path: '/dl' };
