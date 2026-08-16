# Limpiador de subtítulos

Quita los subtítulos incrustados ("quemados") de un video reconstruyendo el fondo, y
escribe encima subtítulos nuevos traducidos.

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

## Cómo se usa

1. **Elige el video** — MP4 (H.264/AAC, que es lo que sale de TikTok, Reels o Shorts).
2. **Elige qué hacer:**
   - **Quitar los subtítulos y traducirlos** — borra el texto original y escribe la
     traducción en su lugar (el idioma es configurable, no solo español).
   - **Solo quitar los subtítulos** — deja el video limpio, sin nada encima. En este
     modo a Claude solo se le pide localizar el texto, no traducirlo.
3. **Analiza** — Claude mira unos fotogramas y ubica los subtítulos.
4. **Revisa** — puedes corregir la traducción, los tiempos, la caja o la posición de
   cualquier segmento, desactivar los que no quieras, o añadir uno a mano.
5. **Procesa** y **descarga el MP4.**

En modo traducción, si dejas vacío el campo de un subtítulo, ese tramo concreto solo
se borra.

---

## Requisitos del navegador

Usa **WebCodecs** para decodificar y recodificar sin subir nada. Funciona en
**Chrome, Edge y Opera de escritorio** (2023 en adelante). Firefox todavía no lo
soporta del todo y la app avisa si es el caso.

**En iPhone y iPad no es fiable.** Safari en iOS sí expone WebCodecs, pero el
decodificador del sistema tiene límites de memoria mucho más ajustados y aborta con
*«Decoder failure»* en cuanto el video dura unos segundos. La app detecta iOS y lo
avisa por adelantado, sin impedir el intento.

Prefiere H.264 para la salida y cae a VP9 o AV1 si el navegador no trae H.264.
El audio **no se recodifica**: las muestras AAC originales se copian tal cual.

---

## Cómo funciona

Tres pasadas sobre el video:

| Pasada | Qué hace |
|---|---|
| **1. Muestreo** | Saca N fotogramas repartidos y los manda a Claude (visión) para ubicar, transcribir y traducir los subtítulos. |
| **2. Refinado** | Mide fotograma por fotograma dónde hay texto de verdad, para clavar el primer y el último fotograma de cada subtítulo. Claude da tiempos aproximados; los cortes tienen que ser exactos o queda un parpadeo con el texto viejo. |
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
- **Videos largos.** Todo ocurre en memoria. Pensado para clips de redes sociales
  (hasta ~60 s). Uno de 9 s a 576×1024 tarda unos 25 s en una máquina normal.
- **iPhone y iPad**, como se explica arriba.
- **Tiempo de la función.** Las funciones de Netlify cortan a los ~10 s. Si el análisis
  falla por tiempo, baja *«Fotogramas de análisis»* a 6, o añade los segmentos a mano.
- El texto **que forma parte de la escena** (carteles, envases) no se toca — es lo
  correcto, pero si querías quitarlo, tendrás que añadir el segmento a mano.

---

## Estructura

```
netlify.toml                    publish=public, redirect /api/analyze
netlify/functions/analyze.mjs   llama a Claude (sin dependencias npm)
public/
  index.html
  css/app.css
  js/inpaint.js                 detección del texto y construcción de la máscara
  js/telea.js                   relleno por Fast Marching Method (port de OpenCV)
  js/overlay.js                 dibujo de los subtítulos nuevos
  js/video.js                   demux, decode, encode, mux
  js/pipeline.js                las tres pasadas
  js/app.js                     interfaz
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
