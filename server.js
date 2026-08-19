const express = require('express');
const path = require('path');
const { resolveInstagramVideo } = require('./lib/instagram');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/resolve', async (req, res) => {
  try {
    const result = await resolveInstagramVideo(req.body && req.body.url);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message || 'Error al procesar la URL.' });
  }
});

app.listen(PORT, () => {
  console.log(`InstaSaver escuchando en http://localhost:${PORT}`);
});
