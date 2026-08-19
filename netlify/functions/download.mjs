import instagram from '../../lib/instagram.js';

const { isAllowedMediaHost } = instagram;

// Netlify Functions v2: devolver un Response con body de stream permite
// enviar videos grandes sin toparse con el limite de payload de las
// funciones tradicionales (~6 MB).
export default async (request) => {
  const target = new URL(request.url).searchParams.get('url');

  if (!target) {
    return Response.json({ error: 'Falta el parametro url.' }, { status: 400 });
  }

  if (!isAllowedMediaHost(target)) {
    return Response.json(
      { error: 'Solo se permiten descargas desde el CDN de Instagram.' },
      { status: 400 }
    );
  }

  const upstream = await fetch(target, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
    },
  });

  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: `El CDN de Instagram respondio con estado ${upstream.status}.` },
      { status: 502 }
    );
  }

  const filename = `instagram-${Date.now()}.mp4`;

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};

export const config = { path: '/api/download' };
