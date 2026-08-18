const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const TIKTOK_URL_REGEX = /https?:\/\/(www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;

function normalizeUrl(rawUrl) {
  const match = rawUrl.match(TIKTOK_URL_REGEX);
  return match ? match[0] : null;
}

// Resolves shortened tiktok links (vt.tiktok.com / vm.tiktok.com) to their full form.
async function resolveRedirect(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.url || url;
  } catch {
    return url;
  }
}

async function fetchFromTikwm(tiktokUrl) {
  const endpoint = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
  const res = await fetch(endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokDownloader/1.0)' },
  });
  if (!res.ok) throw new Error(`tikwm respondió ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(json.msg || 'No se pudo procesar el video');
  }
  const d = json.data;
  const base = 'https://www.tikwm.com';
  const abs = (p) => (p ? (p.startsWith('http') ? p : base + p) : null);

  return {
    id: d.id,
    title: d.title || '',
    author: {
      username: d.author?.unique_id || '',
      nickname: d.author?.nickname || '',
      avatar: abs(d.author?.avatar),
    },
    cover: abs(d.cover || d.origin_cover),
    duration: d.duration || null,
    music: d.music ? { title: d.music_info?.title || '', url: abs(d.music) } : null,
    stats: {
      plays: d.play_count,
      likes: d.digg_count,
      comments: d.comment_count,
      shares: d.share_count,
    },
    downloads: {
      noWatermark: abs(d.hdplay || d.play),
      watermark: abs(d.wmplay),
      audio: abs(d.music),
    },
  };
}

app.post('/api/resolve', async (req, res) => {
  const raw = (req.body?.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Falta la URL del video.' });

  const cleanUrl = normalizeUrl(raw);
  if (!cleanUrl) {
    return res.status(400).json({ error: 'Eso no parece un enlace de TikTok válido.' });
  }

  try {
    const finalUrl = await resolveRedirect(cleanUrl);
    const data = await fetchFromTikwm(finalUrl);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('Error resolviendo video:', err.message);
    res.status(502).json({ error: 'No se pudo obtener el video. Intenta de nuevo en unos segundos.' });
  }
});

// Streams the remote file back through our server so the browser's "download"
// attribute works cross-origin and saves with a friendly filename.
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Falta la URL.');
  }
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokDownloader/1.0)' },
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('No se pudo descargar el archivo.');
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(filename || 'tiktok').replace(/[^a-z0-9_\-\.]/gi, '_')}"`
    );
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('Error en proxy de descarga:', err.message);
    res.status(502).send('No se pudo descargar el archivo.');
  }
});

app.listen(PORT, () => {
  console.log(`TikTok Downloader corriendo en http://localhost:${PORT}`);
});
