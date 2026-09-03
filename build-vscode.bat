@echo off
rem Build the VS Code extension and drop its .vsix in dist\.
setlocal
cd /d "%~dp0"

echo === Building the VS Code extension ===
call npm run package:vscode
if errorlevel 1 goto :error

if not exist "dist" mkdir "dist"
copy /y "apps\vscode\*.vsix" "dist\" >nul
if errorlevel 1 goto :error

echo.
echo Done. VSIX written to %~dp0dist
for %%f in ("dist\*.vsix") do echo   %%~nxf
exit /b 0

:error
echo.
echo BUILD FAILED (exit code %errorlevel%)
exit /b 1
