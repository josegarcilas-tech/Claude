# InstaSaver

App para descargar videos publicos de Instagram (Reels, Posts, IGTV) pegando su URL.

> **Ejecutala en tu ordenador.** Es la forma en la que funciona de manera fiable.
> Desplegada en Netlify o cualquier hosting cloud, Instagram bloquea las peticiones.
> El motivo esta explicado en [Por que no funciona en Netlify](#por-que-no-funciona-en-netlify).

## Como usarla

### 1. Instalar Node.js

Si no lo tienes: descargalo en **<https://nodejs.org>** y elige la version **LTS**.
Instalalo con las opciones por defecto.

### 2. Arrancar la app

Descomprime la carpeta y, dentro de ella:

- **Windows** — doble clic en `start.bat`
- **macOS** — doble clic en `start.command`
  (si macOS lo bloquea por ser de un desarrollador no identificado:
  clic derecho → *Abrir* → *Abrir*)
- **Cualquier sistema, desde la terminal:**

  ```bash
  npm install
  npm start
  ```

La primera vez tarda un poco porque instala las dependencias. Despues se abre
solo el navegador en `http://localhost:3000`.

### 3. Usarla

Pega el enlace de un Reel, Post o IGTV **publico** y pulsa *Buscar video*.
Para cerrarla, pulsa `Ctrl + C` en la ventana de la terminal.

## Como funciona por dentro

1. Del enlace se extrae el shortcode del post (los parametros `?igsh=...` se descartan).
2. El backend prueba varias rutas en cascada hasta que una responde:
   - la API interna `api/v1/media/web_info`, la que usa la propia web de Instagram,
   - el endpoint `/embed/captioned/`, pensado para incrustar,
   - la pagina del post con User-Agent de crawler de Meta (`facebookexternalhit`),
   - la pagina del post con User-Agent de navegador.

   De cada respuesta saca el mp4 mirando `og:video`, la etiqueta `<video>` y los
   blobs JSON incrustados (`video_url`, `playback_url`).
3. El frontend muestra la vista previa y el boton de descarga.

La descarga pasa por `/api/download`, un proxy propio. Hace falta porque el navegador
ignora el atributo `download` cuando el archivo viene de otro origen: sin el proxy, el
boton abriria el video en vez de guardarlo. El proxy solo acepta URLs del CDN de
Instagram/Meta, para no convertirse en un proxy abierto.

## Tests

```bash
npm test
```

Cubren la extraccion del shortcode, el parseo de HTML y de la API (con fixtures),
el comportamiento de la cascada ante errores, y las restricciones de host del proxy.

## Por que no funciona en Netlify

Instagram trata de forma muy distinta las IPs residenciales (las de una casa) y las de
centros de datos. Netlify, Vercel y AWS son centros de datos: a esas IPs Instagram les
devuelve un muro de inicio de sesion en lugar del post. Por eso la misma app funciona en
`localhost` y falla al desplegarla.

**Esto no se arregla desde el codigo.** Si aun asi quieres desplegarla, hay dos salidas:

### Cookie de sesion (`IG_SESSIONID`)

La app acepta una variable de entorno opcional `IG_SESSIONID`. Si la defines, las
peticiones van autenticadas y el muro de login desaparece.

Para obtenerla: entra a instagram.com en el navegador, abre DevTools →
Application → Cookies → `https://www.instagram.com`, y copia el valor de `sessionid`.
En Netlify se configura en *Site configuration → Environment variables*.

Antes de usarla, ten claro que:

- La cookie **da acceso completo a la cuenta**, sin contrasena y sin 2FA. Guardala solo
  como variable de entorno, nunca en el repositorio ni en el frontend.
- El acceso automatizado **va contra las Condiciones de Uso de Instagram**, y la cuenta
  puede acabar limitada o suspendida. Usa una cuenta secundaria, no la principal.
- La sesion **caduca**; cuando pase, la app avisa con un mensaje especifico.

### API oficial de Meta

La [Instagram Graph API](https://developers.facebook.com/docs/instagram-platform) es la
via legitima y no la bloquean. Requiere crear una app en Meta for Developers. Su limite
es de alcance: solo llega a tu propio contenido o al de cuentas que te autoricen.

## Desplegar en Netlify

El proyecto incluye `netlify.toml`, una Netlify Function (`netlify/functions/`) y una
Edge Function en Deno (`netlify/edge-functions/`), que corre en rangos de IP distintos a
los de AWS y tiene algo mas de margen frente al bloqueo.

**Importante:** arrastrar el ZIP al panel de Netlify **no construye las Edge Functions**.
Para que se activen hace falta desplegar por CLI o conectando el repositorio:

```bash
npm install -g netlify-cli
netlify deploy --prod
```

O bien: Netlify → *Add new site* → *Import an existing project* → selecciona el repo.
`netlify.toml` se detecta solo y no hace falta build command.

## Limitaciones

- Solo posts **publicos**; los privados no son accesibles.
- De un carrusel descarga solo el primer video.
- Instagram cambia su marcado a menudo; si algo deja de funcionar, hay que ajustar los
  patrones de `lib/instagram.js`.

## Uso responsable

Esta pensada para descargar contenido propio o de terceros con su autorizacion.
Descargar y redistribuir contenido ajeno sin permiso puede infringir derechos de autor
y las Condiciones de Uso de Instagram. El uso de esta app es responsabilidad de quien
la utiliza.
