// Synthetic "game" for the offline recorder test. No window, no real device:
//   synth.exe <run dir> <shot_interval> <shot_scale> <chunk_kb> <diff> <compress> <frames> [shot_method]
// writes build\d3drec.ini, loads build\d3d8.dll (the recorder) which chains to build\mock_d3d8.dll, renders
// <frames> frames of pixel-exact 2D content through the D3D8 API (the call mix Meridian.exe uses: RHW quads with
// DrawPrimitiveUP, a dynamic VB with DISCARD/NOOVERWRITE, a static VB+IB, a transformed XYZ quad drawn with
// DrawIndexedPrimitiveUP, A8R8G8B8 and DXT1 textures uploaded through surface and texture locks, a state block for
// alpha blending, lights/material/gamma calls, a back-buffer CopyRects screen grab, two failing calls), and paints the
// same picture on the CPU into the mock back buffer before each Present, so the recorder's shots are the ground
// truth the WebGL2 replay must match. Frame 3 gets a deliberate 10x10 magenta error the diff has to find.
// Also writes <run dir>\expect.json for test\check_log.mjs.
#include "../src/d3d8min.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

static const UINT W = 160, H = 120;
typedef IDirect3D8*(WINAPI* PFN_Create)(UINT);
typedef void(WINAPI* PFN_SetBB)(const void*);
typedef void(WINAPI* PFN_Finish)();

static uint32_t crc32(const uint8_t* p, size_t n) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1))); }
    return ~c;
}

/* ------------------------------------------------------------------ CPU reference rendering (BGRA, X8R8G8B8) */
static std::vector<uint32_t> fb(W * H);
static void fillRect(int x0, int y0, int x1, int y1, uint32_t c) { for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) fb[y * W + x] = c | 0xFF000000u; }
static void blendRect(int x0, int y0, int x1, int y1, uint32_t c) {
    uint32_t a = c >> 24;
    for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) {
        uint32_t d = fb[y * W + x], o = 0xFF000000u;
        for (int s = 0; s < 24; s += 8) { uint32_t sc = (c >> s) & 255, dc = (d >> s) & 255; o |= ((sc * a + dc * (255 - a) + 127) / 255) << s; }
        fb[y * W + x] = o;
    }
}

/* ------------------------------------------------------------------ vertex helpers (D3D8: pixel centres on integers) */
struct VC { float x, y, z, rhw; uint32_t c; };
struct VT { float x, y, z, rhw; uint32_t c; float u, v; };
struct VX { float x, y, z; uint32_t c; };
static void rhwQuad(VC* v, float x0, float y0, float x1, float y1, uint32_t c) {
    float X0 = x0 - 0.5f, Y0 = y0 - 0.5f, X1 = x1 - 0.5f, Y1 = y1 - 0.5f;
    v[0] = {X0, Y0, 0.5f, 1, c}; v[1] = {X1, Y0, 0.5f, 1, c}; v[2] = {X0, Y1, 0.5f, 1, c}; v[3] = {X1, Y1, 0.5f, 1, c};
}
static void texQuad(VT* v, float x0, float y0, float x1, float y1) {
    float X0 = x0 - 0.5f, Y0 = y0 - 0.5f, X1 = x1 - 0.5f, Y1 = y1 - 0.5f;
    v[0] = {X0, Y0, 0.5f, 1, 0xFFFFFFFF, 0, 0}; v[1] = {X1, Y0, 0.5f, 1, 0xFFFFFFFF, 1, 0};
    v[2] = {X0, Y1, 0.5f, 1, 0xFFFFFFFF, 0, 1}; v[3] = {X1, Y1, 0.5f, 1, 0xFFFFFFFF, 1, 1};
}

enum { RS_ZENABLE = 7, RS_ALPHABLENDENABLE = 27, RS_SRCBLEND = 19, RS_DESTBLEND = 20, RS_CULLMODE = 22, RS_LIGHTING = 137,
       TSS_COLOROP = 1, TSS_COLORARG1 = 2, TSS_COLORARG2 = 3, TSS_ALPHAOP = 4, TSS_ALPHAARG1 = 5, TSS_ALPHAARG2 = 6,
       TOP_DISABLE = 1, TOP_SELECTARG1 = 2, TOP_MODULATE = 4, TA_DIFFUSE = 0, TA_CURRENT = 1, TA_TEXTURE = 2 };

static uint32_t checker(int x, int y) { return ((x / 4 + y / 4) & 1) ? 0xFFFF8000u : 0xFF0040C0u; }

int main(int argc, char** argv) {
    if (argc < 8) { fprintf(stderr, "usage: synth <run dir> <shot_interval> <shot_scale> <chunk_kb> <diff> <compress> <frames>\n"); return 2; }
    std::string run = argv[1];
    int interval = atoi(argv[2]), scale = atoi(argv[3]), chunk = atoi(argv[4]), diff = atoi(argv[5]), comp = atoi(argv[6]), frames = atoi(argv[7]);
    const char* method = argc > 8 ? argv[8] : "auto";
    char exe[MAX_PATH]; GetModuleFileNameA(nullptr, exe, MAX_PATH); *strrchr(exe, '\\') = 0;
    std::string dir = exe;
    CreateDirectoryA(run.c_str(), nullptr);
    {   // fresh run dir
        WIN32_FIND_DATAA fd; HANDLE h = FindFirstFileA((run + "\\*.*").c_str(), &fd);
        if (h != INVALID_HANDLE_VALUE) { do { if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) DeleteFileA((run + "\\" + fd.cFileName).c_str()); } while (FindNextFileA(h, &fd)); FindClose(h); }
    }
    FILE* ini = fopen((dir + "\\d3drec.ini").c_str(), "w");
    fprintf(ini, "[d3drec]\nenabled=1\nchain=mock_d3d8.dll\noutput_dir=%s\nshot_interval=%d\nshot_scale=%d\nshot_method=%s\n"
                 "chunk_kb=%d\ndiff=%d\ncompress=%d\n", run.c_str(), interval, scale, method, chunk, diff, comp);
    fclose(ini);

    HMODULE rec = LoadLibraryA((dir + "\\d3d8.dll").c_str());
    if (!rec) { fprintf(stderr, "cannot load d3d8.dll\n"); return 1; }
    auto create = (PFN_Create)GetProcAddress(rec, "Direct3DCreate8");
    auto finish = (PFN_Finish)GetProcAddress(rec, "D3DRec_Finish");
    auto setBB = (PFN_SetBB)GetProcAddress(GetModuleHandleA("mock_d3d8.dll") ? GetModuleHandleA("mock_d3d8.dll") : LoadLibraryA((dir + "\\mock_d3d8.dll").c_str()), "Mock_SetBackBuffer");

    IDirect3D8* d3d = create(120);
    D3DADAPTER_IDENTIFIER8 ai; d3d->GetAdapterIdentifier(0, 0, &ai);
    D3DCAPS8 caps; d3d->GetDeviceCaps(0, 1, &caps);
    UINT nm = d3d->GetAdapterModeCount(0);
    for (UINT i = 0; i < nm; i++) { D3DDISPLAYMODE m; d3d->EnumAdapterModes(0, i, &m); }
    d3d->CheckDeviceFormat(0, 1, D3DFMT_X8R8G8B8, 0, 3, D3DFMT_DXT1);
    D3DPRESENT_PARAMETERS pp{}; pp.BackBufferWidth = W; pp.BackBufferHeight = H; pp.BackBufferFormat = D3DFMT_X8R8G8B8; pp.BackBufferCount = 1;
    pp.SwapEffect = 1; pp.Windowed = TRUE; pp.EnableAutoDepthStencil = TRUE; pp.AutoDepthStencilFormat = D3DFMT_D24S8;
    IDirect3DDevice8* dev = nullptr;
    if (FAILED(d3d->CreateDevice(0, 1, nullptr, 0x40, &pp, &dev))) { fprintf(stderr, "CreateDevice failed\n"); return 1; }
    dev->GetDeviceCaps(&caps);
    D3DGAMMARAMP gr; dev->GetGammaRamp(&gr); dev->SetGammaRamp(0, &gr);

    /* textures */
    std::vector<uint8_t> t1(32 * 32 * 4), t2(4 * 4 * 8), t5(64 * 64 * 4);
    for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) { uint32_t c = checker(x, y); memcpy(&t1[(y * 32 + x) * 4], &c, 4); }
    for (int by = 0; by < 4; by++) for (int bx = 0; bx < 4; bx++) {     // DXT1: c0 red, c1 green, indices 0 (left half) / 1 (right half)
        uint8_t* b = &t2[(by * 4 + bx) * 8];
        b[0] = 0x00; b[1] = 0xF8; b[2] = 0xE0; b[3] = 0x07;
        memset(b + 4, bx < 2 ? 0x00 : 0x55, 4);
    }
    srand(12345); for (auto& v : t5) v = (uint8_t)rand();
    auto upload = [&](IDirect3DTexture8* t, const std::vector<uint8_t>& src, UINT rowBytes, UINT rows, bool viaSurface) {
        D3DLOCKED_RECT lr; IDirect3DSurface8* s = nullptr;
        if (viaSurface) { t->GetSurfaceLevel(0, &s); s->LockRect(&lr, nullptr, 0); }
        else t->LockRect(0, &lr, nullptr, 0);
        for (UINT y = 0; y < rows; y++) memcpy((uint8_t*)lr.pBits + y * lr.Pitch, &src[y * rowBytes], rowBytes);
        if (viaSurface) { s->UnlockRect(); s->Release(); } else t->UnlockRect(0);
    };
    IDirect3DTexture8 *T1, *T2, *T3, *T4, *T5, *grab;
    dev->CreateTexture(32, 32, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &T1); upload(T1, t1, 128, 32, true);
    dev->CreateTexture(16, 16, 1, 0, D3DFMT_DXT1, D3DPOOL_MANAGED, &T2); upload(T2, t2, 32, 4, false);
    dev->CreateTexture(8, 8, 2, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &T3);
    {   // two mip levels, level 1 written with a sub-rect lock
        D3DLOCKED_RECT lr; T3->LockRect(0, &lr, nullptr, 0); for (int y = 0; y < 8; y++) memset((uint8_t*)lr.pBits + y * lr.Pitch, 0x11 * (y + 1), 32); T3->UnlockRect(0);
        RECT rc = {2, 2, 4, 4}; T3->LockRect(1, &lr, &rc, 0); for (int y = 0; y < 2; y++) memset((uint8_t*)lr.pBits + y * lr.Pitch, 0x77, 8); T3->UnlockRect(1);
    }
    dev->CreateTexture(32, 32, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &T4); upload(T4, t1, 128, 32, true);   // same bytes as T1: dedupe REF
    dev->CreateTexture(64, 64, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &T5); upload(T5, t5, 256, 64, false);  // incompressible
    dev->CreateTexture(W, H, 1, 0, D3DFMT_X8R8G8B8, D3DPOOL_MANAGED, &grab);

    /* buffers */
    IDirect3DVertexBuffer8 *dyn, *svb; IDirect3DIndexBuffer8* ib;
    dev->CreateVertexBuffer(sizeof(VC) * 4 * 8, 0x208, 0, D3DPOOL_SYSTEMMEM, &dyn);
    dev->CreateVertexBuffer(sizeof(VC) * 4, 8, 0, D3DPOOL_MANAGED, &svb);
    dev->CreateIndexBuffer(12, 8, D3DFMT_INDEX16, D3DPOOL_MANAGED, &ib);
    { BYTE* p; svb->Lock(0, 0, &p, 0); rhwQuad((VC*)p, 100, 8, 150, 30, 0xFF808080); svb->Unlock();
      uint16_t idx[6] = {0, 1, 2, 2, 1, 3}; ib->Lock(0, 0, &p, 0); memcpy(p, idx, 12); ib->Unlock(); }

    /* failing calls (HR prefix records) */
    IDirect3DCubeTexture8* cube = nullptr; dev->CreateCubeTexture(16, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &cube);
    IDirect3DSurface8* zs = nullptr; dev->GetDepthStencilSurface(&zs);

    /* state block: alpha blending */
    DWORD sbBlend = 0;
    dev->BeginStateBlock();
    dev->SetRenderState(RS_ALPHABLENDENABLE, 1); dev->SetRenderState(RS_SRCBLEND, 5); dev->SetRenderState(RS_DESTBLEND, 6);
    dev->EndStateBlock(&sbBlend);

    D3DLIGHT8 light{}; light.Type = 3; light.Diffuse = {1, 1, 1, 1}; light.Direction = {0, -1, 1};
    D3DMATERIAL8 mat{}; mat.Diffuse = {1, 1, 1, 1}; mat.Ambient = {0.2f, 0.2f, 0.2f, 1};
    D3DMATRIX I{}; for (int i = 0; i < 4; i++) I.m[i][i] = 1;
    D3DMATRIX P{}; P.m[0][0] = 2.0f / W; P.m[1][1] = -2.0f / H; P.m[2][2] = 1; P.m[3][0] = -1; P.m[3][1] = 1; P.m[3][3] = 1;
    D3DVIEWPORT8 vp = {0, 0, W, H, 0, 1};
    std::vector<uint8_t> dynMirror(sizeof(VC) * 4 * 8, 0);
    int shots = 0;

    for (int f = 0; f < frames; f++) {
        uint32_t bg = 0xFF101820u + ((uint32_t)f << 18);
        dev->BeginScene();
        dev->SetViewport(&vp);
        dev->Clear(0, nullptr, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, bg, 1.0f, 0);
        fillRect(0, 0, W, H, bg);
        dev->SetRenderState(RS_ZENABLE, 0); dev->SetRenderState(RS_LIGHTING, 0); dev->SetRenderState(RS_CULLMODE, 1);
        dev->SetRenderState(RS_ALPHABLENDENABLE, 0);
        dev->SetTextureStageState(0, TSS_COLOROP, TOP_SELECTARG1); dev->SetTextureStageState(0, TSS_COLORARG1, TA_DIFFUSE);
        dev->SetTextureStageState(0, TSS_ALPHAOP, TOP_SELECTARG1); dev->SetTextureStageState(0, TSS_ALPHAARG1, TA_DIFFUSE);
        dev->SetTextureStageState(1, TSS_COLOROP, TOP_DISABLE); dev->SetTextureStageState(1, TSS_ALPHAOP, TOP_DISABLE);
        dev->SetTexture(0, nullptr);
        dev->SetLight(0, &light); dev->LightEnable(0, TRUE); dev->SetMaterial(&mat);
        dev->SetVertexShader(0x44);   // XYZRHW | DIFFUSE

        VC q[4];
        rhwQuad(q, 8, 8, 40, 30, 0xFF20C040); dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VC)); fillRect(8, 8, 40, 30, 0xFF20C040);

        BYTE* p;   // dynamic VB: DISCARD at offset 0, then NOOVERWRITE after it (the batcher pattern)
        int bx = 50 + f * 4;
        dyn->Lock(0, sizeof(VC) * 4, &p, D3DLOCK_DISCARD); rhwQuad((VC*)p, (float)bx, 8, (float)bx + 20, 30, 0xFFE0E020); memcpy(&dynMirror[0], p, sizeof(VC) * 4); dyn->Unlock();
        uint32_t cc = 0xFF0000FFu | ((uint32_t)(f * 40) << 8);
        dyn->Lock(sizeof(VC) * 4, sizeof(VC) * 4, &p, D3DLOCK_NOOVERWRITE); rhwQuad((VC*)p, 8, 40, 30, 60, cc); memcpy(&dynMirror[sizeof(VC) * 4], p, sizeof(VC) * 4); dyn->Unlock();
        dev->SetStreamSource(0, dyn, sizeof(VC));
        dev->DrawPrimitive(D3DPT_TRIANGLESTRIP, 0, 2); fillRect(bx, 8, bx + 20, 30, 0xFFE0E020);
        dev->DrawPrimitive(D3DPT_TRIANGLESTRIP, 4, 2); fillRect(8, 40, 30, 60, cc);

        dev->SetStreamSource(0, svb, sizeof(VC)); dev->SetIndices(ib, 0);
        dev->DrawIndexedPrimitive(D3DPT_TRIANGLELIST, 0, 4, 0, 2); fillRect(100, 8, 150, 30, 0xFF808080);

        dev->SetVertexShader(0x144);  // XYZRHW | DIFFUSE | TEX1
        dev->SetTextureStageState(0, TSS_COLOROP, TOP_MODULATE); dev->SetTextureStageState(0, TSS_COLORARG1, TA_TEXTURE); dev->SetTextureStageState(0, TSS_COLORARG2, TA_DIFFUSE);
        VT tq[4];
        dev->SetTexture(0, T1); texQuad(tq, 40, 70, 72, 102); dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, tq, sizeof(VT));
        for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) fb[(70 + y) * W + 40 + x] = checker(x, y);
        dev->SetTexture(0, T2); texQuad(tq, 80, 70, 96, 86); dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, tq, sizeof(VT));
        fillRect(80, 70, 88, 86, 0xFFFF0000); fillRect(88, 70, 96, 86, 0xFF00FF00);
        dev->SetTexture(0, nullptr);
        dev->SetTextureStageState(0, TSS_COLOROP, TOP_SELECTARG1); dev->SetTextureStageState(0, TSS_COLORARG1, TA_DIFFUSE);

        dev->SetTransform(256, &I); dev->SetTransform(2, &I); dev->SetTransform(3, &P);
        dev->SetVertexShader(0x42);   // XYZ | DIFFUSE through WORLD*VIEW*PROJ
        VX xq[4] = {{109.5f, 39.5f, 0.5f, 0xFF00FFFF}, {149.5f, 39.5f, 0.5f, 0xFF00FFFF}, {109.5f, 59.5f, 0.5f, 0xFF00FFFF}, {149.5f, 59.5f, 0.5f, 0xFF00FFFF}};
        uint16_t qi[6] = {0, 1, 2, 2, 1, 3};
        dev->DrawIndexedPrimitiveUP(D3DPT_TRIANGLELIST, 0, 4, 2, qi, D3DFMT_INDEX16, xq, sizeof(VX)); fillRect(110, 40, 150, 60, 0xFF00FFFF);

        dev->ApplyStateBlock(sbBlend);
        dev->SetVertexShader(0x44);
        dev->SetTextureStageState(0, TSS_ALPHAOP, TOP_SELECTARG1);
        rhwQuad(q, 20, 50, 60, 80, 0x80FF0000); dev->DrawPrimitiveUP(D3DPT_TRIANGLESTRIP, 2, q, sizeof(VC)); blendRect(20, 50, 60, 80, 0x80FF0000);
        dev->SetRenderState(RS_ALPHABLENDENABLE, 0);
        dev->EndScene();

        if (f == 1) {   // the game's screen-grab path: GetRenderTarget + CopyRects into an X8R8G8B8 texture
            IDirect3DSurface8 *rt, *gs; dev->GetRenderTarget(&rt); grab->GetSurfaceLevel(0, &gs);
            dev->CopyRects(rt, nullptr, 0, gs, nullptr); gs->Release(); rt->Release();
        }
        if (f == 3) fillRect(130, 90, 140, 100, 0xFFFF00FF);   // deliberate error: not drawn through D3D
        setBB(fb.data());
        if (interval > 0 && f % interval == 0) shots++;
        dev->Present(nullptr, nullptr, nullptr, nullptr);
    }

    dev->DeleteStateBlock(sbBlend);
    for (IUnknown* u : {(IUnknown*)T1, (IUnknown*)T2, (IUnknown*)T3, (IUnknown*)T4, (IUnknown*)T5, (IUnknown*)grab, (IUnknown*)dyn, (IUnknown*)svb, (IUnknown*)ib}) u->Release();
    dev->Release();
    d3d->Release();
    finish();

    FILE* e = fopen((run + "\\expect.json").c_str(), "w");
    fprintf(e, "{\"frames\":%d,\"shots\":%d,\"width\":%u,\"height\":%u,\"scale\":%d,\"bad_frame\":3,\"bad_rect\":[130,90,140,100],"
               "\"crc\":{\"T1\":%u,\"T2\":%u,\"T5\":%u,\"dyn160\":%u},"
               "\"counts\":{\"Present\":%d,\"DrawPrimitiveUP\":%d,\"DrawPrimitive\":%d,\"DrawIndexedPrimitive\":%d,\"DrawIndexedPrimitiveUP\":%d,"
               "\"CreateTexture\":6,\"VB_Unlock\":%d,\"IB_Unlock\":1,\"Shot\":%d}}\n",
            frames, shots, W, H, scale, crc32(t1.data(), t1.size()), crc32(t2.data(), t2.size()), crc32(t5.data(), t5.size()),
            crc32(dynMirror.data(), 160), frames, frames * 4, frames * 2, frames, frames, 1 + frames * 2, shots);
    fclose(e);
    printf("synth: %d frames, %d shots -> %s\n", frames, shots, run.c_str());
    return 0;
}
