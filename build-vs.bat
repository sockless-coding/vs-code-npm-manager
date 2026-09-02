@echo off
rem Build the Visual Studio 2026 extension and drop its .vsix in dist\.
rem Needs Node.js plus MSBuild from a Visual Studio install (located via vswhere).
setlocal
cd /d "%~dp0"

echo === Building the Visual Studio extension ===
call npm run package:vs
if errorlevel 1 goto :error

if not exist "dist" mkdir "dist"
copy /y "apps\visualstudio\src\bin\Release\SocklessNpm.VisualStudio.vsix" "dist\" >nul
if errorlevel 1 goto :error

echo.
echo Done. VSIX written to %~dp0dist
for %%f in ("dist\*.vsix") do echo   %%~nxf
exit /b 0

:error
echo.
echo BUILD FAILED (exit code %errorlevel%)
exit /b 1
