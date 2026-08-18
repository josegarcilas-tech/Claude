# TikDown — Descargador de videos de TikTok

Página web para descargar videos de TikTok (con y sin marca de agua) y su audio, similar a ssstik.io.

## Cómo funciona

- **Frontend** (`public/`): página estática (HTML/CSS/JS) donde el usuario pega el enlace del video.
- **Resolver el video**: recibe la URL de TikTok, resuelve enlaces cortos (`vt.tiktok.com` / `vm.tiktok.com`) y consulta un servicio externo (tikwm.com) para obtener los enlaces directos del video (sin marca de agua, con marca de agua) y del audio. Existe en dos versiones equivalentes:
  - `server.js` → ruta `POST /api/resolve` (servidor Express, para correr localmente con `npm start`).
  - `netlify/functions/resolve.js` → misma lógica como Netlify Function, para desplegar en Netlify (sin dependencias, usa `fetch` nativo).
- **Descargar el archivo** (`GET /dl?url=...&filename=...`): antes los botones enlazaban directo al CDN externo, pero eso hace que Safari (sobre todo en iPhone) simplemente reproduzca el video en el visor en vez de guardarlo. Ahora esta ruta hace de proxy: descarga el archivo del CDN y lo reenvía desde nuestro propio dominio con la cabecera `Content-Disposition: attachment`, que es lo que le indica a Safari que debe guardarlo en su panel de Descargas. Existe en dos versiones:
  - `server.js` → ruta Express `/dl`, para desarrollo local.
  - `netlify/edge-functions/download.js` → misma lógica como Netlify Edge Function (soporta streaming de archivos grandes, sin el límite de 6 MB de las funciones normales).
  - Ambas versiones solo permiten reenviar archivos de dominios conocidos de TikTok/tikwm (whitelist), para que la ruta no se pueda usar como proxy abierto hacia cualquier URL.

## Desplegar en Netlify

1. En Netlify: **Add new site → Deploy manually** y arrastra este proyecto (o el .zip descomprimido).
2. Netlify detecta `netlify.toml`, que configura:
   - `publish = "public"` (el sitio estático).
   - `functions = "netlify/functions"` (la función serverless que resuelve el video).
   - Un redirect de `/api/*` → `/.netlify/functions/:splat`.
   - La Edge Function de `netlify/edge-functions/download.js` se registra sola mediante su `export const config = { path: '/dl' }`.
3. No hace falta build command ni variables de entorno.
4. Cuando termine el deploy, abre la URL que te da Netlify y prueba pegando un enlace de TikTok. En iPhone, al tocar "Descargar sin marca de agua" el video debería guardarse directo en la sección de Descargas de Safari (o pedir confirmación, según la configuración de "Preguntar antes de descargar" del usuario).

## Desarrollo local (con Express)

```bash
npm install
npm start
```

Luego abre `http://localhost:3000`.

## Limitaciones y aviso legal

- Esta herramienta depende de un servicio externo no oficial para extraer los enlaces de video; si TikTok cambia su plataforma o bloquea la IP del servidor, puede dejar de funcionar temporalmente.
- No está afiliada con TikTok.
- Úsala solo para descargar contenido que tengas derecho a descargar, respetando derechos de autor y los términos de servicio de TikTok.
