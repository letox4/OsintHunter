@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1

if not exist ".venv\Scripts\python.exe" (
  echo Creando entorno de Python...
  py -3 -m venv .venv 2>nul || python -m venv .venv
)
echo Instalando dependencias y PyInstaller...
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt pyinstaller || goto :error

".venv\Scripts\python.exe" tools\make_icon.py || goto :error

echo Generando OsintHunter.exe (tarda un par de minutos)...
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --onefile --console ^
  --name OsintHunter ^
  --icon build\osinthunter.ico ^
  --add-data "web;web" ^
  --add-data "app\resources;app\resources" ^
  --collect-submodules uvicorn ^
  --collect-submodules dns ^
  --collect-submodules phonenumbers ^
  --collect-submodules pypdf ^
  --collect-submodules keyring ^
  --collect-submodules win32ctypes ^
  --hidden-import keyring.backends.Windows ^
  --copy-metadata keyring ^
  --collect-submodules app ^
  osinthunter.py || goto :error

echo.
echo Listo: dist\OsintHunter.exe
echo Puedes copiarlo a cualquier carpeta; guardara sus datos en una carpeta "data" a su lado.
pause
exit /b 0

:error
echo.
echo Ha fallado la generacion del ejecutable.
pause
exit /b 1
