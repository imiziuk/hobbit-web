// Fake D3D8 runtime for the offline recorder test: real COM objects with memory-backed resources, no window,
// no GPU. Lock pointers point into heap memory (texture pitches are padded on purpose so the recorder's row packing
// is exercised). The back buffer content is whatever the test sets with Mock_SetBackBuffer (the synthetic test puts
// its CPU-rendered expectation there, so the recorder's shot = ground truth for the replayer diff).
#include "../src/d3d8min.h"
#include <vector>
#include <string.h>

static uint32_t bpp(DWORD f) {
    switch (f) { case D3DFMT_A8R8G8B8: case D3DFMT_X8R8G8B8: return 4; case D3DFMT_R5G6B5: case D3DFMT_A1R5G5B5:
    case D3DFMT_X1R5G5B5: case D3DFMT_A4R4G4B4: return 2; case D3DFMT_A8: case D3DFMT_L8: return 1; }
    return 4;
}
static bool dxt(DWORD f) { return f == D3DFMT_DXT1 || f == D3DFMT_DXT2 || f == D3DFMT_DXT3 || f == D3DFMT_DXT4 || f == D3DFMT_DXT5; }

struct MDevice;
struct Level { UINT w, h; INT pitch; UINT rows; std::vector<uint8_t> mem; };
static Level makeLevel(DWORD fmt, UINT w, UINT h) {
    Level l{w, h, 0, 0, {}};
    if (dxt(fmt)) { UINT bw = (w + 3) / 4; l.rows = (h + 3) / 4; l.pitch = bw * (fmt == D3DFMT_DXT1 ? 8 : 16) + 32; }
    else { l.rows = h; l.pitch = w * bpp(fmt) + 12; }   // padded pitch
    l.mem.assign((size_t)l.pitch * l.rows, 0xCD);
    return l;
}
static void* lockPtr(DWORD fmt, Level& l, const RECT* rc) {
    if (!rc) return l.mem.data();
    if (dxt(fmt)) return l.mem.data() + (rc->top / 4) * l.pitch + (rc->left / 4) * (fmt == D3DFMT_DXT1 ? 8 : 16);
    return l.mem.data() + rc->top * l.pitch + rc->left * bpp(fmt);
}

#define S HRESULT __stdcall
#define OKS(sig) S sig override { return D3D_OK; }

struct MTex;
struct MSurf : IDirect3DSurface8 {
    LONG ref = 1; MDevice* dev; MTex* tex; UINT lvl; DWORD fmt; Level own; Level* L;
    MSurf(MDevice* d, MTex* t, UINT l, DWORD f, Level* lv) : dev(d), tex(t), lvl(l), fmt(f), L(lv) {}
    MSurf(MDevice* d, DWORD f, UINT w, UINT h) : dev(d), tex(nullptr), lvl(0), fmt(f) { own = makeLevel(f, w, h); L = &own; }
    S QueryInterface(REFIID, void** p) override { *p = this; AddRef(); return S_OK; }
    ULONG __stdcall AddRef() override;
    ULONG __stdcall Release() override;
    S GetDevice(IDirect3DDevice8** p) override;
    OKS(SetPrivateData(REFGUID, const void*, DWORD, DWORD)) OKS(GetPrivateData(REFGUID, void*, DWORD*)) OKS(FreePrivateData(REFGUID))
    S GetContainer(REFIID, void** p) override;
    S GetDesc(D3DSURFACE_DESC* d) override { memset(d, 0, sizeof *d); d->Format = fmt; d->Type = 1; d->Width = L->w; d->Height = L->h; d->Size = L->pitch * L->rows; return S_OK; }
    S LockRect(D3DLOCKED_RECT* lr, const RECT* rc, DWORD) override { lr->Pitch = L->pitch; lr->pBits = lockPtr(fmt, *L, rc); return S_OK; }
    S UnlockRect() override { return S_OK; }
};

struct MTex : IDirect3DTexture8 {
    LONG ref = 1; MDevice* dev; DWORD fmt; std::vector<Level> lv; std::vector<MSurf*> surf;
    MTex(MDevice* d, UINT w, UINT h, UINT n, DWORD f) : dev(d), fmt(f) {
        if (!n) { n = 1; for (UINT s = w > h ? w : h; s > 1; s >>= 1) n++; }
        lv.reserve(n);
        for (UINT i = 0; i < n; i++) lv.push_back(makeLevel(f, w >> i ? w >> i : 1, h >> i ? h >> i : 1));
        surf.assign(n, nullptr);
    }
    ~MTex() { for (auto* s : surf) delete s; }
    S QueryInterface(REFIID, void** p) override { *p = this; AddRef(); return S_OK; }
    ULONG __stdcall AddRef() override { return InterlockedIncrement(&ref); }
    ULONG __stdcall Release() override { LONG r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    S GetDevice(IDirect3DDevice8** p) override;
    OKS(SetPrivateData(REFGUID, const void*, DWORD, DWORD)) OKS(GetPrivateData(REFGUID, void*, DWORD*)) OKS(FreePrivateData(REFGUID))
    DWORD __stdcall SetPriority(DWORD) override { return 0; } DWORD __stdcall GetPriority() override { return 0; }
    void __stdcall PreLoad() override {} D3DRESOURCETYPE __stdcall GetType() override { return 3; }
    DWORD __stdcall SetLOD(DWORD) override { return 0; } DWORD __stdcall GetLOD() override { return 0; }
    DWORD __stdcall GetLevelCount() override { return (DWORD)lv.size(); }
    S GetLevelDesc(UINT l, D3DSURFACE_DESC* d) override { memset(d, 0, sizeof *d); d->Format = fmt; d->Type = 1; d->Width = lv[l].w; d->Height = lv[l].h; return S_OK; }
    S GetSurfaceLevel(UINT l, IDirect3DSurface8** p) override {
        if (l >= lv.size()) return D3DERR_INVALIDCALL;
        if (!surf[l]) surf[l] = new MSurf(dev, this, l, fmt, &lv[l]);
        AddRef(); *p = surf[l]; return S_OK;
    }
    S LockRect(UINT l, D3DLOCKED_RECT* lr, const RECT* rc, DWORD) override { lr->Pitch = lv[l].pitch; lr->pBits = lockPtr(fmt, lv[l], rc); return S_OK; }
    S UnlockRect(UINT) override { return S_OK; }
    OKS(AddDirtyRect(const RECT*))
};
// texture-level surfaces share the container's count (D3D8/9 behaviour)
ULONG MSurf::AddRef() { return tex ? tex->AddRef() : InterlockedIncrement(&ref); }
ULONG MSurf::Release() { if (tex) return tex->Release(); LONG r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
S MSurf::GetContainer(REFIID, void** p) { if (!tex) return E_NOINTERFACE; tex->AddRef(); *p = tex; return S_OK; }

template <class I, class D>
struct MBuf : I {
    LONG ref = 1; MDevice* dev; std::vector<uint8_t> mem; DWORD usage, fmt;
    MBuf(MDevice* d, UINT n, DWORD u, DWORD f) : dev(d), mem(n, 0xEE), usage(u), fmt(f) {}
    S QueryInterface(REFIID, void** p) override { *p = this; AddRef(); return S_OK; }
    ULONG __stdcall AddRef() override { return InterlockedIncrement(&ref); }
    ULONG __stdcall Release() override { LONG r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    S GetDevice(IDirect3DDevice8** p) override;
    OKS(SetPrivateData(REFGUID, const void*, DWORD, DWORD)) OKS(GetPrivateData(REFGUID, void*, DWORD*)) OKS(FreePrivateData(REFGUID))
    DWORD __stdcall SetPriority(DWORD) override { return 0; } DWORD __stdcall GetPriority() override { return 0; }
    void __stdcall PreLoad() override {} D3DRESOURCETYPE __stdcall GetType() override { return 6; }
    S Lock(UINT off, UINT, BYTE** p, DWORD) override { *p = mem.data() + off; return S_OK; }
    S Unlock() override { return S_OK; }
    S GetDesc(D* d) override { memset(d, 0, sizeof *d); d->Size = (UINT)mem.size(); d->Usage = usage; d->Format = fmt; return S_OK; }
};
typedef MBuf<IDirect3DVertexBuffer8, D3DVERTEXBUFFER_DESC> MVB;
typedef MBuf<IDirect3DIndexBuffer8, D3DINDEXBUFFER_DESC> MIB;

struct MD3D;
struct MDevice : IDirect3DDevice8 {
    LONG ref = 1; MD3D* d3d; MSurf* bb; DWORD token = 0x1000; DWORD rs[256] = {};
    MDevice(MD3D* p, UINT w, UINT h) : d3d(p) { bb = new MSurf(this, D3DFMT_X8R8G8B8, w, h); }
    S QueryInterface(REFIID, void** p) override { *p = this; AddRef(); return S_OK; }
    ULONG __stdcall AddRef() override { return InterlockedIncrement(&ref); }
    ULONG __stdcall Release() override { LONG r = InterlockedDecrement(&ref); if (!r) { bb->Release(); delete this; } return r; }
    OKS(TestCooperativeLevel()) UINT __stdcall GetAvailableTextureMem() override { return 64u << 20; }
    OKS(ResourceManagerDiscardBytes(DWORD))
    S GetDirect3D(IDirect3D8** p) override;
    S GetDeviceCaps(D3DCAPS8* c) override { memset(c, 0, sizeof *c); c->v[45] = 0xFFFFF; return S_OK; }
    S GetDisplayMode(D3DDISPLAYMODE* m) override { m->Width = 1920; m->Height = 1080; m->RefreshRate = 60; m->Format = D3DFMT_X8R8G8B8; return S_OK; }
    OKS(GetCreationParameters(D3DDEVICE_CREATION_PARAMETERS*)) OKS(SetCursorProperties(UINT, UINT, IDirect3DSurface8*))
    void __stdcall SetCursorPosition(int, int, DWORD) override {} BOOL __stdcall ShowCursor(BOOL) override { return TRUE; }
    S CreateAdditionalSwapChain(D3DPRESENT_PARAMETERS*, IDirect3DSwapChain8**) override { return D3DERR_INVALIDCALL; }
    OKS(Reset(D3DPRESENT_PARAMETERS*)) OKS(Present(const RECT*, const RECT*, HWND, const RGNDATA*))
    S GetBackBuffer(UINT, D3DBACKBUFFER_TYPE, IDirect3DSurface8** p) override { bb->AddRef(); *p = bb; return S_OK; }
    OKS(GetRasterStatus(D3DRASTER_STATUS*))
    void __stdcall SetGammaRamp(DWORD, const D3DGAMMARAMP*) override {}
    void __stdcall GetGammaRamp(D3DGAMMARAMP* r) override { for (int i = 0; i < 256; i++) r->red[i] = r->green[i] = r->blue[i] = (WORD)(i * 257); }
    S CreateTexture(UINT w, UINT h, UINT l, DWORD, D3DFORMAT f, D3DPOOL, IDirect3DTexture8** p) override { *p = new MTex(this, w, h, l, f); return S_OK; }
    S CreateVolumeTexture(UINT, UINT, UINT, UINT, DWORD, D3DFORMAT, D3DPOOL, IDirect3DVolumeTexture8**) override { return D3DERR_INVALIDCALL; }
    S CreateCubeTexture(UINT, UINT, DWORD, D3DFORMAT, D3DPOOL, IDirect3DCubeTexture8**) override { return D3DERR_INVALIDCALL; }
    S CreateVertexBuffer(UINT n, DWORD u, DWORD fvf, D3DPOOL, IDirect3DVertexBuffer8** p) override { *p = new MVB(this, n, u, fvf); return S_OK; }
    S CreateIndexBuffer(UINT n, DWORD u, D3DFORMAT f, D3DPOOL, IDirect3DIndexBuffer8** p) override { *p = new MIB(this, n, u, f); return S_OK; }
    S CreateRenderTarget(UINT w, UINT h, D3DFORMAT f, D3DMULTISAMPLE_TYPE, BOOL, IDirect3DSurface8** p) override { *p = new MSurf(this, f, w, h); return S_OK; }
    S CreateDepthStencilSurface(UINT w, UINT h, D3DFORMAT f, D3DMULTISAMPLE_TYPE, IDirect3DSurface8** p) override { *p = new MSurf(this, f, w, h); return S_OK; }
    S CreateImageSurface(UINT w, UINT h, D3DFORMAT f, IDirect3DSurface8** p) override { *p = new MSurf(this, f, w, h); return S_OK; }
    S CopyRects(IDirect3DSurface8* s, const RECT* rc, UINT n, IDirect3DSurface8* d, const POINT*) override {
        MSurf* a = (MSurf*)s; MSurf* b = (MSurf*)d;
        if (rc || n || a->fmt != b->fmt || a->L->w != b->L->w || a->L->h != b->L->h) return D3DERR_INVALIDCALL;   // only what the recorder's shot uses
        for (UINT y = 0; y < a->L->rows; y++) memcpy(&b->L->mem[y * b->L->pitch], &a->L->mem[y * a->L->pitch], a->L->w * bpp(a->fmt));
        return S_OK;
    }
    OKS(UpdateTexture(IDirect3DBaseTexture8*, IDirect3DBaseTexture8*)) OKS(GetFrontBuffer(IDirect3DSurface8*))
    OKS(SetRenderTarget(IDirect3DSurface8*, IDirect3DSurface8*))
    S GetRenderTarget(IDirect3DSurface8** p) override { bb->AddRef(); *p = bb; return S_OK; }
    S GetDepthStencilSurface(IDirect3DSurface8** p) override { *p = nullptr; return D3DERR_INVALIDCALL; }
    OKS(BeginScene()) OKS(EndScene()) OKS(Clear(DWORD, const D3DRECT*, DWORD, D3DCOLOR, float, DWORD))
    OKS(SetTransform(D3DTRANSFORMSTATETYPE, const D3DMATRIX*))
    S GetTransform(D3DTRANSFORMSTATETYPE, D3DMATRIX* m) override { memset(m, 0, 64); for (int i = 0; i < 4; i++) m->m[i][i] = 1; return S_OK; }
    OKS(MultiplyTransform(D3DTRANSFORMSTATETYPE, const D3DMATRIX*)) OKS(SetViewport(const D3DVIEWPORT8*))
    S GetViewport(D3DVIEWPORT8* v) override { v->X = v->Y = 0; v->Width = bb->L->w; v->Height = bb->L->h; v->MinZ = 0; v->MaxZ = 1; return S_OK; }
    OKS(SetMaterial(const D3DMATERIAL8*)) S GetMaterial(D3DMATERIAL8* m) override { memset(m, 0, sizeof *m); return S_OK; }
    OKS(SetLight(DWORD, const D3DLIGHT8*)) S GetLight(DWORD, D3DLIGHT8* l) override { memset(l, 0, sizeof *l); return S_OK; }
    OKS(LightEnable(DWORD, BOOL)) S GetLightEnable(DWORD, BOOL* b) override { *b = FALSE; return S_OK; }
    OKS(SetClipPlane(DWORD, const float*)) OKS(GetClipPlane(DWORD, float*))
    S SetRenderState(D3DRENDERSTATETYPE s, DWORD v) override { if (s < 256) rs[s] = v; return S_OK; }
    S GetRenderState(D3DRENDERSTATETYPE s, DWORD* v) override { *v = s < 256 ? rs[s] : 0; return S_OK; }
    OKS(BeginStateBlock()) S EndStateBlock(DWORD* t) override { *t = ++token; return S_OK; }
    OKS(ApplyStateBlock(DWORD)) OKS(CaptureStateBlock(DWORD)) OKS(DeleteStateBlock(DWORD))
    S CreateStateBlock(D3DSTATEBLOCKTYPE, DWORD* t) override { *t = ++token; return S_OK; }
    OKS(SetClipStatus(const D3DCLIPSTATUS8*)) OKS(GetClipStatus(D3DCLIPSTATUS8*))
    S GetTexture(DWORD, IDirect3DBaseTexture8** p) override { *p = nullptr; return S_OK; }
    OKS(SetTexture(DWORD, IDirect3DBaseTexture8*))
    S GetTextureStageState(DWORD, D3DTEXTURESTAGESTATETYPE, DWORD* v) override { *v = 0; return S_OK; }
    OKS(SetTextureStageState(DWORD, D3DTEXTURESTAGESTATETYPE, DWORD))
    S ValidateDevice(DWORD* n) override { *n = 1; return S_OK; }
    OKS(GetInfo(DWORD, void*, DWORD)) OKS(SetPaletteEntries(UINT, const PALETTEENTRY*)) OKS(GetPaletteEntries(UINT, PALETTEENTRY*))
    OKS(SetCurrentTexturePalette(UINT)) S GetCurrentTexturePalette(UINT* p) override { *p = 0; return S_OK; }
    OKS(DrawPrimitive(D3DPRIMITIVETYPE, UINT, UINT)) OKS(DrawIndexedPrimitive(D3DPRIMITIVETYPE, UINT, UINT, UINT, UINT))
    OKS(DrawPrimitiveUP(D3DPRIMITIVETYPE, UINT, const void*, UINT))
    OKS(DrawIndexedPrimitiveUP(D3DPRIMITIVETYPE, UINT, UINT, UINT, const void*, D3DFORMAT, const void*, UINT))
    OKS(ProcessVertices(UINT, UINT, UINT, IDirect3DVertexBuffer8*, DWORD))
    S CreateVertexShader(const DWORD*, const DWORD*, DWORD* h, DWORD) override { *h = 1; return S_OK; }
    OKS(SetVertexShader(DWORD)) S GetVertexShader(DWORD* h) override { *h = 0; return S_OK; } OKS(DeleteVertexShader(DWORD))
    OKS(SetVertexShaderConstant(DWORD, const void*, DWORD)) OKS(GetVertexShaderConstant(DWORD, void*, DWORD))
    OKS(GetVertexShaderDeclaration(DWORD, void*, DWORD*)) OKS(GetVertexShaderFunction(DWORD, void*, DWORD*))
    OKS(SetStreamSource(UINT, IDirect3DVertexBuffer8*, UINT))
    S GetStreamSource(UINT, IDirect3DVertexBuffer8** p, UINT* s) override { *p = nullptr; *s = 0; return S_OK; }
    OKS(SetIndices(IDirect3DIndexBuffer8*, UINT))
    S GetIndices(IDirect3DIndexBuffer8** p, UINT* b) override { *p = nullptr; *b = 0; return S_OK; }
    S CreatePixelShader(const DWORD*, DWORD* h) override { *h = 1; return S_OK; }
    OKS(SetPixelShader(DWORD)) S GetPixelShader(DWORD* h) override { *h = 0; return S_OK; } OKS(DeletePixelShader(DWORD))
    OKS(SetPixelShaderConstant(DWORD, const void*, DWORD)) OKS(GetPixelShaderConstant(DWORD, void*, DWORD))
    OKS(GetPixelShaderFunction(DWORD, void*, DWORD*))
    OKS(DrawRectPatch(UINT, const float*, const D3DRECTPATCH_INFO*)) OKS(DrawTriPatch(UINT, const float*, const D3DTRIPATCH_INFO*)) OKS(DeletePatch(UINT))
};
S MSurf::GetDevice(IDirect3DDevice8** p) { dev->AddRef(); *p = dev; return S_OK; }
S MTex::GetDevice(IDirect3DDevice8** p) { dev->AddRef(); *p = dev; return S_OK; }
template <class I, class D> S MBuf<I, D>::GetDevice(IDirect3DDevice8** p) { dev->AddRef(); *p = dev; return S_OK; }

static MDevice* s_dev;
struct MD3D : IDirect3D8 {
    LONG ref = 1;
    S QueryInterface(REFIID, void** p) override { *p = this; AddRef(); return S_OK; }
    ULONG __stdcall AddRef() override { return InterlockedIncrement(&ref); }
    ULONG __stdcall Release() override { LONG r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    OKS(RegisterSoftwareDevice(void*)) UINT __stdcall GetAdapterCount() override { return 1; }
    S GetAdapterIdentifier(UINT, DWORD, D3DADAPTER_IDENTIFIER8* p) override { memset(p, 0, sizeof *p); strcpy_s(p->Description, "mock_d3d8"); return S_OK; }
    UINT __stdcall GetAdapterModeCount(UINT) override { return 2; }
    S EnumAdapterModes(UINT, UINT m, D3DDISPLAYMODE* p) override { p->Width = m ? 800 : 640; p->Height = m ? 600 : 480; p->RefreshRate = 60; p->Format = D3DFMT_X8R8G8B8; return S_OK; }
    S GetAdapterDisplayMode(UINT, D3DDISPLAYMODE* p) override { p->Width = 1920; p->Height = 1080; p->RefreshRate = 60; p->Format = D3DFMT_X8R8G8B8; return S_OK; }
    OKS(CheckDeviceType(UINT, D3DDEVTYPE, D3DFORMAT, D3DFORMAT, BOOL)) OKS(CheckDeviceFormat(UINT, D3DDEVTYPE, D3DFORMAT, DWORD, D3DRESOURCETYPE, D3DFORMAT))
    OKS(CheckDeviceMultiSampleType(UINT, D3DDEVTYPE, D3DFORMAT, BOOL, D3DMULTISAMPLE_TYPE)) OKS(CheckDepthStencilMatch(UINT, D3DDEVTYPE, D3DFORMAT, D3DFORMAT, D3DFORMAT))
    S GetDeviceCaps(UINT, D3DDEVTYPE, D3DCAPS8* c) override { memset(c, 0, sizeof *c); return S_OK; }
    HMONITOR __stdcall GetAdapterMonitor(UINT) override { return (HMONITOR)1; }
    S CreateDevice(UINT, D3DDEVTYPE, HWND, DWORD, D3DPRESENT_PARAMETERS* pp, IDirect3DDevice8** p) override {
        s_dev = new MDevice(this, pp->BackBufferWidth, pp->BackBufferHeight); AddRef(); *p = s_dev; return S_OK;
    }
};
S MDevice::GetDirect3D(IDirect3D8** p) { d3d->AddRef(); *p = d3d; return S_OK; }

extern "C" IDirect3D8* WINAPI Direct3DCreate8(UINT) { return new MD3D(); }
// test side channel: the back buffer content (X8R8G8B8 rows, tightly packed) the next shot will see
extern "C" void WINAPI Mock_SetBackBuffer(const void* bgra) {
    if (!s_dev) return;
    Level* L = s_dev->bb->L;
    for (UINT y = 0; y < L->h; y++) memcpy(&L->mem[y * L->pitch], (const uint8_t*)bgra + y * L->w * 4, L->w * 4);
}
