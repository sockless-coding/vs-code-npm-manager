@echo off
rem Build both extensions; the .vsix files land in dist\.
setlocal
cd /d "%~dp0"

if exist "dist" del /q "dist\*.vsix" >nul 2>&1

call "%~dp0build-vscode.bat"
if errorlevel 1 exit /b 1

call "%~dp0build-vs.bat"
if errorlevel 1 exit /b 1

echo.
echo === All extensions built ===
for %%f in ("dist\*.vsix") do echo   %%~nxf
exit /b 0
