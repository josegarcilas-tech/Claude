# Estudio de video

Tres pestañas: traer un video de TikTok, limpiarlo, y revisar el resultado en una línea
de tiempo.

Quita lo que se añadió en edición sobre tus videos —subtítulos quemados, recuadros de
comentario, stickers, etiquetas, marcas de agua— reconstruyendo el fondo, y escribe
encima subtítulos nuevos traducidos. Acepta **varios videos a la vez** y los deja
descargar sueltos o todos juntos en un ZIP.

Es el mismo método que se validó a mano con OpenCV/ffmpeg, reimplementado para correr
entero en el navegador. **El video nunca se sube a ningún servidor**: solo se envían
unos pocos fotogramas sueltos a Claude para que ubique el texto y lo traduzca.

---

## Instalación en Netlify (arrastrar y soltar)

1. Entra a <https://app.netlify.com/drop>.
2. Arrastra el archivo **`limpiador-subtitulos.zip`** tal cual (sin descomprimir).
3. Cuando termine el despliegue, ve a
   **Site configuration → Environment variables → Add a variable** y agrega:

   | Clave | Valor |
   |---|---|
   | `ANTHROPIC_API_KEY` | tu clave de <https://console.anthropic.com/settings/keys> |

4. **Importante:** vuelve a desplegar para que la función tome la variable —
   **Deploys → Trigger deploy → Deploy site**.
5. Abre el sitio y listo.

> Variable opcional: `CLAUDE_MODEL` (por defecto `claude-sonnet-5`).

La clave queda solo en el servidor de Netlify. El navegador nunca la ve: llama a
`/api/analyze`, y esa función es la que habla con la API de Claude.

---

## Las tres pestañas

### 1 · Descargar

Pegas el enlace de TikTok y lo trae sin marca de agua. Además del botón de descarga
está **«Mandar al limpiador»**, que carga el video directamente en la pestaña 2 sin
bajarlo y volver a subirlo.

Eso funciona gracias a la edge function `/dl`, que sirve el archivo desde tu propio
dominio. Cumple dos papeles:

- manda `Content-Disposition: attachment`, y así Safari en móvil lo guarda en Descargas
  en vez de limitarse a abrirlo en el reproductor;
- al ser del mismo origen, el navegador **sí puede leer los bytes** con `fetch` — desde
  el CDN de TikTok, CORS lo impediría.

Solo acepta enlaces de TikTok. Si tu video viene de otro sitio, pasa a la pestaña 2 y
suéltalo ahí.

### 2 · Limpiar

Es el limpiador: detecta lo sobrepuesto, lo borra y opcionalmente escribe la traducción.

### 3 · Línea de tiempo

Para comprobar cómo quedó. Tiene el video con un interruptor **Limpio / Original** que
mantiene el instante al cambiar —la forma rápida de ver qué se quitó—, una tira de
miniaturas, y un bloque por cada elemento borrado colocado en su tramo real: naranja los
subtítulos, azul los recuadros. Tocas un bloque y salta a ese punto.

Las miniaturas son un extra: si el navegador no las puede sacar, se dibuja una tira lisa
y los bloques siguen ahí.

---

## Cómo se usa

1. **Elige los videos** — MP4 (H.264/AAC, que es lo que sale de TikTok, Reels o Shorts).
   Puedes soltar varios de una vez, o ir añadiéndolos.
2. **Elige qué hacer:**
   - **Quitar los subtítulos y traducirlos** — borra el texto original y escribe la
     traducción en su lugar (el idioma es configurable, no solo español).
   - **Solo quitar los subtítulos** — deja el video limpio, sin nada encima. En este
     modo a Claude solo se le pide localizar el texto, no traducirlo.
3. **Analiza** — Claude mira unos fotogramas de cada video y ubica todo lo sobrepuesto.
4. **Revisa** — cada video se despliega por separado: puedes corregir la traducción,
   los tiempos, la caja o la posición de cualquier segmento, desactivar los que no
   quieras, o añadir uno a mano.
5. **Procesa todo** y descarga cada MP4, o **todos juntos en un ZIP**.

En modo traducción, si dejas vacío el campo de un subtítulo, ese tramo concreto solo
se borra.

### Dos tipos de elemento

Cada segmento detectado se clasifica, y de ahí depende cómo se borra. Puedes cambiar el
tipo a mano en el paso 3 si Claude se equivoca.

| Tipo | Qué es | Cómo se borra | ¿Se traduce? |
|---|---|---|---|
| **Subtítulo** | texto sobrepuesto, claro con contorno oscuro y sin fondo propio | se detectan los glifos y se quitan solo esos píxeles | sí |
| **Recuadro** | recuadros de comentario, stickers, bocadillos, etiquetas, logos puestos en edición, marcas de agua, `@usuario` | se quita el rectángulo entero | no, solo se borra |

La diferencia importa. Un recuadro de comentario es **fondo claro con letras oscuras**,
justo al revés que un subtítulo: buscarle glifos no funciona, y además su fondo tapa la
imagen igual que el texto. Ahí no hay nada que afinar — lo que sobra es el rectángulo
completo.

Lo que estaba **de verdad delante de la cámara** (carteles de la calle, cuadros, texto
en la ropa, envases de productos) no se toca. La pista para distinguirlo: lo real se
mueve con la escena, lo sobrepuesto se queda clavado en el mismo sitio de la pantalla.

### Sobre el lote

- Los videos se procesan **en serie, nunca en paralelo**: decodificar y recodificar se
  come CPU y memoria, y hacer dos a la vez multiplica el pico justo donde más duele
  (el teléfono).
- Cada video lleva su propio estado y su propio error. Si uno falla —archivo ilegible,
  la API no responde— **los demás siguen**; el que falló lo dice en su fila.
- El ZIP se arma en el navegador en modo *store* (sin comprimir), porque los MP4 ya
  vienen comprimidos. En el móvil además es la única forma fiable de bajarlo todo: los
  navegadores bloquean las descargas múltiples seguidas.

---

## Requisitos del navegador

Usa **WebCodecs** para decodificar y recodificar sin subir nada. Funciona en
**Chrome, Edge y Opera de escritorio** (2023 en adelante). Firefox todavía no lo
soporta del todo y la app avisa si es el caso.

**En iPhone y iPad funciona, pero lento.** El decodificador de WebCodecs de iOS aborta
con *«Decoder failure»*, así que la app lo detecta y reintenta por un camino de
respaldo: extrae los fotogramas moviendo el `currentTime` de un `<video>` normal, que
es justo lo que esos equipos hacen bien. Mismo resultado, unas tres veces más lento.

El cambio de camino es automático; no hay nada que configurar.

Prefiere H.264 para la salida y cae a VP9 o AV1 si el navegador no trae H.264.
El audio **no se recodifica**: las muestras AAC originales se copian tal cual.

---

## Cómo funciona

Tres pasadas sobre cada video:

### Decodificación: dos caminos

| Camino | Cuándo | Velocidad |
|---|---|---|
| `webcodecs` | `VideoDecoder`, si el navegador lo soporta de verdad | rápido |
| `element` | respaldo: se mueve el `currentTime` de un `<video>` y se dibuja al canvas | ~3× más lento |

Se intenta WebCodecs y, si falla, se repite la pasada con el `<video>`; el camino que
funcionó se recuerda para las siguientes. El respaldo apunta al **centro** de cada
fotograma usando las marcas de tiempo exactas del demuxer, así que los cortes salen
en el mismo fotograma que por el camino rápido.

### Las tres pasadas

| Pasada | Qué hace |
|---|---|
| **1. Muestreo** | Saca N fotogramas repartidos y los manda a Claude (visión) para ubicar, transcribir y traducir los subtítulos. |
| **2. Refinado** | Clava el primer y el último fotograma de cada elemento; Claude da tiempos aproximados y un corte flojo deja un parpadeo. En los subtítulos se miden los píxeles de texto. En los recuadros se usa una **plantilla**: se toma la caja en un fotograma donde el elemento está y se compara con la misma caja en todos los demás — un sticker opaco es idéntico mientras se ve, y muy distinto cuando no está porque debajo se ve el video. La plantilla se toma del **centro** de la caja: en los bordes hay margen de sobra y ahí se ve el video moviéndose. |
| **3. Procesado** | Borra, dibuja el subtítulo nuevo y recodifica. |

### El borrado

Lo que hace que quede limpio y no como un parche borroso:

- **La máscara no es "todo lo claro".** Los subtítulos quemados llevan contorno oscuro,
  así que se busca *claro con oscuro al lado*. Sin esa restricción, sobre una pared
  blanca el fondo entero cuenta como texto y se termina borrando de más (por ejemplo,
  los marcos de los cuadros detrás del subtítulo).
- **Dilatación generosa.** Si la máscara no cubre todo el antialiasing, queda un
  "fantasma" con la forma de las letras. Los emojis se dilatan aún más: son grandes y
  muy saturados, y su borde difuminado tiñe el relleno si no se llega a fondo limpio.
- **Relleno con Telea (Fast Marching Method)**, en `telea.js`: un port fiel del
  `cv::inpaint` de OpenCV con `INPAINT_TELEA`. Cada pixel se extrapola desde sus
  vecinos conocidos con un peso que favorece la dirección del frente, así que la
  estructura del fondo (los pliegues de la tela, el borde de un marco) se prolonga
  dentro del hueco. Se probó también una difusión armónica con multigrid: es unas dos
  veces más rápida, pero solo promedia y el parche se nota como una mancha borrosa.
  Validado contra OpenCV sobre fotogramas reales: RMSE de 2–3 sobre 255, diferencia
  máxima de 10 — indistinguible a la vista.
- **La caja se reajusta en cada fotograma**, porque el subtítulo se mueve y cambia de
  largo. Si en un fotograma no hay texto, no se toca.

El subtítulo nuevo se dibuja **donde estaba el original**, así tapa la zona
reconstruida y se respeta la composición del video.

---

## Ajustes avanzados

| Ajuste | Para qué |
|---|---|
| Tamaño de letra / margen | Forzar valores en vez de los detectados. |
| Cobertura de borrado | *Ajustada* daña menos el fondo pero puede dejar rastro; *Amplia* borra más pero difumina un área mayor. |
| Radio de reconstrucción | El `inpaintRadius` de Telea: de cuán lejos se toma la información. Radios grandes suavizan más. |
| Borrar emojis | Quitar también los emojis del subtítulo original. |

---

## Límites conocidos

- **Fondos con mucha estructura.** Si el subtítulo tapa bordes marcados (un cuadro, un
  marco, una reja), la reconstrucción los difumina. Se nota sobre todo cuando la
  traducción es más corta que el texto original y deja parte del área a la vista.
  Ayuda bajar la cobertura a *Ajustada*.
- **Los recuadros grandes dejan una zona lisa.** Debajo de un sticker opaco no hay
  información que recuperar: lo que quede ahí es una interpolación del entorno. Cuanto
  más grande el recuadro, más se nota. Es el límite del método, no un fallo.
- **Videos largos.** Todo ocurre en memoria. Pensado para clips de redes sociales
  (hasta ~60 s). Uno de 9 s a 576×1024 tarda unos 25 s en una máquina normal.
- **iPhone y iPad**: funciona por el camino lento, pero con varios videos grandes a
  la vez el navegador puede quedarse sin memoria. Ve de pocos en pocos.
- **Tiempo de la función.** Las funciones de Netlify cortan a los ~10 s. Si el análisis
  falla por tiempo, baja *«Fotogramas de análisis»* a 6, o añade los segmentos a mano.
- El texto **que forma parte de la escena** (carteles, envases) no se toca — es lo
  correcto, pero si querías quitarlo, tendrás que añadir el segmento a mano.

---

## Estructura

```
netlify.toml                    publish=public, redirect /api/*
netlify/functions/analyze.mjs   llama a Claude (sin dependencias npm)
netlify/functions/resolve.js    resuelve el enlace de TikTok
netlify/edge-functions/         /dl — sirve el archivo desde nuestro dominio
public/
  index.html
  css/app.css
  js/inpaint.js                 detección del texto y construcción de la máscara
  js/telea.js                   relleno por Fast Marching Method (port de OpenCV)
  js/overlay.js                 dibujo de los subtítulos nuevos
  js/zip.js                     empaquetado ZIP (store) para descargarlo todo
  js/video.js                   demux, decode, encode, mux
  js/pipeline.js                las tres pasadas
  js/app.js                     interfaz del limpiador
  js/downloader.js              pestaña 1
  js/timeline.js                pestaña 3
  js/tabs.js                    cambio de pestaña
  vendor/mp4box.all.min.js      demux MP4
  vendor/mp4-muxer.js           mux MP4
```

Sin paso de build y sin dependencias que instalar: es HTML y JS servidos tal cual.

---

## Desarrollo local

```bash
npx http-server public -p 8080     # solo la interfaz (sin /api/analyze)
npx netlify dev                    # sitio + función, con ANTHROPIC_API_KEY en .env
```

Sin la función, la app sigue sirviendo: usa *«Añadir segmento a mano»*.
