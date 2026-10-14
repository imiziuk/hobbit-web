// Recorder overhead + log size benchmark with a Meridian-like call mix (no window, mock runtime):
//   bench.exe <run dir> <frames> <enabled 0|1>
// Per frame (numbers are a guess at a busy gameplay frame, see docs/D3DREC.md 5): 400 mesh draws (ApplyStateBlock from
// 20 material blocks, SetTexture from 250 textures, WORLD matrix, stream/indices/FVF, 2 render states, 3 stage states,
// DrawIndexedPrimitive; a quarter of the objects move every frame), the immediate-mode batcher (3 rotating 0xCE40-byte
// dynamic VBs, 24 flushes of ~2 KB with NOOVERWRITE: UI quads that repeat + particles that change), 12 font
// DrawPrimitiveUP calls, the fog plane DrawIndexedPrimitiveUP, a 640x480 back buffer with a shot every 60 frames at 1/2.
// Startup uploads 200 DXT1 128x128 + 50 DXT3 256x256 textures and 50 mesh VB/IB pairs.
#include "../src/d3d8min.h"
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <vector>

typedef IDirect3D8*(WINAPI* PFN_Create)(UINT);
typedef void(WINAPI* PFN_Finish)();
static uint32_t rng = 1;
static uint32_t rnd() { rng = rng * 1664525u + 1013904223u; return rng >> 8; }
static float frnd() { return (float)(rnd() & 0xFFFF) / 65536.0f; }

int main(int argc, char** argv) {
    if (argc < 4) { fprintf(stderr, "usage: bench <run dir> <frames> <enabled>\n"); return 2; }
    std::string run = argv[1]; int frames = atoi(argv[2]), enabled = atoi(argv[3]);
    char exe[MAX_PATH]; GetModuleFileNameA(nullptr, exe, MAX_PATH); *strrchr(exe, '\\') = 0;
    std::string dir = exe;
    CreateDirectoryA(run.c_str(), nullptr);
    FILE* ini = fopen((dir + "\\d3drec.ini").c_str(), "w");
    fprintf(ini, "[d3drec]\nenabled=%d\nchain=mock_d3d8.dll\noutput_dir=%s\nshot_interval=60\nshot_scale=2\nshot_method=auto\n", enabled, run.c_str());
    fclose(ini);
    HMODULE rec = LoadLibraryA((dir + "\\d3d8.dll").c_str());
    auto create = (PFN_Create)GetProcAddress(rec, "Direct3DCreate8");
    auto finish = (PFN_Finish)GetProcAddress(rec, "D3DRec_Finish");
    IDirect3D8* d3d = create(120);
    D3DPRESENT_PARAMETERS pp{}; pp.BackBufferWidth = 640; pp.BackBufferHeight = 480; pp.BackBufferFormat = D3DFMT_X8R8G8B8; pp.Windowed = 1;
    IDirect3DDevice8* dev; d3d->CreateDevice(0, 1, nullptr, 0x40, &pp, &dev);

    LARGE_INTEGER f, t0, t1, t2; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&t0);
    std::vector<IDirect3DTexture8*> tex;
    for (int i = 0; i < 250; i++) {
        IDirect3DTexture8* t; bool big = i >= 200; UINT s = big ? 256 : 128;
        dev->CreateTexture(s, s, 1, 0, big ? D3DFMT_DXT3 : D3DFMT_DXT1, D3DPOOL_MANAGED, &t);
        D3DLOCKED_RECT lr; t->LockRect(0, &lr, nullptr, 0);
        UINT rows = s / 4, rb = s / 4 * (big ? 16 : 8);
        for (UINT y = 0; y < rows; y++) { uint8_t* p = (uint8_t*)lr.pBits + y * lr.Pitch; for (UINT x = 0; x < rb; x++) p[x] = (uint8_t)(x % 7 == 0 ? rnd() : (x * 13 + y + i)); }
        t->UnlockRect(0); tex.push_back(t);
    }
    std::vector<IDirect3DVertexBuffer8*> mvb; std::vector<IDirect3DIndexBuffer8*> mib;
    for (int i = 0; i < 50; i++) {
        IDirect3DVertexBuffer8* v; IDirect3DIndexBuffer8* ib; BYTE* p;
        dev->CreateVertexBuffer(44 * 900, 8, 0, D3DPOOL_MANAGED, &v); v->Lock(0, 0, &p, 0);
        for (int k = 0; k < 44 * 900 / 4; k++) ((float*)p)[k] = (float)((k * 7 + i) % 101) * 0.37f + frnd() * 0.01f;
        v->Unlock(); mvb.push_back(v);
        dev->CreateIndexBuffer(2 * 3000, 8, D3DFMT_INDEX16, D3DPOOL_MANAGED, &ib); ib->Lock(0, 0, &p, 0);
        for (int k = 0; k < 3000; k++) ((uint16_t*)p)[k] = (uint16_t)((k * 31 + i) % 900);
        ib->Unlock(); mib.push_back(ib);
    }
    IDirect3DVertexBuffer8* dyn[3];
    for (auto& d : dyn) dev->CreateVertexBuffer(0xCE40, 0x208, 0, D3DPOOL_SYSTEMMEM, &d);
    DWORD sb[20];
    for (auto& s : sb) { dev->BeginStateBlock(); dev->SetRenderState(27, rnd() & 1); dev->SetRenderState(19, 5); dev->SetRenderState(20, 6);
        dev->SetTextureStageState(0, 1, 4); dev->SetTextureStageState(0, 2, 2); dev->SetTextureStageState(0, 3, 0); dev->EndStateBlock(&s); }
    struct Obj { D3DMATRIX m; bool moves; };
    std::vector<Obj> objs(400);
    for (auto& o : objs) { memset(&o.m, 0, 64); for (int k = 0; k < 4; k++) o.m.m[k][k] = 1; o.m.m[3][0] = frnd() * 100; o.m.m[3][2] = frnd() * 100; o.moves = (rnd() & 3) == 0; }
    std::vector<uint8_t> ui(2048), particles(2048);
    for (auto& b : ui) b = (uint8_t)rnd();
    QueryPerformanceCounter(&t1);

    float fogv[40]; uint16_t fogi[6] = {0, 1, 2, 2, 1, 3};
    for (int i = 0; i < 40; i++) fogv[i] = frnd();
    std::vector<uint8_t> text(20 * 6 * 36);
    for (int fr = 0; fr < frames; fr++) {
        dev->BeginScene();
        dev->Clear(0, nullptr, 7, 0xFF203040, 1.0f, 0);
        D3DMATRIX v{}; for (int k = 0; k < 4; k++) v.m[k][k] = 1; v.m[3][0] = fr * 0.1f;
        dev->SetTransform(2, &v); dev->SetTransform(3, &v);
        dev->SetVertexShader(0x252);
        for (int i = 0; i < 400; i++) {
            Obj& o = objs[i];
            if (o.moves) { o.m.m[3][0] += 0.05f; o.m.m[3][1] = (float)(fr % 30) * 0.1f; }
            dev->ApplyStateBlock(sb[i % 20]);
            dev->SetTexture(0, tex[(i * 7) % 250]);
            dev->SetTransform(256, &o.m);
            dev->SetRenderState(15, i & 1); dev->SetRenderState(14, 1);
            dev->SetTextureStageState(0, 13, 1); dev->SetTextureStageState(0, 14, 1); dev->SetTextureStageState(0, 11, 0);
            dev->SetStreamSource(0, mvb[i % 50], 44); dev->SetIndices(mib[i % 50], 0);
            dev->DrawIndexedPrimitive(4, 0, 900, (i % 4) * 300, 200 + i % 50);
        }
        IDirect3DVertexBuffer8* d = dyn[fr % 3]; UINT off = 0;
        dev->SetVertexShader(0x244);
        for (int k = 0; k < 24; k++) {
            BYTE* p; UINT n = 2048;
            dyn[fr % 3]->Lock(off, n, &p, off ? D3DLOCK_NOOVERWRITE : D3DLOCK_DISCARD);
            if (k < 16) memcpy(p, ui.data(), n);                       // UI: same bytes every frame
            else { for (UINT q = 0; q < n; q += 4) { float x = frnd() * 640; memcpy(p + q, &x, 4); } }   // particles: new every frame
            d->Unlock();
            dev->SetStreamSource(0, d, 36);
            dev->DrawPrimitive(4, off / 36, n / 36 / 3);
            off += n;
        }
        dev->SetVertexShader(0x342);
        dev->DrawIndexedPrimitiveUP(4, 0, 4, 2, fogi, D3DFMT_INDEX16, fogv, 40);
        dev->SetVertexShader(0x144);
        for (int k = 0; k < 12; k++) { if (k == 0) text[fr % text.size()] ^= 1; dev->DrawPrimitiveUP(4, 40, text.data(), 36); }
        dev->EndScene();
        dev->Present(nullptr, nullptr, nullptr, nullptr);
    }
    QueryPerformanceCounter(&t2);
    for (auto* t : tex) t->Release();
    for (auto* v : mvb) v->Release();
    for (auto* i : mib) i->Release();
    for (auto* d : dyn) d->Release();
    dev->Release(); d3d->Release();
    finish();
    double load = (t1.QuadPart - t0.QuadPart) * 1000.0 / f.QuadPart, run_ = (t2.QuadPart - t1.QuadPart) * 1000.0 / f.QuadPart;
    printf("enabled=%d: startup %.1f ms, %d frames in %.1f ms = %.3f ms/frame\n", enabled, load, frames, run_, run_ / frames);
    return 0;
}
