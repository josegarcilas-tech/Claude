# InstaSaver

App web para descargar videos publicos de Instagram (Reels, Posts, IGTV) a partir de su URL, similar en funcion a servicios como savefrom.net pero como aplicacion propia.

## Como funciona

1. El usuario pega la URL de un post publico de Instagram (`/p/`, `/reel/` o `/tv/`).
2. El backend intenta obtener el video probando varias rutas publicas en cascada:
   - el endpoint `/embed/captioned/` (pensado para incrustar, suele responder sin sesion),
   - la pagina del post con un User-Agent de crawler de Meta (`facebookexternalhit`),
   - la pagina del post con un User-Agent de navegador.
   De cada respuesta extrae la URL del mp4 mirando `og:video`, la etiqueta `<video>`
   y los blobs JSON incrustados (`video_url`, `playback_url`).
3. El frontend muestra una vista previa y un boton de descarga.

La descarga pasa por `/api/download`, un proxy propio: el navegador ignora el atributo
`download` cuando el archivo viene de otro origen, asi que sin ese proxy el boton
abriria el video en lugar de guardarlo. El proxy solo acepta URLs del CDN de
Instagram/Meta para no convertirse en un proxy abierto.

## Tests

```bash
npm test
```

Cubren la extraccion del shortcode, el parseo de HTML (con fixtures) y las
restricciones de host del proxy de descarga.

## Requisitos

- Node.js 18 o superior (usa `fetch` nativo).

## Instalacion y uso (local)

```bash
npm install
npm start
```

Luego abre `http://localhost:3000` en el navegador.

## Deploy en Netlify

El proyecto ya incluye `netlify.toml` y una Netlify Function (`netlify/functions/resolve.js`)
que reemplaza al servidor Express en produccion. El sitio estatico se sirve desde `public/`.

**Opcion recomendada — Netlify CLI:**

```bash
npm install -g netlify-cli
netlify deploy --prod
```

**Opcion — conectar el repo Git en el dashboard de Netlify:**

1. Sube este proyecto a un repositorio Git (GitHub/GitLab/Bitbucket).
2. En Netlify: "Add new site" → "Import an existing project" → selecciona el repo.
3. Netlify detecta `netlify.toml` automaticamente (publish = `public`, functions = `netlify/functions`). No requiere build command.
4. Deploy.

**Nota sobre "drag and drop":** si arrastras la carpeta directamente en el dashboard de Netlify
(deploy manual sin CLI ni Git), las Netlify Functions y `netlify.toml` no siempre se procesan igual.
Para que el backend (`/api/resolve`) funcione de forma confiable, usa Netlify CLI o un deploy conectado a Git.

## Limitaciones

- Solo funciona con posts **publicos**. Los perfiles/posts privados no son accesibles.
- No descarga carruseles con multiples videos (solo el primer video del post).
- Instagram cambia su marcado con frecuencia; si deja de funcionar, hay que ajustar
  los patrones de `lib/instagram.js`.

## Si ves "Instagram bloqueo la solicitud"

Esta es la limitacion mas importante y **no se arregla del todo desde el codigo**.

Instagram distingue entre IPs residenciales (las de una casa) e IPs de centros de datos.
Las Netlify Functions corren sobre AWS, es decir, IPs de centro de datos, que Instagram
bloquea de forma mucho mas agresiva: en lugar del post devuelve un muro de inicio de sesion
sin las etiquetas del video. Por eso es habitual que la misma app funcione en `localhost`
y falle al desplegarla en Netlify, Vercel o cualquier otro hosting serverless.

Las estrategias en cascada del punto 2 mejoran bastante la tasa de exito, pero ninguna
la garantiza. Si necesitas fiabilidad real en produccion, las opciones son:

1. **Ejecutarlo donde la IP sea residencial** — en tu propia maquina, o un mini servidor
   en casa. Es lo que mejor funciona y no requiere cambios de codigo.
2. **Usar la API oficial** — [Instagram Graph API](https://developers.facebook.com/docs/instagram-platform)
   con un token de acceso. Es la via soportada y estable, pero solo da acceso a contenido
   propio o de cuentas que te hayan autorizado.
3. **Enrutar las peticiones por un proxy residencial** — servicio de pago, y conviene
   revisar antes las condiciones de uso de Instagram.

Servicios como savefrom.net sostienen esto con infraestructura de proxies rotativos y
mantenimiento constante; replicar esa fiabilidad con una sola funcion serverless no es
posible.

## Uso responsable

Esta herramienta esta pensada para descargar contenido propio o contenido de terceros con su autorizacion (por ejemplo, para respaldo personal). Descargar y redistribuir contenido ajeno sin permiso puede infringir derechos de autor y las Condiciones de Uso de Instagram. El uso de esta app es responsabilidad de quien la utiliza.
