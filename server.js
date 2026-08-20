const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { resolveInstagramVideo, isAllowedMediaHost } = require('./lib/instagram');

const app = express();
const PORT = process.env.PORT || 3000;

/** Abre la app en el navegador al arrancar. NO_OPEN=1 lo desactiva. */
function openBrowser(url) {
  if (process.env.NO_OPEN) return;

  const command =
    process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';

  try {
    spawn(command, [url], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref();
  } catch {
    // Si no se puede abrir, el usuario siempre tiene la URL impresa en consola.
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/resolve', async (req, res) => {
  try {
    const result = await resolveInstagramVideo(req.body && req.body.url);
    res.json(result);
  } catch (err) {
    res
      .status(err.statusCode || 502)
      .json({ error: err.message || 'Error al procesar la URL.' });
  }
});

// Equivalente local de netlify/functions/download.mjs: el navegador no puede
// usar <a download> con una URL de otro origen, asi que el video se sirve
// desde nuestro propio dominio.
app.get('/api/download', async (req, res) => {
  const target = req.query.url;

  if (!target) {
    return res.status(400).json({ error: 'Falta el parametro url.' });
  }

  if (!isAllowedMediaHost(target)) {
    return res
      .status(400)
      .json({ error: 'Solo se permiten descargas desde el CDN de Instagram.' });
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      },
    });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({
        error: `El CDN de Instagram respondio con estado ${upstream.status}.`,
      });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="instagram-${Date.now()}.mp4"`
    );

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Error al descargar el video.' });
  }
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  InstaSaver esta funcionando.');
  console.log(`  Abre esta direccion en el navegador:  ${url}`);
  console.log('');
  console.log('  Para pararlo, pulsa Ctrl + C en esta ventana.');
  console.log('');
  openBrowser(url);
});
