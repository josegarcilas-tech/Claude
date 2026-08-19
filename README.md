# InstaSaver

App web para descargar videos publicos de Instagram (Reels, Posts, IGTV) a partir de su URL, similar en funcion a servicios como savefrom.net pero como aplicacion propia.

## Como funciona

1. El usuario pega la URL de un post publico de Instagram (`/p/`, `/reel/` o `/tv/`).
2. El backend intenta obtener el video probando varias rutas en cascada:
   - la API interna `api/v1/media/web_info` (la que usa la propia web de Instagram),
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

Esta es la limitacion mas importante del proyecto.

Instagram distingue entre IPs residenciales (las de una casa) e IPs de centros de datos.
Las Netlify Functions corren sobre AWS, es decir, IPs de centro de datos, que Instagram
bloquea de forma mucho mas agresiva: en lugar del post devuelve un muro de inicio de sesion
sin las etiquetas del video. Por eso es habitual que la misma app funcione en `localhost`
y falle al desplegarla en Netlify, Vercel o cualquier otro hosting serverless.

### Lo que ya hace la app por su cuenta

`/api/resolve` esta servido por una **Edge Function** (`netlify/edge-functions/resolve.js`),
que corre en la red de Deno Deploy en lugar de AWS. Son rangos de IP distintos y
normalmente menos bloqueados que los de Lambda, asi que es el intento con mas
posibilidades sin credenciales. No es una garantia: si Instagram tambien bloquea esa
ruta, hay que pasar a una de las opciones de abajo.

**Ninguna cantidad de codigo anonimo arregla esto de forma fiable.** Hay tres salidas:

### Opcion A — Ejecutarlo en local (sin configuracion, sin riesgos)

```bash
npm install && npm start
```

Tu conexion domestica es una IP residencial, que es justo lo que Instagram no bloquea.
Es la opcion mas sencilla y la que mejor funciona. La pega: solo lo puedes usar desde
esa maquina y mientras este encendida.

### Opcion B — API oficial (soportada y estable)

La [Instagram Graph API](https://developers.facebook.com/docs/instagram-platform) es la
via legitima y no la bloquean. Requiere crear una app en Meta for Developers y obtener un
token. La limitacion real es de alcance: solo da acceso a tu propio contenido o al de
cuentas que te hayan autorizado explicitamente, no a cualquier post publico.

### Opcion C — Cookie de sesion (`IG_SESSIONID`)

La app acepta una variable de entorno opcional `IG_SESSIONID`. Si la defines, las
peticiones van autenticadas y Instagram deja de devolver el muro de login incluso desde
Netlify. Es la tecnica que usan la mayoria de estas herramientas.

Como obtenerla: entra a instagram.com en el navegador, abre las DevTools →
Application → Cookies → `https://www.instagram.com`, y copia el valor de `sessionid`.
En Netlify se configura en *Site configuration → Environment variables*.

**Antes de usar esta opcion, ten claro lo siguiente:**

- La cookie **es una credencial de acceso completo** a tu cuenta. Quien la tenga entra sin
  contrasena y sin 2FA. Guardala solo como variable de entorno; nunca en el repositorio
  ni en el codigo del frontend.
- El acceso automatizado **va contra las Condiciones de Uso de Instagram**. La cuenta puede
  acabar limitada, bloqueada temporalmente o suspendida. Si aun asi decides usarlo, hazlo
  con una cuenta secundaria que no te importe perder, no con la principal.
- La sesion **caduca**. Cuando lo haga, la app te avisara con un mensaje especifico y
  tendras que volver a copiar el valor.
- Cerrar sesion en el navegador donde copiaste la cookie la invalida.

Es una decision tuya y depende de cuanto te importe cada cosa. Si el objetivo es guardar
tus propios videos de vez en cuando, la **Opcion A es claramente la mas sensata**: cero
configuracion y cero riesgo para tu cuenta.

### Por que savefrom.net si funciona

Servicios como ese sostienen la fiabilidad con infraestructura de proxies residenciales
rotativos, cuentas desechables y mantenimiento constante frente a los cambios de Instagram.
Replicar eso con una sola funcion serverless no es posible.

## Uso responsable

Esta herramienta esta pensada para descargar contenido propio o contenido de terceros con su autorizacion (por ejemplo, para respaldo personal). Descargar y redistribuir contenido ajeno sin permiso puede infringir derechos de autor y las Condiciones de Uso de Instagram. El uso de esta app es responsabilidad de quien la utiliza.
