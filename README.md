# TikDown — Descargador de videos de TikTok

Página web para descargar videos de TikTok (con y sin marca de agua) y su audio, similar a ssstik.io.

## Cómo funciona

- **Frontend** (`public/`): página estática (HTML/CSS/JS) donde el usuario pega el enlace del video.
- **Backend** (`server.js`): servidor Express con dos endpoints:
  - `POST /api/resolve`: recibe la URL de TikTok, resuelve enlaces cortos (`vt.tiktok.com` / `vm.tiktok.com`) y consulta un servicio externo (tikwm.com) para obtener los enlaces directos del video (sin marca de agua, con marca de agua) y del audio.
  - `GET /api/download`: hace de proxy para descargar el archivo con el nombre correcto, evitando problemas de CORS/origen cruzado.

## Instalación

```bash
npm install
npm start
```

Luego abre `http://localhost:3000`.

## Limitaciones y aviso legal

- Esta herramienta depende de un servicio externo no oficial para extraer los enlaces de video; si TikTok cambia su plataforma, puede dejar de funcionar temporalmente.
- No está afiliada con TikTok.
- Úsala solo para descargar contenido que tengas derecho a descargar, respetando derechos de autor y los términos de servicio de TikTok.
