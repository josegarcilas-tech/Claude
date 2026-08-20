@echo off
REM Lanzador para Windows. Se puede abrir con doble clic.
cd /d "%~dp0"

echo.
echo   InstaSaver
echo   ----------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js no esta instalado.
  echo.
  echo   Descargalo aqui:  https://nodejs.org
  echo   Elige la version LTS, instalala, y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Instalando dependencias ^(solo la primera vez^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Fallo la instalacion. Copia el error de arriba para revisarlo.
    pause
    exit /b 1
  )
)

call npm start
pause
