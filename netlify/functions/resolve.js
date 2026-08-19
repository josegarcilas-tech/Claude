const { resolveInstagramVideo } = require('../../lib/instagram');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Metodo no permitido.' }),
    };
  }

  try {
    const { url } = JSON.parse(event.body || '{}');
    const result = await resolveInstagramVideo(url);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Error al procesar la URL.' }),
    };
  }
};
