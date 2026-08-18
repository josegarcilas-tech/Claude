# TikDown — Descargador de videos de TikTok

Página web para descargar videos de TikTok (con y sin marca de agua) y su audio, similar a ssstik.io.

## Cómo funciona

- **Frontend** (`public/`): página estática (HTML/CSS/JS) donde el usuario pega el enlace del video.
- **Backend**: recibe la URL de TikTok, resuelve enlaces cortos (`vt.tiktok.com` / `vm.tiktok.com`) y consulta un servicio externo (tikwm.com) para obtener los enlaces directos del video (sin marca de agua, con marca de agua) y del audio. Existe en dos versiones equivalentes:
  - `server.js`: servidor Express, para correr localmente con `npm start`.
  - `netlify/functions/resolve.js`: la misma lógica como Netlify Function, para desplegar en Netlify (no requiere dependencias, usa `fetch` nativo de Node).

## Desplegar en Netlify

1. En Netlify: **Add new site → Deploy manually** y arrastra este proyecto (o el .zip descomprimido).
2. Netlify detecta `netlify.toml`, que configura:
   - `publish = "public"` (el sitio estático).
   - `functions = "netlify/functions"` (la función serverless).
   - Un redirect de `/api/*` → `/.netlify/functions/:splat`.
3. No hace falta build command ni variables de entorno.
4. Cuando termine el deploy, abre la URL que te da Netlify y prueba pegando un enlace de TikTok.

## Desarrollo local (con Express)

```bash
npm install
npm start
```

Luego abre `http://localhost:3000`.

## Limitaciones y aviso legal

- Esta herramienta depende de un servicio externo no oficial para extraer los enlaces de video; si TikTok cambia su plataforma o bloquea la IP del servidor, puede dejar de funcionar temporalmente.
- Los botones de descarga enlazan directamente al archivo en el CDN del proveedor externo; el nombre de archivo sugerido puede no respetarse en todos los navegadores.
- No está afiliada con TikTok.
- Úsala solo para descargar contenido que tengas derecho a descargar, respetando derechos de autor y los términos de servicio de TikTok.
