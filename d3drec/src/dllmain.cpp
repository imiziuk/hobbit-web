// d3d8.dll proxy: Direct3DCreate8 loads the chained d3d8 (the game folder's d3d8to9 wrapper renamed to
// d3d8_chain.dll, or System32's d3d8.dll) and wraps the returned IDirect3D8 so every call is recorded.
// Config: d3drec.ini next to this DLL (docs/D3DREC.md section 2). Nothing happens inside DllMain except reading the
// config; the chain DLL is loaded and the writer thread started on the first Direct3DCreate8 call (no loader lock).
#include "wrap.h"
#include <stdio.h>

using namespace d3drec;

static HMODULE s_self;
typedef IDirect3D8*(WINAPI* PFN_Direct3DCreate8)(UINT);
static PFN_Direct3DCreate8 s_real;

static HMODULE loadChain(char* used, size_t usedLen) {
    char path[MAX_PATH];
    const char* c = g.cfg.chain;
    for (int attempt = 0; attempt < 2; attempt++) {
        if (attempt == 1 || _stricmp(c, "system") == 0) {
            GetSystemDirectoryA(path, MAX_PATH);   // SysWOW64 for this 32-bit process (WOW64 redirection)
            strcat_s(path, "\\d3d8.dll");
        } else if (strchr(c, ':') || c[0] == '\\') strcpy_s(path, c);
        else sprintf_s(path, "%s%s", g.cfg.dllDir, c);
        HMODULE m = LoadLibraryA(path);
        if (m == s_self) { FreeLibrary(m); m = nullptr; }   // chain must never point back at this DLL
        if (m) { strcpy_s(used, usedLen, path); return m; }
        if (attempt == 0 && _stricmp(c, "system") != 0) OutputDebugStringA("d3drec: chain DLL not found, falling back to system d3d8\n");
    }
    return nullptr;
}

extern "C" IDirect3D8* WINAPI Direct3DCreate8(UINT sdk) {
    static bool inited = false;
    if (!inited) {
        inited = true;
        char used[MAX_PATH] = "";
        HMODULE m = loadChain(used, sizeof used);
        if (m) s_real = (PFN_Direct3DCreate8)GetProcAddress(m, "Direct3DCreate8");
        if (g.cfg.enabled) {
            strcpy_s(g.cfg.chain, used);
            if (g.start()) g.textf("chain %s (%s)", used, s_real ? "ok" : "NO Direct3DCreate8 export");
        }
    }
    if (!s_real) return nullptr;
    IDirect3D8* d = s_real(sdk);
    if (!d || !g.on) return d;
    return wrapDirect3D8(d, sdk);
}

// test hook (synthetic test): flush and close the log as at process exit
extern "C" void WINAPI D3DRec_Finish() { g.finish("D3DRec_Finish"); }

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        s_self = h;
        DisableThreadLibraryCalls(h);
        wrapInit();
        g.loadConfig(h);
    } else if (reason == DLL_PROCESS_DETACH) {
        if (reserved) g.emergency();      // process exit: other threads are already gone
        else g.finish("dll unload");
    }
    return TRUE;
}
