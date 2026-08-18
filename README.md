# Doblaje — subtítulos en español, marca de agua y voz, por lote

App web que encuentra el subtítulo en inglés quemado en un video, lo tapa, escribe la traducción al español encima, le pega tu logo como marca de agua (con la intensidad que elijas) y te descarga el video listo. Procesa varios archivos de una y los entrega en un ZIP.

Todo el video se procesa **dentro del navegador** con FFmpeg compilado a WebAssembly. Tus archivos nunca se suben a un servidor — salvo las líneas de texto cuando tocás "Traducir todo", y el enlace de TikTok cuando importás un video por URL.

---

## El camino corto

1. Cargá el video (arrastralo, elegilo, o pegá el enlace de un TikTok para importarlo directo).
2. Tocá **Traducir y descargar**.

La app sola: encuentra dónde está el subtítulo en inglés, lo lee, lo traduce, tapa el original, escribe el nuevo en la fuente que elegiste, le pone tu logo encima si cargaste uno, y te descarga el archivo. Si cargaste varios, salen todos en un ZIP.

Cuando termina, revisá el resultado. Si algo quedó torcido —una palabra mal leída, la franja corrida, un tiempo desfasado— lo arreglás en la pestaña **Texto** y volvés a exportar.

---

## Funciones principales

- **Detecta el subtítulo en inglés solo.** Recorre el video, ubica la franja donde está el texto quemado y lee las letras (OCR).
- **Traduce al español.** Manda las líneas a la API de Claude y las devuelve en español latino, lista la pestaña **Texto** para retocarlas a mano.
- **Tapa el subtítulo original** sin tocar el resto del cuadro: solo difumina la silueta de las letras (o, si preferís, toda la franja).
- **Edición por línea de tiempo.** Cada línea de texto tiene su "desde" y "hasta" en segundos; se puede ajustar, agregar o borrar, y la vista previa salta a ese momento con un toque.
- **Marca de agua con tu logo.** Subís una imagen (PNG con fondo transparente da el mejor resultado), elegís la esquina, el tamaño y la **intensidad** (opacidad) con la que se ve, y queda pegada en todo el lote.
- **Importar desde TikTok.** Pegás el enlace del video y se descarga directo a tu lote, sin marca de agua de TikTok, listo para traducir.
- **Descarga del video terminado.** Un archivo o el lote completo en un ZIP; en iPhone se abre el menú de compartir para guardarlo en Fotos o Archivos.
- **Voz doblada (opcional).** Le pegás el audio que generaste en ElevenLabs u otra herramienta, y elegís si se reemplaza el audio original o se mezcla con él.

---

## Subirla a Netlify

### Opción rápida — arrastrar y soltar

1. Comprimí esta carpeta en un ZIP (o dejala como carpeta).
2. Entrá a `app.netlify.com/drop` con tu cuenta.
3. Soltá la carpeta ahí. En unos segundos tenés la URL.

### Opción con Git (recomendada si vas a seguir cambiándola)

1. Subí este repo a Netlify: **Add new site → Import an existing project**.
2. Dejá los valores que trae `netlify.toml`. Publish directory: `.`

### Activar la traducción (Traducir todo / Traducir y descargar)

1. En Netlify: **Site configuration → Environment variables → Add a variable**
2. Key: `ANTHROPIC_API_KEY` — Value: tu llave de `console.anthropic.com`
3. Opcional: `ANTHROPIC_MODEL` (por defecto `claude-sonnet-5`)
4. Volvé a desplegar el sitio (**Deploys → Trigger deploy**)

Sin la llave, el resto de la app funciona igual: escribís el texto en español a mano en la pestaña Texto y exportás igual.

### Importar por enlace de TikTok

No necesita ninguna llave: usa un servicio externo (tikwm.com) para resolver el enlace directo del video, y una Edge Function propia (`/dl`) que hace de proxy para poder descargarlo desde el navegador. Si Netlify no publicó la función, subí la carpeta por GitHub en vez de arrastrar el ZIP.

---

## Paso a paso (control total)

1. **Soltá los archivos** en el panel de la izquierda, o pegá un enlace de TikTok para importarlo.
2. **Ubicá la franja** que tapa el subtítulo original: movela con los deslizadores hasta cubrirlo por completo. Podés difuminarla, poner una barra sólida, o tapar solo las letras.
3. **Poné el texto**: escribilo directo, leelo del video con OCR, o mandalo a traducir con Claude.
4. **Ajustá los tiempos** de cada línea (desde / hasta, en segundos).
5. **Elegí la letra**: fuente, grosor, tamaño, borde, colores y altura en pantalla.
6. **Subí tu logo** en la pestaña Letra, elegí la esquina, el tamaño y la intensidad con la que se ve.
7. **Subí la voz** doblada si tenés una, o dejá el audio original.
8. **Exportá**: un archivo o el lote completo en un ZIP.

---

## Archivos

```
index.html                            interfaz
styles.css                            estilos
app.js                                lote, subtítulos, OCR, marca de agua, audio y render
netlify.toml                          configuración de despliegue
netlify/functions/translate.mjs       traducción con la API de Claude
netlify/functions/resolve.js          resuelve el enlace directo de un video de TikTok
netlify/edge-functions/download.js    proxy de descarga (para poder importarlo al navegador)
```

## Cosas que conviene saber

- **Videos cortos.** El motor corre en el navegador, así que clips de TikTok (10–60 s) van bien. Un video de varios minutos puede tardar mucho o quedarse sin memoria.
- **Para lotes grandes, computador.** En el celular la interfaz funciona completa, pero la memoria para procesar video es limitada.
- **La detección automática acierta casi siempre, pero no siempre.** Mirá el resultado antes de publicar.
- **La importación por enlace depende de un servicio de terceros no oficial.** Si TikTok cambia su plataforma, puede dejar de funcionar temporalmente. Usala solo con contenido que tengas derecho a descargar.
- **Nada sale de tu computador**, salvo las líneas de texto al traducir y el enlace al importar de TikTok.
