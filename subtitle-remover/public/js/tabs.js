/*
 * tabs.js — cambio entre las tres pestanas.
 */
(function (root) {
  'use strict';

  var SR = (root.SR = root.SR || {});
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = {
    download: document.getElementById('tab-download'),
    clean: document.getElementById('tab-clean'),
    timeline: document.getElementById('tab-timeline')
  };

  function go(name) {
    if (!panels[name]) return;
    Object.keys(panels).forEach(function (k) {
      panels[k].classList.toggle('hidden', k !== name);
    });
    buttons.forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (name === 'timeline' && SR.Timeline) SR.Timeline.refresh();
    root.scrollTo({ top: 0, behavior: 'smooth' });
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-tab')); });
  });

  // botones sueltos que saltan de pestana ("Ir a Limpiar", "Ver la linea de tiempo")
  Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-goto')); });
  });

  SR.Tabs = { go: go };
})(typeof globalThis !== 'undefined' ? globalThis : this);
