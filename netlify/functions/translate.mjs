/**
 * Traduce líneas de subtítulo al español latino.
 * Requiere la variable de entorno ANTHROPIC_API_KEY en Netlify.
 * Opcional: ANTHROPIC_MODEL (por defecto claude-sonnet-5).
 */

export default async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Usá POST.' }, 405);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: 'Falta ANTHROPIC_API_KEY en las variables de entorno del sitio.' }, 500);
  }

  let texts;
  try {
    ({ texts } = await request.json());
  } catch {
    return json({ error: 'El cuerpo debe ser JSON con { texts: [...] }.' }, 400);
  }

  if (!Array.isArray(texts) || !texts.length) {
    return json({ error: 'Mandá al menos una línea en texts.' }, 400);
  }
  if (texts.length > 60) {
    return json({ error: 'Máximo 60 líneas por llamada.' }, 400);
  }

  const numbered = texts.map((t, i) => `${i + 1}. ${String(t).replace(/\n/g, ' ⏎ ')}`).join('\n');

  const prompt = `Traducí estas líneas de subtítulo de video corto al español latino neutro, con toque colombiano natural.

Reglas:
- Mantené el tono publicitario y directo del original.
- Que cada línea quede corta: son subtítulos en pantalla vertical.
- Conservá los signos de apertura (¿ ¡) y los emojis que aparezcan.
- Si una línea trae " ⏎ ", ese es un salto de línea: dejalo igual.
- Devolvé SOLO un array JSON de strings, en el mismo orden y con la misma cantidad de elementos. Sin explicaciones, sin markdown, sin backticks.

Líneas:
${numbered}`;

  // si el modelo configurado no existe en la cuenta, se prueba con los siguientes
  const modelos = [];
  if (process.env.ANTHROPIC_MODEL) modelos.push(process.env.ANTHROPIC_MODEL);
  for (const m of ['claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
    if (!modelos.includes(m)) modelos.push(m);
  }

  let ultimoError = 'No se pudo contactar la API de Claude.';

  for (const model of modelos) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch {
      return json({ error: 'No se pudo contactar la API de Claude.' }, 502);
    }

    if (!res.ok) {
      // el mensaje real de Anthropic dice mucho más que el número de estado
      let detalle = `La API de Claude respondió ${res.status}.`;
      let tipo = '';
      try {
        const err = await res.json();
        if (err && err.error) {
          tipo = err.error.type || '';
          if (err.error.message) detalle = err.error.message;
        }
      } catch { /* la respuesta no era JSON */ }

      const modeloDesconocido =
        res.status === 404 ||
        tipo === 'not_found_error' ||
        /model/i.test(detalle);

      if (modeloDesconocido && model !== modelos[modelos.length - 1]) {
        ultimoError = detalle;
        continue;   // probar el siguiente modelo
      }

      if (/credit balance|billing|insufficient/i.test(detalle)) {
        detalle = 'La cuenta de Anthropic no tiene saldo. Cargá créditos en console.anthropic.com y volvé a intentar.';
      } else if (res.status === 401 || res.status === 403) {
        detalle = 'La llave ANTHROPIC_API_KEY no es válida o no tiene permiso.';
      } else if (res.status === 429) {
        detalle = 'Demasiadas solicitudes seguidas. Esperá un momento y probá de nuevo.';
      }

      return json({ error: detalle, model, status: res.status }, 502);
    }

    let data;
    try { data = await res.json(); }
    catch { return json({ error: 'La API de Claude devolvió algo que no se pudo leer.' }, 502); }

    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let translations;
    try {
      translations = JSON.parse(raw);
    } catch {
      const m = raw.match(/\[[\s\S]*\]/);
      translations = m ? JSON.parse(m[0]) : null;
    }

    if (!Array.isArray(translations)) {
      return json({ error: 'No se pudo leer la respuesta de traducción.' }, 502);
    }

    translations = translations
      .slice(0, texts.length)
      .map(t => String(t).replace(/ ⏎ /g, '\n'));

    while (translations.length < texts.length) {
      translations.push(texts[translations.length]);
    }

    return json({ translations, model });
  }

  return json({ error: ultimoError }, 502);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
