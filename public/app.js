const form = document.getElementById('download-form');
const urlInput = document.getElementById('url-input');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const preview = document.getElementById('preview');
const resultTitle = document.getElementById('result-title');
const downloadLink = document.getElementById('download-link');

function setStatus(message, type) {
  if (!message) {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.className = `status ${type}`;
  statusEl.textContent = message;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resultEl.hidden = true;
  setStatus('Buscando video...', 'loading');
  submitBtn.disabled = true;

  try {
    const response = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.value }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'No se pudo procesar la URL.');
    }

    // La descarga pasa por nuestro proxy: <a download> se ignora si el
    // archivo viene de otro origen, como el CDN de Instagram.
    preview.src = data.videoUrl;
    downloadLink.href = `/api/download?url=${encodeURIComponent(data.videoUrl)}`;
    resultTitle.textContent = data.title || '';
    resultEl.hidden = false;
    setStatus('', null);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
