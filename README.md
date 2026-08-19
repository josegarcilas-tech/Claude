# InstaSaver

App web para descargar videos publicos de Instagram (Reels, Posts, IGTV) a partir de su URL, similar en funcion a servicios como savefrom.net pero como aplicacion propia.

## Como funciona

1. El usuario pega la URL de un post publico de Instagram (`/p/`, `/reel/` o `/tv/`).
2. El backend obtiene el HTML de esa pagina y extrae la URL directa del video (`og:video`).
3. El frontend muestra una vista previa y un enlace de descarga directa.

## Requisitos

- Node.js 18 o superior (usa `fetch` nativo).

## Instalacion y uso

```bash
npm install
npm start
```

Luego abre `http://localhost:3000` en el navegador.

## Limitaciones

- Solo funciona con posts **publicos**. Los perfiles/posts privados no son accesibles.
- Instagram cambia frecuentemente su marcado HTML y puede bloquear solicitudes automatizadas; si deja de funcionar, puede requerir ajustes en `server.js`.
- No descarga carruseles con multiples videos (solo el primer video del post).

## Uso responsable

Esta herramienta esta pensada para descargar contenido propio o contenido de terceros con su autorizacion (por ejemplo, para respaldo personal). Descargar y redistribuir contenido ajeno sin permiso puede infringir derechos de autor y las Condiciones de Uso de Instagram. El uso de esta app es responsabilidad de quien la utiliza.
