const form = document.getElementById('download-form');
const input = document.getElementById('url-input');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const resultSection = document.getElementById('result');

const els = {
  cover: document.getElementById('result-cover'),
  title: document.getElementById('result-title'),
  author: document.getElementById('result-author'),
  stats: document.getElementById('result-stats'),
  dlNoWm: document.getElementById('dl-nowm'),
  dlWm: document.getElementById('dl-wm'),
  dlAudio: document.getElementById('dl-audio'),
};

function setStatus(message, type) {
  statusEl.textContent = message || '';
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

function formatNumber(n) {
  if (typeof n !== 'number') return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function renderResult(data) {
  els.cover.src = data.cover || '';
  els.title.textContent = data.title || '(sin descripción)';
  els.author.textContent = data.author?.nickname
    ? `@${data.author.username} · ${data.author.nickname}`
    : `@${data.author?.username || 'desconocido'}`;

  els.stats.innerHTML = '';
  const statEntries = [
    ['▶', data.stats?.plays],
    ['♥', data.stats?.likes],
    ['💬', data.stats?.comments],
    ['↗', data.stats?.shares],
  ];
  for (const [icon, value] of statEntries) {
    if (value == null) continue;
    const li = document.createElement('li');
    li.textContent = `${icon} ${formatNumber(value)}`;
    els.stats.appendChild(li);
  }

  const idSafe = (data.id || 'video').toString();

  if (data.downloads?.noWatermark) {
    els.dlNoWm.href = data.downloads.noWatermark;
    els.dlNoWm.setAttribute('download', `tiktok_${idSafe}.mp4`);
    els.dlNoWm.classList.remove('hidden');
  } else {
    els.dlNoWm.classList.add('hidden');
  }

  if (data.downloads?.watermark) {
    els.dlWm.href = data.downloads.watermark;
    els.dlWm.setAttribute('download', `tiktok_${idSafe}_wm.mp4`);
    els.dlWm.classList.remove('hidden');
  } else {
    els.dlWm.classList.add('hidden');
  }

  if (data.downloads?.audio) {
    els.dlAudio.href = data.downloads.audio;
    els.dlAudio.setAttribute('download', `tiktok_${idSafe}.mp3`);
    els.dlAudio.classList.remove('hidden');
  } else {
    els.dlAudio.classList.add('hidden');
  }

  resultSection.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  submitBtn.disabled = true;
  resultSection.classList.add('hidden');
  setStatus('Procesando video...', 'loading');

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const json = await res.json();

    if (!res.ok || !json.ok) {
      throw new Error(json.error || 'Ocurrió un error inesperado.');
    }

    renderResult(json.data);
    setStatus('¡Listo! Elige una opción de descarga abajo.', '');
  } catch (err) {
    setStatus(err.message || 'No se pudo procesar el video.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
