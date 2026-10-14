@echo off
rem Builds d3drec (x86, MSVC, static CRT) into d3drec\build\:
rem   d3d8.dll        the recorder proxy (install with install.ps1)
rem   mock_d3d8.dll   fake D3D8 runtime for the offline test (no window, no device)
rem   synth.exe       synthetic "game" that drives d3d8.dll -> mock_d3d8.dll and writes test logs
rem   bench.exe       overhead / log-size benchmark with a Meridian-like call mix (mock runtime)
setlocal
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars32.bat" >nul || exit /b 1
cd /d "%~dp0"
python gen_ops.py || exit /b 1
if not exist build mkdir build
set CF=/nologo /O2 /MT /EHsc /W3 /std:c++17 /DWIN32_LEAN_AND_MEAN /DNOMINMAX /D_CRT_SECURE_NO_WARNINGS /Isrc
cl %CF% /LD src\dllmain.cpp src\wrap.cpp src\rec.cpp /Fobuild\ /Febuild\d3d8.dll /link /DEF:src\d3d8.def /MAP:build\d3d8.map kernel32.lib user32.lib || exit /b 1
cl %CF% /LD test\mock_d3d8.cpp /Fobuild\ /Febuild\mock_d3d8.dll /link /DEF:test\mock_d3d8.def || exit /b 1
cl %CF% test\synth.cpp /Fobuild\ /Febuild\synth.exe /link kernel32.lib || exit /b 1
cl %CF% test\bench.cpp /Fobuild\ /Febuild\bench.exe /link kernel32.lib || exit /b 1
echo BUILD OK
