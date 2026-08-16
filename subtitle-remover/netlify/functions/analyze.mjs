/**
 * POST /api/analyze  (Netlify Function v2)
 *
 * Recibe fotogramas del video y devuelve los subtitulos detectados, ya traducidos.
 * La API key vive solo aca (variable de entorno en Netlify); el navegador nunca la ve.
 *
 * Body:  { frames: [{ time: number, dataUrl: "data:image/jpeg;base64,..." }], targetLanguage?: string }
 * Resp:  { segments: [{ start, end, box:{x,y,w,h}, position, original, translated }] }
 *
 * Sin dependencias npm a proposito: asi el despliegue por zip funciona sin build.
 */

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_FRAMES = 16;

const BASE_PROMPT = `Eres un analista de video especializado en subtitulos incrustados (quemados en la imagen).

Recibes fotogramas en orden cronologico, cada uno con su marca de tiempo en segundos.

Tu tarea:
1. Localizar el texto de subtitulo SOBREPUESTO por el editor del video.
2. Agrupar los fotogramas que muestran el MISMO subtitulo en un solo segmento.
3. Transcribir el texto original exactamente.
__TRANSLATE_STEP__
Reglas importantes:
- IGNORA texto que forma parte de la escena real: carteles, cuadros, ropa, envases,
  logos de productos, marcas de agua de la plataforma, nombres de usuario (@usuario).
  Solo interesa el texto sobrepuesto en edicion.
- La caja debe cubrir TODAS las lineas del subtitulo, con un poco de margen.
- Coordenadas normalizadas 0-1 respecto al fotograma completo: x,y = esquina superior
  izquierda; w,h = ancho y alto.
- start/end en segundos. Usa el tiempo del primer y del ultimo fotograma donde ves
  ese subtitulo; si aparece entre dos fotogramas, estima. El sistema afina los cortes
  despues, asi que un margen pequeno esta bien.
- "position": "top" si el subtitulo esta en la mitad superior, "bottom" si esta en la inferior.
__TRANSLATE_RULE__
- Si no hay ningun subtitulo incrustado, devuelve una lista vacia.

Responde UNICAMENTE con JSON valido, sin explicaciones ni bloques de codigo:
{"segments":[{"start":0,"end":3.7,"box":{"x":0.08,"y":0.66,"w":0.85,"h":0.09},"position":"bottom","original":"...","translated":"..."}]}`;

/**
 * En modo "remove" solo hay que localizar el texto, no traducirlo: se le pide a
 * Claude que devuelva "translated" vacio, lo que ahorra tokens y acorta la respuesta
 * (importante, porque las funciones de Netlify tienen un limite de tiempo corto).
 */
function buildSystemPrompt(mode) {
  const translating = mode !== 'remove';
  return BASE_PROMPT
    .replace('__TRANSLATE_STEP__', translating
      ? '4. Traducirlo al idioma pedido, de forma natural y CORTA (que quepa en 1-2 lineas de video vertical).\n'
      : '4. NO traduzcas nada: deja "translated" siempre como cadena vacia "".\n')
    .replace('__TRANSLATE_RULE__', translating
      ? '- En la traduccion NO incluyas emojis.'
      : '- El campo "translated" debe ir vacio ("") en todos los segmentos.');
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}

/** Extrae el primer objeto JSON del texto, tolerando texto o vallas alrededor. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clamp01(n) {
  const v = Number(n);
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Usa POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: 'Falta ANTHROPIC_API_KEY.',
      hint: 'En Netlify: Site configuration → Environment variables → agrega ANTHROPIC_API_KEY, luego Deploys → Trigger deploy.'
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'JSON invalido en el cuerpo de la peticion.' });
  }

  const frames = Array.isArray(payload.frames) ? payload.frames.slice(0, MAX_FRAMES) : [];
  if (!frames.length) return json(400, { error: 'No se recibieron fotogramas.' });

  const mode = payload.mode === 'remove' ? 'remove' : 'translate';
  const targetLanguage = String(payload.targetLanguage || 'espanol').slice(0, 60);

  const content = [{
    type: 'text',
    text: (mode === 'remove'
            ? 'Solo hay que LOCALIZAR los subtitulos, no traducirlos.\n'
            : `Idioma de destino para la traduccion: ${targetLanguage}.\n`) +
          `Te envio ${frames.length} fotogramas en orden cronologico.`
  }];

  for (const f of frames) {
    const parsed = parseDataUrl(f.dataUrl);
    if (!parsed) continue;
    content.push({ type: 'text', text: `Fotograma en t=${Number(f.time).toFixed(2)}s:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
    });
  }

  if (content.length < 3) {
    return json(400, { error: 'Los fotogramas no llegaron en un formato valido.' });
  }

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: buildSystemPrompt(mode),
        messages: [{ role: 'user', content }]
      })
    });
  } catch (e) {
    return json(502, { error: 'No se pudo contactar la API de Claude: ' + e.message });
  }

  const raw = await response.text();

  if (!response.ok) {
    let detail = raw;
    try { detail = JSON.parse(raw)?.error?.message || raw; } catch { /* texto plano */ }
    return json(response.status, {
      error: 'La API de Claude devolvio un error.',
      detail: String(detail).slice(0, 500)
    });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json(502, { error: 'Respuesta ilegible de la API de Claude.' });
  }

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.segments)) {
    return json(502, {
      error: 'Claude no devolvio segmentos en el formato esperado.',
      detail: text.slice(0, 500)
    });
  }

  // Normalizamos y descartamos lo que venga incompleto.
  const segments = parsed.segments
    .filter((s) => s && s.box && typeof s.box.x === 'number')
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(0, Number(s.end) || 0),
      box: {
        x: clamp01(s.box.x),
        y: clamp01(s.box.y),
        w: clamp01(s.box.w),
        h: clamp01(s.box.h)
      },
      position: s.position === 'top' ? 'top' : 'bottom',
      original: String(s.original || ''),
      translated: String(s.translated || '')
    }))
    .filter((s) => s.end > s.start && s.box.w > 0.01 && s.box.h > 0.005)
    .sort((a, b) => a.start - b.start);

  return json(200, { segments, model: data.model || MODEL, usage: data.usage || null });
};
