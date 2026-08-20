#!/bin/bash
# Lanzador para macOS y Linux. En macOS se puede abrir con doble clic.
cd "$(dirname "$0")" || exit 1

echo ""
echo "  InstaSaver"
echo "  ----------"
echo ""

if ! command -v node > /dev/null 2>&1; then
  echo "  Node.js no esta instalado."
  echo ""
  echo "  Descargalo aqui:  https://nodejs.org"
  echo "  Elige la version LTS, instalala, y vuelve a abrir este archivo."
  echo ""
  read -r -p "  Pulsa Enter para cerrar. "
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  Instalando dependencias (solo la primera vez)..."
  echo ""
  npm install || {
    echo ""
    echo "  Fallo la instalacion. Copia el error de arriba para revisarlo."
    read -r -p "  Pulsa Enter para cerrar. "
    exit 1
  }
fi

npm start
