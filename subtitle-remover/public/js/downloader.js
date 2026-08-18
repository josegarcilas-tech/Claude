/*
 * downloader.js — pestana 1: traer un video de TikTok.
 *
 * /api/resolve  (funcion)      -> metadatos y URLs de descarga, sin marca de agua
 * /dl           (edge function) -> sirve ese archivo desde NUESTRO dominio
 *
 * El paso por /dl no es un capricho. Sirve para dos cosas:
 *   1. manda Content-Disposition: attachment, y asi Safari en movil lo guarda en
 *      Descargas en vez de limitarse a abrirlo en el reproductor;
 *   2. al ser del mismo origen, el navegador SI puede leer los bytes con fetch, que
 *      es lo que permite mandar el video al limpiador sin bajarlo y volver a subirlo.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var $ = function (id) { return document.getElementById(id); };

  var form = $('dl-form');
  if (!form) return;

  var els = {
    url: $('dl-url'),
    go: $('dl-go'),
    status: $('dl-status'),
    result: $('dl-result'),
    cover: $('dl-cover'),
    title: $('dl-title'),
    author: $('dl-author'),
    stats: $('dl-stats'),
    toCleaner: $('dl-to-cleaner'),
    noWm: $('dl-nowm'),
    wm: $('dl-wm'),
    audio: $('dl-audio')
  };

  var current = null;

  function setStatus(message, kind, detail) {
    var el = els.status;
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.textContent = '';
    var main = document.createElement('div');
    main.textContent = message;
    el.appendChild(main);
    if (detail) {
      var d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      el.appendChild(d);
    }
    el.classList.remove('hidden');
  }

  function fmtNumber(n) {
    if (typeof n !== 'number') return null;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  /** URL que pasa por nuestro dominio y fuerza la descarga como archivo. */
  function proxied(url, filename) {
    return '/dl?url=' + encodeURIComponent(url) + '&filename=' + encodeURIComponent(filename);
  }

  function safeName(data) {
    var who = (data.author && data.author.username) || 'tiktok';
    var id = String(data.id || 'video');
    return (who + '_' + id).replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 80);
  }

  function linkOrHide(el, url, filename) {
    if (!url) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.href = proxied(url, filename);
    el.setAttribute('download', filename);
  }

  function renderResult(data) {
    current = data;
    var base = safeName(data);

    els.cover.src = data.cover || '';
    els.cover.classList.toggle('hidden', !data.cover);
    els.title.textContent = data.title || '(sin descripción)';
    els.author.textContent = data.author && data.author.nickname
      ? '@' + data.author.username + ' · ' + data.author.nickname
      : '@' + ((data.author && data.author.username) || 'desconocido');

    els.stats.innerHTML = '';
    [['▶', data.stats && data.stats.plays],
     ['♥', data.stats && data.stats.likes],
     ['💬', data.stats && data.stats.comments],
     ['↗', data.stats && data.stats.shares]].forEach(function (pair) {
      var v = fmtNumber(pair[1]);
      if (v == null) return;
      var li = document.createElement('li');
      li.textContent = pair[0] + ' ' + v;
      els.stats.appendChild(li);
    });

    var dl = data.downloads || {};
    linkOrHide(els.noWm, dl.noWatermark, base + '.mp4');
    linkOrHide(els.wm, dl.watermark, base + '_marca.mp4');
    linkOrHide(els.audio, dl.audio, base + '.mp3');
    els.toCleaner.disabled = !dl.noWatermark && !dl.watermark;

    els.result.classList.remove('hidden');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var raw = (els.url.value || '').trim();
    if (!raw) { setStatus('Pega primero el enlace del video.', 'err'); return; }

    els.go.disabled = true;
    els.result.classList.add('hidden');
    setStatus('Buscando el video…', 'work');

    fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw })
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      if (!r.ok || !r.body || !r.body.data) {
        throw new Error((r.body && r.body.error) || 'No se pudo obtener el video.');
      }
      renderResult(r.body.data);
      setStatus('Listo. Puedes mandarlo al limpiador o descargarlo.', 'ok');
    }).catch(function (err) {
      setStatus('No se pudo traer el video.', 'err', String(err && err.message || err));
    }).then(function () {
      els.go.disabled = false;
    });
  });

  els.toCleaner.addEventListener('click', function () {
    if (!current) return;
    var dl = current.downloads || {};
    var url = dl.noWatermark || dl.watermark;
    if (!url) return;

    var name = safeName(current) + '.mp4';
    els.toCleaner.disabled = true;
    setStatus('Trayendo el archivo al navegador…', 'work');

    // mismo origen: aqui si podemos leer los bytes
    fetch(proxied(url, name)).then(function (res) {
      if (!res.ok) throw new Error('El servidor devolvió ' + res.status);
      return res.blob();
    }).then(function (blob) {
      if (!blob.size) throw new Error('El archivo llegó vacío.');
      var file = new File([blob], name, { type: blob.type || 'video/mp4' });
      SR.App.addFiles([file]);
      setStatus('Cargado en el limpiador (' + (blob.size / 1048576).toFixed(1) + ' MB).', 'ok');
      if (SR.Tabs) SR.Tabs.go('clean');
    }).catch(function (err) {
      setStatus('No se pudo cargar en el limpiador.', 'err',
        String(err && err.message || err) +
        '\nPuedes descargarlo con el botón de al lado y soltarlo en la pestaña Limpiar.');
    }).then(function () {
      els.toCleaner.disabled = false;
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
