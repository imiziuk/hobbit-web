// COM wrappers: IDirect3D8, IDirect3DDevice8, IDirect3DTexture8, IDirect3DSurface8, IDirect3DVertexBuffer8,
// IDirect3DIndexBuffer8. Every method forwards to the real object first, then writes one record (rec.h) with the
// arguments, outputs and return value. Lock data is captured at Unlock (before the real Unlock, while the pointer is
// still valid). Cube/volume textures and extra swap chains are not used by Meridian.exe: they are forwarded unwrapped
// (Meta::Unwrapped records them) so the game still works if something unexpected creates one.
#include "wrap.h"
#include <string.h>

namespace d3drec {

/* ------------------------------------------------------------------ object map: real pointer -> wrapper */
struct Ent { void* w; uint32_t id; int kind; };
enum { K_D3D, K_DEV, K_TEX, K_SURF, K_VB, K_IB, K_N };
static CRITICAL_SECTION s_mapCs;
static std::unordered_map<void*, Ent>* s_map;
static void* s_vt[K_N];   // vtable pointer of each wrapper class (set by the first constructor)

void wrapInit() {
    InitializeCriticalSection(&s_mapCs);
    s_map = new std::unordered_map<void*, Ent>();
}
static void mapAdd(void* real, void* w, uint32_t id, int kind) {
    EnterCriticalSection(&s_mapCs);
    (*s_map)[real] = {w, id, kind};
    if (!s_vt[kind]) s_vt[kind] = *(void**)w;
    LeaveCriticalSection(&s_mapCs);
}
static void mapDel(void* real) {
    EnterCriticalSection(&s_mapCs);
    s_map->erase(real);
    LeaveCriticalSection(&s_mapCs);
}
static bool mapGet(void* real, Ent& e) {
    EnterCriticalSection(&s_mapCs);
    auto it = s_map->find(real);
    bool ok = it != s_map->end();
    if (ok) e = it->second;
    LeaveCriticalSection(&s_mapCs);
    return ok;
}
static inline bool isKind(const void* p, int k) { return p && s_vt[k] && *(void* const*)p == s_vt[k]; }

struct WD3D; struct WDevice; struct WTex; struct WSurf;
template <class I, class D, int OPB> struct WBuf;
typedef WBuf<IDirect3DVertexBuffer8, D3DVERTEXBUFFER_DESC, OP_VB_QueryInterface> WVB;
typedef WBuf<IDirect3DIndexBuffer8, D3DINDEXBUFFER_DESC, OP_IB_QueryInterface> WIB;

static thread_local std::vector<uint8_t> t_pack;

struct LockSt { bool active = false; D3DLOCKED_RECT lr{}; RECT rc{}; bool hasRect = false; DWORD flags = 0; };

// Rows of a locked rect, packed (no pitch). Points straight at the locked memory when it already is packed.
static DataArg packRows(const D3DSURFACE_DESC& d, const LockSt& lk, uint32_t& rowBytes, uint32_t& rows) {
    DataArg da;
    FmtInfo fi = fmtInfo(d.Format);
    uint32_t w = lk.hasRect ? (uint32_t)(lk.rc.right - lk.rc.left) : d.Width;
    uint32_t h = lk.hasRect ? (uint32_t)(lk.rc.bottom - lk.rc.top) : d.Height;
    if (fi.block) { rowBytes = (w + 3) / 4 * fi.block; rows = (h + 3) / 4; }
    else { rowBytes = w * fi.bpp; rows = h; }
    if (lk.flags & D3DLOCK_READONLY || !lk.lr.pBits) return da;
    const uint8_t* src = (const uint8_t*)lk.lr.pBits;
    if ((uint32_t)lk.lr.Pitch == rowBytes) { da.p = src; da.len = rowBytes * rows; return da; }
    t_pack.resize((size_t)rowBytes * rows);
    for (uint32_t y = 0; y < rows; y++) memcpy(t_pack.data() + (size_t)y * rowBytes, src + (size_t)y * lk.lr.Pitch, rowBytes);
    da.p = t_pack.data(); da.len = rowBytes * rows;
    return da;
}

#define OUTP(p) (SUCCEEDED(hr) && (p) ? (const void*)(p) : (const void*)nullptr)
static uint32_t U(const void* p) { return (uint32_t)(uintptr_t)p; }

/* ================================================================== IDirect3DSurface8 */
struct WSurf : IDirect3DSurface8 {
    IDirect3DSurface8* r; uint32_t id; WDevice* dev; WTex* tex; UINT level;
    LockSt lk; D3DSURFACE_DESC desc{}; bool haveDesc = false;
    WSurf(IDirect3DSurface8* real, WDevice* d, WTex* t, UINT l) : r(real), id(g.newId()), dev(d), tex(t), level(l) { mapAdd(r, this, id, K_SURF); }
    void destroy() { mapDel(r); g.rec(OP_Meta_Destroy, 0, S_OK, id); delete this; }
    HRESULT __stdcall QueryInterface(REFIID riid, void** ppv) override;
    ULONG __stdcall AddRef() override { ULONG c = r->AddRef(); g.rec(OP_Surface_AddRef, id, S_OK, c); return c; }
    ULONG __stdcall Release() override;
    HRESULT __stdcall GetDevice(IDirect3DDevice8** pp) override;
    HRESULT __stdcall SetPrivateData(REFGUID g_, const void* p, DWORD n, DWORD f) override { HRESULT hr = r->SetPrivateData(g_, p, n, f); g.rec(OP_Surface_SetPrivateData, id, hr); return hr; }
    HRESULT __stdcall GetPrivateData(REFGUID g_, void* p, DWORD* n) override { HRESULT hr = r->GetPrivateData(g_, p, n); g.rec(OP_Surface_GetPrivateData, id, hr); return hr; }
    HRESULT __stdcall FreePrivateData(REFGUID g_) override { HRESULT hr = r->FreePrivateData(g_); g.rec(OP_Surface_FreePrivateData, id, hr); return hr; }
    HRESULT __stdcall GetContainer(REFIID riid, void** ppv) override;
    HRESULT __stdcall GetDesc(D3DSURFACE_DESC* d) override { HRESULT hr = r->GetDesc(d); g.rec(OP_Surface_GetDesc, id, hr, OUTP(d), 32u); return hr; }
    HRESULT __stdcall LockRect(D3DLOCKED_RECT* lr, const RECT* rc, DWORD flags) override {
        HRESULT hr = r->LockRect(lr, rc, flags);
        if (SUCCEEDED(hr) && lr) { lk.active = true; lk.lr = *lr; lk.hasRect = rc != nullptr; if (rc) lk.rc = *rc; lk.flags = flags; }
        g.rec(OP_Surface_LockRect, id, hr, rc, flags);
        return hr;
    }
    HRESULT __stdcall UnlockRect() override {
        if (lk.active) {
            if (!haveDesc) { haveDesc = SUCCEEDED(r->GetDesc(&desc)); }
            uint32_t rowBytes = 0, rows = 0;
            DataArg da = packRows(desc, lk, rowBytes, rows);
            g.rec(OP_Surface_UnlockRect, id, S_OK, rowBytes, rows, &da);
            lk.active = false;
        } else g.rec(OP_Surface_UnlockRect, id, S_OK, 0u, 0u, (const DataArg*)nullptr);
        HRESULT hr = r->UnlockRect();
        if (FAILED(hr)) g.event("Surface %u UnlockRect failed %08lx", id, hr);
        return hr;
    }
};

/* ================================================================== IDirect3DTexture8 */
struct WTex : IDirect3DTexture8 {
    IDirect3DTexture8* r; uint32_t id; WDevice* dev;
    std::vector<WSurf*> lv, owned; std::vector<LockSt> lk; std::vector<D3DSURFACE_DESC> desc; std::vector<char> haveDesc;
    WTex(IDirect3DTexture8* real, WDevice* d) : r(real), id(g.newId()), dev(d) {
        DWORD n = r->GetLevelCount();
        lv.assign(n, nullptr); lk.resize(n); desc.resize(n); haveDesc.assign(n, 0);
        mapAdd(r, this, id, K_TEX);
    }
    void destroy() {
        for (WSurf* s : owned) s->destroy();
        mapDel(r); g.rec(OP_Meta_Destroy, 0, S_OK, id); delete this;
    }
    WSurf* surfFor(UINT l, IDirect3DSurface8* rs) {
        Ent e;
        if (mapGet(rs, e) && e.kind == K_SURF) return (WSurf*)e.w;
        WSurf* w = new WSurf(rs, dev, this, l);
        owned.push_back(w);
        if (l < lv.size()) lv[l] = w;
        return w;
    }
    const D3DSURFACE_DESC& levelDesc(UINT l) {
        if (!haveDesc[l]) haveDesc[l] = SUCCEEDED(r->GetLevelDesc(l, &desc[l]));
        return desc[l];
    }
    HRESULT __stdcall QueryInterface(REFIID riid, void** ppv) override;
    ULONG __stdcall AddRef() override { ULONG c = r->AddRef(); g.rec(OP_Texture_AddRef, id, S_OK, c); return c; }
    ULONG __stdcall Release() override {
        ULONG c = r->Release(); g.rec(OP_Texture_Release, id, S_OK, c);
        if (c == 0) destroy();
        return c;
    }
    HRESULT __stdcall GetDevice(IDirect3DDevice8** pp) override;
    HRESULT __stdcall SetPrivateData(REFGUID g_, const void* p, DWORD n, DWORD f) override { HRESULT hr = r->SetPrivateData(g_, p, n, f); g.rec(OP_Texture_SetPrivateData, id, hr); return hr; }
    HRESULT __stdcall GetPrivateData(REFGUID g_, void* p, DWORD* n) override { HRESULT hr = r->GetPrivateData(g_, p, n); g.rec(OP_Texture_GetPrivateData, id, hr); return hr; }
    HRESULT __stdcall FreePrivateData(REFGUID g_) override { HRESULT hr = r->FreePrivateData(g_); g.rec(OP_Texture_FreePrivateData, id, hr); return hr; }
    DWORD __stdcall SetPriority(DWORD p) override { DWORD o = r->SetPriority(p); g.rec(OP_Texture_SetPriority, id, S_OK, p, o); return o; }
    DWORD __stdcall GetPriority() override { DWORD o = r->GetPriority(); g.rec(OP_Texture_GetPriority, id, S_OK, o); return o; }
    void __stdcall PreLoad() override { r->PreLoad(); g.rec(OP_Texture_PreLoad, id, S_OK); }
    D3DRESOURCETYPE __stdcall GetType() override { DWORD t = r->GetType(); g.rec(OP_Texture_GetType, id, S_OK, t); return t; }
    DWORD __stdcall SetLOD(DWORD n) override { DWORD o = r->SetLOD(n); g.rec(OP_Texture_SetLOD, id, S_OK, n, o); return o; }
    DWORD __stdcall GetLOD() override { DWORD o = r->GetLOD(); g.rec(OP_Texture_GetLOD, id, S_OK, o); return o; }
    DWORD __stdcall GetLevelCount() override { DWORD o = r->GetLevelCount(); g.rec(OP_Texture_GetLevelCount, id, S_OK, o); return o; }
    HRESULT __stdcall GetLevelDesc(UINT l, D3DSURFACE_DESC* d) override { HRESULT hr = r->GetLevelDesc(l, d); g.rec(OP_Texture_GetLevelDesc, id, hr, l, OUTP(d), 32u); return hr; }
    HRESULT __stdcall GetSurfaceLevel(UINT l, IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr;
        HRESULT hr = r->GetSurfaceLevel(l, &rs);
        uint32_t oid = 0;
        if (SUCCEEDED(hr) && rs) { WSurf* w = surfFor(l, rs); *pp = w; oid = w->id; }
        else if (pp) *pp = rs;
        g.rec(OP_Texture_GetSurfaceLevel, id, hr, l, oid);
        return hr;
    }
    HRESULT __stdcall LockRect(UINT l, D3DLOCKED_RECT* lr, const RECT* rc, DWORD flags) override {
        HRESULT hr = r->LockRect(l, lr, rc, flags);
        if (SUCCEEDED(hr) && lr && l < lk.size()) { LockSt& s = lk[l]; s.active = true; s.lr = *lr; s.hasRect = rc != nullptr; if (rc) s.rc = *rc; s.flags = flags; }
        g.rec(OP_Texture_LockRect, id, hr, l, rc, flags);
        return hr;
    }
    HRESULT __stdcall UnlockRect(UINT l) override {
        if (l < lk.size() && lk[l].active) {
            uint32_t rowBytes = 0, rows = 0;
            DataArg da = packRows(levelDesc(l), lk[l], rowBytes, rows);
            g.rec(OP_Texture_UnlockRect, id, S_OK, l, rowBytes, rows, &da);
            lk[l].active = false;
        } else g.rec(OP_Texture_UnlockRect, id, S_OK, l, 0u, 0u, (const DataArg*)nullptr);
        HRESULT hr = r->UnlockRect(l);
        if (FAILED(hr)) g.event("Texture %u UnlockRect(%u) failed %08lx", id, l, hr);
        return hr;
    }
    HRESULT __stdcall AddDirtyRect(const RECT* rc) override { HRESULT hr = r->AddDirtyRect(rc); g.rec(OP_Texture_AddDirtyRect, id, hr, rc); return hr; }
};

/* ================================================================== vertex / index buffers */
template <class I, class D, int OPB>
struct WBuf : I {
    I* r; uint32_t id; WDevice* dev; UINT len;
    std::vector<uint8_t> shadow;   // = the replayer's copy of the buffer (zero-filled like the replayer's)
    struct L { UINT off, size; BYTE* p; DWORD flags; };
    std::vector<L> locks;
    WBuf(I* real, WDevice* d, UINT length, int kind) : r(real), id(g.newId()), dev(d), len(length) { mapAdd(r, this, id, kind); }
    void destroy() { mapDel(r); g.rec(OP_Meta_Destroy, 0, S_OK, id); delete this; }
    HRESULT __stdcall QueryInterface(REFIID riid, void** ppv) override {
        HRESULT hr = r->QueryInterface(riid, ppv);
        uint32_t oid = 0;
        if (SUCCEEDED(hr) && ppv && *ppv == (void*)r) { *ppv = this; oid = id; }
        g.rec(OPB + 0, id, hr, &riid, 16u, oid);
        return hr;
    }
    ULONG __stdcall AddRef() override { ULONG c = r->AddRef(); g.rec(OPB + 1, id, S_OK, c); return c; }
    ULONG __stdcall Release() override { ULONG c = r->Release(); g.rec(OPB + 2, id, S_OK, c); if (c == 0) destroy(); return c; }
    HRESULT __stdcall GetDevice(IDirect3DDevice8** pp) override;
    HRESULT __stdcall SetPrivateData(REFGUID g_, const void* p, DWORD n, DWORD f) override { HRESULT hr = r->SetPrivateData(g_, p, n, f); g.rec(OPB + 4, id, hr); return hr; }
    HRESULT __stdcall GetPrivateData(REFGUID g_, void* p, DWORD* n) override { HRESULT hr = r->GetPrivateData(g_, p, n); g.rec(OPB + 5, id, hr); return hr; }
    HRESULT __stdcall FreePrivateData(REFGUID g_) override { HRESULT hr = r->FreePrivateData(g_); g.rec(OPB + 6, id, hr); return hr; }
    DWORD __stdcall SetPriority(DWORD p) override { DWORD o = r->SetPriority(p); g.rec(OPB + 7, id, S_OK, p, o); return o; }
    DWORD __stdcall GetPriority() override { DWORD o = r->GetPriority(); g.rec(OPB + 8, id, S_OK, o); return o; }
    void __stdcall PreLoad() override { r->PreLoad(); g.rec(OPB + 9, id, S_OK); }
    D3DRESOURCETYPE __stdcall GetType() override { DWORD t = r->GetType(); g.rec(OPB + 10, id, S_OK, t); return t; }
    HRESULT __stdcall Lock(UINT off, UINT size, BYTE** pp, DWORD flags) override {
        HRESULT hr = r->Lock(off, size, pp, flags);
        if (SUCCEEDED(hr) && pp && off <= len) {
            UINT sz = size ? size : len - off;
            if (off + sz > len) sz = len - off;
            locks.push_back({off, sz, *pp, flags});
        }
        g.rec(OPB + 11, id, hr, off, size, flags);
        return hr;
    }
    HRESULT __stdcall Unlock() override {
        DataArg da;
        if (!locks.empty()) {
            L l = locks.back(); locks.pop_back();
            if (!(l.flags & D3DLOCK_READONLY) && l.p) {
                da.p = l.p; da.len = l.size;
                if (g.cfg.diff) { if (shadow.size() != len) shadow.assign(len, 0); da.shadow = shadow.data() + l.off; }
            }
        }
        g.rec(OPB + 12, id, S_OK, &da);   // before the real Unlock: the pointer is still valid
        HRESULT hr = r->Unlock();
        if (FAILED(hr)) g.event("buffer %u Unlock failed %08lx", id, hr);
        return hr;
    }
    HRESULT __stdcall GetDesc(D* d) override { HRESULT hr = r->GetDesc(d); g.rec(OPB + 13, id, hr, OUTP(d), (uint32_t)sizeof(D)); return hr; }
};

/* ================================================================== IDirect3DDevice8 */
struct WDevice : IDirect3DDevice8 {
    IDirect3DDevice8* r; uint32_t id; WD3D* d3d;
    int shotFails = 0, shotMethod = -1; bool shotsOff = false, bbLockable = false;
    std::vector<uint8_t> shotBuf;
    WDevice(IDirect3DDevice8* real, WD3D* parent) : r(real), id(g.newId()), d3d(parent) { mapAdd(r, this, id, K_DEV); }

    // unwrap helpers (objects the game passes in are our wrappers; anything else is passed through)
    static IDirect3DSurface8* uS(IDirect3DSurface8* p, uint32_t& oid) { oid = 0; if (isKind(p, K_SURF)) { oid = ((WSurf*)p)->id; return ((WSurf*)p)->r; } return p; }
    static IDirect3DBaseTexture8* uT(IDirect3DBaseTexture8* p, uint32_t& oid) { oid = 0; if (isKind(p, K_TEX)) { oid = ((WTex*)p)->id; return ((WTex*)p)->r; } return p; }
    static IDirect3DVertexBuffer8* uV(IDirect3DVertexBuffer8* p, uint32_t& oid) { oid = 0; if (isKind(p, K_VB)) { oid = ((WVB*)p)->id; return ((WVB*)p)->r; } return p; }
    static IDirect3DIndexBuffer8* uI(IDirect3DIndexBuffer8* p, uint32_t& oid) { oid = 0; if (isKind(p, K_IB)) { oid = ((WIB*)p)->id; return ((WIB*)p)->r; } return p; }
    // wrap a surface the device hands out (back buffer, render target, depth stencil)
    IDirect3DSurface8* wS(IDirect3DSurface8* rs, uint32_t& oid) {
        oid = 0; if (!rs) return rs;
        Ent e; if (mapGet(rs, e)) { oid = e.id; return (IDirect3DSurface8*)e.w; }
        WSurf* w = new WSurf(rs, this, nullptr, 0); oid = w->id; return w;
    }
    template <class T> T* wGet(T* real, uint32_t& oid) {   // existing wrapper or the raw pointer
        oid = 0; if (!real) return real;
        Ent e; if (mapGet(real, e)) { oid = e.id; return (T*)e.w; }
        return real;
    }

    void takeShot();
    bool shotWith(int method, IDirect3DSurface8* bb, const D3DSURFACE_DESC& d, HRESULT& hr, const char*& what);

    HRESULT __stdcall QueryInterface(REFIID riid, void** ppv) override {
        HRESULT hr = r->QueryInterface(riid, ppv); uint32_t oid = 0;
        if (SUCCEEDED(hr) && ppv && *ppv == (void*)r) { *ppv = this; oid = id; }
        g.rec(OP_Device_QueryInterface, id, hr, &riid, 16u, oid); return hr;
    }
    ULONG __stdcall AddRef() override { ULONG c = r->AddRef(); g.rec(OP_Device_AddRef, id, S_OK, c); return c; }
    ULONG __stdcall Release() override {
        ULONG c = r->Release(); g.rec(OP_Device_Release, id, S_OK, c);
        if (c == 0) { mapDel(r); g.rec(OP_Meta_Destroy, 0, S_OK, id); g.flush(5000); delete this; }
        return c;
    }
    HRESULT __stdcall TestCooperativeLevel() override { HRESULT hr = r->TestCooperativeLevel(); g.rec(OP_Device_TestCooperativeLevel, id, hr); return hr; }
    UINT __stdcall GetAvailableTextureMem() override { UINT v = r->GetAvailableTextureMem(); g.rec(OP_Device_GetAvailableTextureMem, id, S_OK, v); return v; }
    HRESULT __stdcall ResourceManagerDiscardBytes(DWORD n) override { HRESULT hr = r->ResourceManagerDiscardBytes(n); g.rec(OP_Device_ResourceManagerDiscardBytes, id, hr, n); return hr; }
    HRESULT __stdcall GetDirect3D(IDirect3D8** pp) override;
    HRESULT __stdcall GetDeviceCaps(D3DCAPS8* c) override { HRESULT hr = r->GetDeviceCaps(c); g.rec(OP_Device_GetDeviceCaps, id, hr, OUTP(c), (uint32_t)sizeof(D3DCAPS8)); return hr; }
    HRESULT __stdcall GetDisplayMode(D3DDISPLAYMODE* m) override { HRESULT hr = r->GetDisplayMode(m); g.rec(OP_Device_GetDisplayMode, id, hr, OUTP(m), 16u); return hr; }
    HRESULT __stdcall GetCreationParameters(D3DDEVICE_CREATION_PARAMETERS* p) override { HRESULT hr = r->GetCreationParameters(p); g.rec(OP_Device_GetCreationParameters, id, hr, OUTP(p), 16u); return hr; }
    HRESULT __stdcall SetCursorProperties(UINT x, UINT y, IDirect3DSurface8* s) override { uint32_t o; HRESULT hr = r->SetCursorProperties(x, y, uS(s, o)); g.rec(OP_Device_SetCursorProperties, id, hr, x, y, o); return hr; }
    void __stdcall SetCursorPosition(int x, int y, DWORD f) override { r->SetCursorPosition(x, y, f); g.rec(OP_Device_SetCursorPosition, id, S_OK, x, y, f); }
    BOOL __stdcall ShowCursor(BOOL b) override { BOOL o = r->ShowCursor(b); g.rec(OP_Device_ShowCursor, id, S_OK, (uint32_t)b, (uint32_t)o); return o; }
    HRESULT __stdcall CreateAdditionalSwapChain(D3DPRESENT_PARAMETERS* pp, IDirect3DSwapChain8** sc) override {
        HRESULT hr = r->CreateAdditionalSwapChain(pp, sc);
        g.rec(OP_Device_CreateAdditionalSwapChain, id, hr, (const void*)pp, 52u, 0u);
        if (SUCCEEDED(hr) && sc) g.rec(OP_Meta_Unwrapped, 0, S_OK, U(*sc), "IDirect3DSwapChain8");
        return hr;
    }
    HRESULT __stdcall Reset(D3DPRESENT_PARAMETERS* pp) override;
    HRESULT __stdcall Present(const RECT* src, const RECT* dst, HWND wnd, const RGNDATA* dirty) override;
    HRESULT __stdcall GetBackBuffer(UINT i, D3DBACKBUFFER_TYPE t, IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr; HRESULT hr = r->GetBackBuffer(i, t, &rs); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wS(rs, oid) : rs;
        g.rec(OP_Device_GetBackBuffer, id, hr, i, t, oid); return hr;
    }
    HRESULT __stdcall GetRasterStatus(D3DRASTER_STATUS* s) override { HRESULT hr = r->GetRasterStatus(s); g.rec(OP_Device_GetRasterStatus, id, hr); return hr; }
    void __stdcall SetGammaRamp(DWORD f, const D3DGAMMARAMP* ramp) override { r->SetGammaRamp(f, ramp); g.rec(OP_Device_SetGammaRamp, id, S_OK, f, (const void*)ramp, (uint32_t)sizeof(D3DGAMMARAMP)); }
    void __stdcall GetGammaRamp(D3DGAMMARAMP* ramp) override { r->GetGammaRamp(ramp); g.rec(OP_Device_GetGammaRamp, id, S_OK, (const void*)ramp, (uint32_t)sizeof(D3DGAMMARAMP)); }
    HRESULT __stdcall CreateTexture(UINT w, UINT h, UINT lv, DWORD usage, D3DFORMAT fmt, D3DPOOL pool, IDirect3DTexture8** pp) override {
        IDirect3DTexture8* rt = nullptr; HRESULT hr = r->CreateTexture(w, h, lv, usage, fmt, pool, &rt); uint32_t oid = 0;
        if (SUCCEEDED(hr) && rt) { WTex* t = new WTex(rt, this); oid = t->id; *pp = t; } else if (pp) *pp = rt;
        g.rec(OP_Device_CreateTexture, id, hr, w, h, lv, usage, fmt, pool, oid); return hr;
    }
    HRESULT __stdcall CreateVolumeTexture(UINT w, UINT h, UINT d, UINT lv, DWORD usage, D3DFORMAT fmt, D3DPOOL pool, IDirect3DVolumeTexture8** pp) override {
        HRESULT hr = r->CreateVolumeTexture(w, h, d, lv, usage, fmt, pool, pp);
        g.rec(OP_Device_CreateVolumeTexture, id, hr, w, h, d, lv, usage, fmt, pool, 0u);
        if (SUCCEEDED(hr) && pp) g.rec(OP_Meta_Unwrapped, 0, S_OK, U(*pp), "IDirect3DVolumeTexture8");
        return hr;
    }
    HRESULT __stdcall CreateCubeTexture(UINT e, UINT lv, DWORD usage, D3DFORMAT fmt, D3DPOOL pool, IDirect3DCubeTexture8** pp) override {
        HRESULT hr = r->CreateCubeTexture(e, lv, usage, fmt, pool, pp);
        g.rec(OP_Device_CreateCubeTexture, id, hr, e, lv, usage, fmt, pool, 0u);
        if (SUCCEEDED(hr) && pp) g.rec(OP_Meta_Unwrapped, 0, S_OK, U(*pp), "IDirect3DCubeTexture8");
        return hr;
    }
    HRESULT __stdcall CreateVertexBuffer(UINT n, DWORD usage, DWORD fvf, D3DPOOL pool, IDirect3DVertexBuffer8** pp) override {
        IDirect3DVertexBuffer8* rb = nullptr; HRESULT hr = r->CreateVertexBuffer(n, usage, fvf, pool, &rb); uint32_t oid = 0;
        if (SUCCEEDED(hr) && rb) { WVB* b = new WVB(rb, this, n, K_VB); oid = b->id; *pp = b; } else if (pp) *pp = rb;
        g.rec(OP_Device_CreateVertexBuffer, id, hr, n, usage, fvf, pool, oid); return hr;
    }
    HRESULT __stdcall CreateIndexBuffer(UINT n, DWORD usage, D3DFORMAT fmt, D3DPOOL pool, IDirect3DIndexBuffer8** pp) override {
        IDirect3DIndexBuffer8* rb = nullptr; HRESULT hr = r->CreateIndexBuffer(n, usage, fmt, pool, &rb); uint32_t oid = 0;
        if (SUCCEEDED(hr) && rb) { WIB* b = new WIB(rb, this, n, K_IB); oid = b->id; *pp = b; } else if (pp) *pp = rb;
        g.rec(OP_Device_CreateIndexBuffer, id, hr, n, usage, fmt, pool, oid); return hr;
    }
    HRESULT __stdcall CreateRenderTarget(UINT w, UINT h, D3DFORMAT f, D3DMULTISAMPLE_TYPE ms, BOOL lockable, IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr; HRESULT hr = r->CreateRenderTarget(w, h, f, ms, lockable, &rs); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wS(rs, oid) : rs;
        g.rec(OP_Device_CreateRenderTarget, id, hr, w, h, f, ms, (uint32_t)lockable, oid); return hr;
    }
    HRESULT __stdcall CreateDepthStencilSurface(UINT w, UINT h, D3DFORMAT f, D3DMULTISAMPLE_TYPE ms, IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr; HRESULT hr = r->CreateDepthStencilSurface(w, h, f, ms, &rs); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wS(rs, oid) : rs;
        g.rec(OP_Device_CreateDepthStencilSurface, id, hr, w, h, f, ms, oid); return hr;
    }
    HRESULT __stdcall CreateImageSurface(UINT w, UINT h, D3DFORMAT f, IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr; HRESULT hr = r->CreateImageSurface(w, h, f, &rs); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wS(rs, oid) : rs;
        g.rec(OP_Device_CreateImageSurface, id, hr, w, h, f, oid); return hr;
    }
    HRESULT __stdcall CopyRects(IDirect3DSurface8* s, const RECT* rc, UINT n, IDirect3DSurface8* d, const POINT* pt) override {
        uint32_t so, dO; HRESULT hr = r->CopyRects(uS(s, so), rc, n, uS(d, dO), pt);
        g.rec(OP_Device_CopyRects, id, hr, so, n, (const LONG*)rc, dO, n, (const LONG*)pt); return hr;
    }
    HRESULT __stdcall UpdateTexture(IDirect3DBaseTexture8* s, IDirect3DBaseTexture8* d) override {
        uint32_t so, dO; HRESULT hr = r->UpdateTexture(uT(s, so), uT(d, dO)); g.rec(OP_Device_UpdateTexture, id, hr, so, dO); return hr;
    }
    HRESULT __stdcall GetFrontBuffer(IDirect3DSurface8* d) override { uint32_t o; HRESULT hr = r->GetFrontBuffer(uS(d, o)); g.rec(OP_Device_GetFrontBuffer, id, hr, o); return hr; }
    HRESULT __stdcall SetRenderTarget(IDirect3DSurface8* rt, IDirect3DSurface8* zs) override {
        uint32_t a, b; HRESULT hr = r->SetRenderTarget(uS(rt, a), uS(zs, b)); g.rec(OP_Device_SetRenderTarget, id, hr, a, b); return hr;
    }
    HRESULT __stdcall GetRenderTarget(IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr; HRESULT hr = r->GetRenderTarget(&rs); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wS(rs, oid) : rs;
        g.rec(OP_Device_GetRenderTarget, id, hr, oid); return hr;
    }
    HRESULT __stdcall GetDepthStencilSurface(IDirect3DSurface8** pp) override {
        IDirect3DSurface8* rs = nullptr; HRESULT hr = r->GetDepthStencilSurface(&rs); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wS(rs, oid) : rs;
        g.rec(OP_Device_GetDepthStencilSurface, id, hr, oid); return hr;
    }
    HRESULT __stdcall BeginScene() override { HRESULT hr = r->BeginScene(); g.rec(OP_Device_BeginScene, id, hr); return hr; }
    HRESULT __stdcall EndScene() override { HRESULT hr = r->EndScene(); g.rec(OP_Device_EndScene, id, hr); return hr; }
    HRESULT __stdcall Clear(DWORD n, const D3DRECT* rc, DWORD flags, D3DCOLOR c, float z, DWORD st) override {
        HRESULT hr = r->Clear(n, rc, flags, c, z, st); g.rec(OP_Device_Clear, id, hr, n, (const LONG*)rc, flags, c, (double)z, st); return hr;
    }
    HRESULT __stdcall SetTransform(D3DTRANSFORMSTATETYPE s, const D3DMATRIX* m) override { HRESULT hr = r->SetTransform(s, m); g.rec(OP_Device_SetTransform, id, hr, s, (const float*)m); return hr; }
    HRESULT __stdcall GetTransform(D3DTRANSFORMSTATETYPE s, D3DMATRIX* m) override { HRESULT hr = r->GetTransform(s, m); g.rec(OP_Device_GetTransform, id, hr, s, (const float*)OUTP(m)); return hr; }
    HRESULT __stdcall MultiplyTransform(D3DTRANSFORMSTATETYPE s, const D3DMATRIX* m) override { HRESULT hr = r->MultiplyTransform(s, m); g.rec(OP_Device_MultiplyTransform, id, hr, s, (const float*)m); return hr; }
    HRESULT __stdcall SetViewport(const D3DVIEWPORT8* v) override { HRESULT hr = r->SetViewport(v); g.rec(OP_Device_SetViewport, id, hr, (const void*)v, 24u); return hr; }
    HRESULT __stdcall GetViewport(D3DVIEWPORT8* v) override { HRESULT hr = r->GetViewport(v); g.rec(OP_Device_GetViewport, id, hr, OUTP(v), 24u); return hr; }
    HRESULT __stdcall SetMaterial(const D3DMATERIAL8* m) override { HRESULT hr = r->SetMaterial(m); g.rec(OP_Device_SetMaterial, id, hr, (const void*)m, 68u); return hr; }
    HRESULT __stdcall GetMaterial(D3DMATERIAL8* m) override { HRESULT hr = r->GetMaterial(m); g.rec(OP_Device_GetMaterial, id, hr, OUTP(m), 68u); return hr; }
    HRESULT __stdcall SetLight(DWORD i, const D3DLIGHT8* l) override { HRESULT hr = r->SetLight(i, l); g.rec(OP_Device_SetLight, id, hr, i, (const void*)l, 104u); return hr; }
    HRESULT __stdcall GetLight(DWORD i, D3DLIGHT8* l) override { HRESULT hr = r->GetLight(i, l); g.rec(OP_Device_GetLight, id, hr, i, OUTP(l), 104u); return hr; }
    HRESULT __stdcall LightEnable(DWORD i, BOOL on) override { HRESULT hr = r->LightEnable(i, on); g.rec(OP_Device_LightEnable, id, hr, i, (uint32_t)on); return hr; }
    HRESULT __stdcall GetLightEnable(DWORD i, BOOL* on) override { HRESULT hr = r->GetLightEnable(i, on); g.rec(OP_Device_GetLightEnable, id, hr, i, (uint32_t)(SUCCEEDED(hr) && on ? *on : 0)); return hr; }
    HRESULT __stdcall SetClipPlane(DWORD i, const float* p) override { HRESULT hr = r->SetClipPlane(i, p); g.rec(OP_Device_SetClipPlane, id, hr, i, (const void*)p, 16u); return hr; }
    HRESULT __stdcall GetClipPlane(DWORD i, float* p) override { HRESULT hr = r->GetClipPlane(i, p); g.rec(OP_Device_GetClipPlane, id, hr, i, OUTP(p), 16u); return hr; }
    HRESULT __stdcall SetRenderState(D3DRENDERSTATETYPE s, DWORD v) override { HRESULT hr = r->SetRenderState(s, v); g.rec(OP_Device_SetRenderState, id, hr, s, v); return hr; }
    HRESULT __stdcall GetRenderState(D3DRENDERSTATETYPE s, DWORD* v) override { HRESULT hr = r->GetRenderState(s, v); g.rec(OP_Device_GetRenderState, id, hr, s, (uint32_t)(SUCCEEDED(hr) && v ? *v : 0)); return hr; }
    HRESULT __stdcall BeginStateBlock() override { HRESULT hr = r->BeginStateBlock(); g.rec(OP_Device_BeginStateBlock, id, hr); return hr; }
    HRESULT __stdcall EndStateBlock(DWORD* t) override { HRESULT hr = r->EndStateBlock(t); g.rec(OP_Device_EndStateBlock, id, hr, (uint32_t)(SUCCEEDED(hr) && t ? *t : 0)); return hr; }
    HRESULT __stdcall ApplyStateBlock(DWORD t) override { HRESULT hr = r->ApplyStateBlock(t); g.rec(OP_Device_ApplyStateBlock, id, hr, t); return hr; }
    HRESULT __stdcall CaptureStateBlock(DWORD t) override { HRESULT hr = r->CaptureStateBlock(t); g.rec(OP_Device_CaptureStateBlock, id, hr, t); return hr; }
    HRESULT __stdcall DeleteStateBlock(DWORD t) override { HRESULT hr = r->DeleteStateBlock(t); g.rec(OP_Device_DeleteStateBlock, id, hr, t); return hr; }
    HRESULT __stdcall CreateStateBlock(D3DSTATEBLOCKTYPE ty, DWORD* t) override { HRESULT hr = r->CreateStateBlock(ty, t); g.rec(OP_Device_CreateStateBlock, id, hr, ty, (uint32_t)(SUCCEEDED(hr) && t ? *t : 0)); return hr; }
    HRESULT __stdcall SetClipStatus(const D3DCLIPSTATUS8* s) override { HRESULT hr = r->SetClipStatus(s); g.rec(OP_Device_SetClipStatus, id, hr, (const void*)s, 8u); return hr; }
    HRESULT __stdcall GetClipStatus(D3DCLIPSTATUS8* s) override { HRESULT hr = r->GetClipStatus(s); g.rec(OP_Device_GetClipStatus, id, hr, OUTP(s), 8u); return hr; }
    HRESULT __stdcall GetTexture(DWORD st, IDirect3DBaseTexture8** pp) override {
        IDirect3DBaseTexture8* rt = nullptr; HRESULT hr = r->GetTexture(st, &rt); uint32_t oid = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wGet(rt, oid) : rt;
        g.rec(OP_Device_GetTexture, id, hr, st, oid); return hr;
    }
    HRESULT __stdcall SetTexture(DWORD st, IDirect3DBaseTexture8* t) override { uint32_t o; HRESULT hr = r->SetTexture(st, uT(t, o)); g.rec(OP_Device_SetTexture, id, hr, st, o); return hr; }
    HRESULT __stdcall GetTextureStageState(DWORD st, D3DTEXTURESTAGESTATETYPE ty, DWORD* v) override { HRESULT hr = r->GetTextureStageState(st, ty, v); g.rec(OP_Device_GetTextureStageState, id, hr, st, ty, (uint32_t)(SUCCEEDED(hr) && v ? *v : 0)); return hr; }
    HRESULT __stdcall SetTextureStageState(DWORD st, D3DTEXTURESTAGESTATETYPE ty, DWORD v) override { HRESULT hr = r->SetTextureStageState(st, ty, v); g.rec(OP_Device_SetTextureStageState, id, hr, st, ty, v); return hr; }
    HRESULT __stdcall ValidateDevice(DWORD* n) override { HRESULT hr = r->ValidateDevice(n); g.rec(OP_Device_ValidateDevice, id, hr, (uint32_t)(SUCCEEDED(hr) && n ? *n : 0)); return hr; }
    HRESULT __stdcall GetInfo(DWORD i, void* p, DWORD n) override { HRESULT hr = r->GetInfo(i, p, n); g.rec(OP_Device_GetInfo, id, hr, i, n); return hr; }
    HRESULT __stdcall SetPaletteEntries(UINT i, const PALETTEENTRY* e) override { HRESULT hr = r->SetPaletteEntries(i, e); g.rec(OP_Device_SetPaletteEntries, id, hr, i, (const void*)e, 1024u); return hr; }
    HRESULT __stdcall GetPaletteEntries(UINT i, PALETTEENTRY* e) override { HRESULT hr = r->GetPaletteEntries(i, e); g.rec(OP_Device_GetPaletteEntries, id, hr, i, OUTP(e), 1024u); return hr; }
    HRESULT __stdcall SetCurrentTexturePalette(UINT i) override { HRESULT hr = r->SetCurrentTexturePalette(i); g.rec(OP_Device_SetCurrentTexturePalette, id, hr, i); return hr; }
    HRESULT __stdcall GetCurrentTexturePalette(UINT* i) override { HRESULT hr = r->GetCurrentTexturePalette(i); g.rec(OP_Device_GetCurrentTexturePalette, id, hr, (uint32_t)(SUCCEEDED(hr) && i ? *i : 0)); return hr; }
    HRESULT __stdcall DrawPrimitive(D3DPRIMITIVETYPE pt, UINT sv, UINT n) override { HRESULT hr = r->DrawPrimitive(pt, sv, n); g.rec(OP_Device_DrawPrimitive, id, hr, pt, sv, n); return hr; }
    HRESULT __stdcall DrawIndexedPrimitive(D3DPRIMITIVETYPE pt, UINT mi, UINT nv, UINT si, UINT n) override { HRESULT hr = r->DrawIndexedPrimitive(pt, mi, nv, si, n); g.rec(OP_Device_DrawIndexedPrimitive, id, hr, pt, mi, nv, si, n); return hr; }
    HRESULT __stdcall DrawPrimitiveUP(D3DPRIMITIVETYPE pt, UINT n, const void* v, UINT stride) override {
        HRESULT hr = r->DrawPrimitiveUP(pt, n, v, stride);
        DataArg vd; vd.p = (const uint8_t*)v; vd.len = primVertexCount(pt, n) * stride;
        g.rec(OP_Device_DrawPrimitiveUP, id, hr, pt, n, stride, &vd); return hr;
    }
    HRESULT __stdcall DrawIndexedPrimitiveUP(D3DPRIMITIVETYPE pt, UINT mi, UINT nv, UINT n, const void* idx, D3DFORMAT ifmt, const void* v, UINT stride) override {
        HRESULT hr = r->DrawIndexedPrimitiveUP(pt, mi, nv, n, idx, ifmt, v, stride);
        uint32_t ib = primVertexCount(pt, n) * (ifmt == D3DFMT_INDEX32 ? 4 : 2), vb = (mi + nv) * stride;
        DataArg id_; id_.p = (const uint8_t*)idx; id_.len = ib;
        DataArg vd; vd.p = (const uint8_t*)v; vd.len = vb;
        g.rec(OP_Device_DrawIndexedPrimitiveUP, id, hr, pt, mi, nv, n, ifmt, stride, &id_, &vd); return hr;
    }
    HRESULT __stdcall ProcessVertices(UINT s, UINT d, UINT n, IDirect3DVertexBuffer8* vb, DWORD f) override {
        uint32_t o; HRESULT hr = r->ProcessVertices(s, d, n, uV(vb, o), f); g.rec(OP_Device_ProcessVertices, id, hr, s, d, n, o, f); return hr;
    }
    static uint32_t tokLen(const DWORD* p, DWORD end) { if (!p) return 0; uint32_t i = 0; while (i < 65536 && p[i] != end) i++; return (i + 1) * 4; }
    HRESULT __stdcall CreateVertexShader(const DWORD* decl, const DWORD* fn, DWORD* h, DWORD usage) override {
        HRESULT hr = r->CreateVertexShader(decl, fn, h, usage);
        g.rec(OP_Device_CreateVertexShader, id, hr, (const void*)decl, tokLen(decl, 0xFFFFFFFF), (const void*)fn, tokLen(fn, 0x0000FFFF),
              (uint32_t)(SUCCEEDED(hr) && h ? *h : 0), usage);
        return hr;
    }
    HRESULT __stdcall SetVertexShader(DWORD h) override { HRESULT hr = r->SetVertexShader(h); g.rec(OP_Device_SetVertexShader, id, hr, h); return hr; }
    HRESULT __stdcall GetVertexShader(DWORD* h) override { HRESULT hr = r->GetVertexShader(h); g.rec(OP_Device_GetVertexShader, id, hr, (uint32_t)(SUCCEEDED(hr) && h ? *h : 0)); return hr; }
    HRESULT __stdcall DeleteVertexShader(DWORD h) override { HRESULT hr = r->DeleteVertexShader(h); g.rec(OP_Device_DeleteVertexShader, id, hr, h); return hr; }
    HRESULT __stdcall SetVertexShaderConstant(DWORD reg, const void* p, DWORD n) override { HRESULT hr = r->SetVertexShaderConstant(reg, p, n); g.rec(OP_Device_SetVertexShaderConstant, id, hr, reg, p, n * 16); return hr; }
    HRESULT __stdcall GetVertexShaderConstant(DWORD reg, void* p, DWORD n) override { HRESULT hr = r->GetVertexShaderConstant(reg, p, n); g.rec(OP_Device_GetVertexShaderConstant, id, hr, reg, n); return hr; }
    HRESULT __stdcall GetVertexShaderDeclaration(DWORD h, void* p, DWORD* n) override { HRESULT hr = r->GetVertexShaderDeclaration(h, p, n); g.rec(OP_Device_GetVertexShaderDeclaration, id, hr, h); return hr; }
    HRESULT __stdcall GetVertexShaderFunction(DWORD h, void* p, DWORD* n) override { HRESULT hr = r->GetVertexShaderFunction(h, p, n); g.rec(OP_Device_GetVertexShaderFunction, id, hr, h); return hr; }
    HRESULT __stdcall SetStreamSource(UINT s, IDirect3DVertexBuffer8* vb, UINT stride) override { uint32_t o; HRESULT hr = r->SetStreamSource(s, uV(vb, o), stride); g.rec(OP_Device_SetStreamSource, id, hr, s, o, stride); return hr; }
    HRESULT __stdcall GetStreamSource(UINT s, IDirect3DVertexBuffer8** pp, UINT* stride) override {
        IDirect3DVertexBuffer8* rb = nullptr; HRESULT hr = r->GetStreamSource(s, &rb, stride); uint32_t o = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wGet(rb, o) : rb;
        g.rec(OP_Device_GetStreamSource, id, hr, s, o, (uint32_t)(SUCCEEDED(hr) && stride ? *stride : 0)); return hr;
    }
    HRESULT __stdcall SetIndices(IDirect3DIndexBuffer8* ib, UINT base) override { uint32_t o; HRESULT hr = r->SetIndices(uI(ib, o), base); g.rec(OP_Device_SetIndices, id, hr, o, base); return hr; }
    HRESULT __stdcall GetIndices(IDirect3DIndexBuffer8** pp, UINT* base) override {
        IDirect3DIndexBuffer8* rb = nullptr; HRESULT hr = r->GetIndices(&rb, base); uint32_t o = 0;
        if (pp) *pp = SUCCEEDED(hr) ? wGet(rb, o) : rb;
        g.rec(OP_Device_GetIndices, id, hr, o, (uint32_t)(SUCCEEDED(hr) && base ? *base : 0)); return hr;
    }
    HRESULT __stdcall CreatePixelShader(const DWORD* fn, DWORD* h) override {
        HRESULT hr = r->CreatePixelShader(fn, h);
        g.rec(OP_Device_CreatePixelShader, id, hr, (const void*)fn, tokLen(fn, 0x0000FFFF), (uint32_t)(SUCCEEDED(hr) && h ? *h : 0)); return hr;
    }
    HRESULT __stdcall SetPixelShader(DWORD h) override { HRESULT hr = r->SetPixelShader(h); g.rec(OP_Device_SetPixelShader, id, hr, h); return hr; }
    HRESULT __stdcall GetPixelShader(DWORD* h) override { HRESULT hr = r->GetPixelShader(h); g.rec(OP_Device_GetPixelShader, id, hr, (uint32_t)(SUCCEEDED(hr) && h ? *h : 0)); return hr; }
    HRESULT __stdcall DeletePixelShader(DWORD h) override { HRESULT hr = r->DeletePixelShader(h); g.rec(OP_Device_DeletePixelShader, id, hr, h); return hr; }
    HRESULT __stdcall SetPixelShaderConstant(DWORD reg, const void* p, DWORD n) override { HRESULT hr = r->SetPixelShaderConstant(reg, p, n); g.rec(OP_Device_SetPixelShaderConstant, id, hr, reg, p, n * 16); return hr; }
    HRESULT __stdcall GetPixelShaderConstant(DWORD reg, void* p, DWORD n) override { HRESULT hr = r->GetPixelShaderConstant(reg, p, n); g.rec(OP_Device_GetPixelShaderConstant, id, hr, reg, n); return hr; }
    HRESULT __stdcall GetPixelShaderFunction(DWORD h, void* p, DWORD* n) override { HRESULT hr = r->GetPixelShaderFunction(h, p, n); g.rec(OP_Device_GetPixelShaderFunction, id, hr, h); return hr; }
    HRESULT __stdcall DrawRectPatch(UINT h, const float* s, const D3DRECTPATCH_INFO* i) override { HRESULT hr = r->DrawRectPatch(h, s, i); g.rec(OP_Device_DrawRectPatch, id, hr, h); return hr; }
    HRESULT __stdcall DrawTriPatch(UINT h, const float* s, const D3DTRIPATCH_INFO* i) override { HRESULT hr = r->DrawTriPatch(h, s, i); g.rec(OP_Device_DrawTriPatch, id, hr, h); return hr; }
    HRESULT __stdcall DeletePatch(UINT h) override { HRESULT hr = r->DeletePatch(h); g.rec(OP_Device_DeletePatch, id, hr, h); return hr; }
};

// Shots need to read the back buffer. Under the folder's d3d8to9 a CopyRects into system memory goes through
// d3dx9_43!D3DXLoadSurfaceFromSurface, which is not installed on the test laptop (only d3dx9_24..36), so the default
// (shot_method=auto) asks for a lockable back buffer (D3DPRESENTFLAG_LOCKABLE_BACKBUFFER: only changes lockability).
// If the runtime refuses the flag, the call is retried exactly as the game made it. The game's pp->Flags is restored.
static bool wantLockable() {
    return g.cfg.shotInterval > 0 && (_stricmp(g.cfg.shotMethod, "auto") == 0 || _stricmp(g.cfg.shotMethod, "lockbb") == 0);
}
template <class F> static HRESULT createWithShotFlag(D3DPRESENT_PARAMETERS* pp, bool& lockable, F call) {
    lockable = false;
    if (!pp || !wantLockable()) return call(pp);
    const DWORD gameFlags = pp->Flags;
    if (!(gameFlags & D3DPRESENTFLAG_LOCKABLE_BACKBUFFER)) {
        pp->Flags = gameFlags | D3DPRESENTFLAG_LOCKABLE_BACKBUFFER;
        HRESULT hr = call(pp);
        pp->Flags = gameFlags;
        if (SUCCEEDED(hr)) { lockable = true; return hr; }
        g.event("lockable back buffer refused (hr=%08lx): retrying with the game's own parameters", hr);
    }
    HRESULT hr = call(pp);
    lockable = SUCCEEDED(hr) && (gameFlags & D3DPRESENTFLAG_LOCKABLE_BACKBUFFER);
    return hr;
}

/* ================================================================== IDirect3D8 */
struct WD3D : IDirect3D8 {
    IDirect3D8* r; uint32_t id;
    WD3D(IDirect3D8* real) : r(real), id(g.newId()) { mapAdd(r, this, id, K_D3D); }
    HRESULT __stdcall QueryInterface(REFIID riid, void** ppv) override {
        HRESULT hr = r->QueryInterface(riid, ppv); uint32_t oid = 0;
        if (SUCCEEDED(hr) && ppv && *ppv == (void*)r) { *ppv = this; oid = id; }
        g.rec(OP_D3D_QueryInterface, id, hr, &riid, 16u, oid); return hr;
    }
    ULONG __stdcall AddRef() override { ULONG c = r->AddRef(); g.rec(OP_D3D_AddRef, id, S_OK, c); return c; }
    ULONG __stdcall Release() override {
        ULONG c = r->Release(); g.rec(OP_D3D_Release, id, S_OK, c);
        if (c == 0) { mapDel(r); g.rec(OP_Meta_Destroy, 0, S_OK, id); g.flush(5000); delete this; }
        return c;
    }
    HRESULT __stdcall RegisterSoftwareDevice(void* f) override { HRESULT hr = r->RegisterSoftwareDevice(f); g.rec(OP_D3D_RegisterSoftwareDevice, id, hr); return hr; }
    UINT __stdcall GetAdapterCount() override { UINT n = r->GetAdapterCount(); g.rec(OP_D3D_GetAdapterCount, id, S_OK, n); return n; }
    HRESULT __stdcall GetAdapterIdentifier(UINT a, DWORD f, D3DADAPTER_IDENTIFIER8* p) override {
        HRESULT hr = r->GetAdapterIdentifier(a, f, p); g.rec(OP_D3D_GetAdapterIdentifier, id, hr, a, f, OUTP(p), (uint32_t)sizeof(D3DADAPTER_IDENTIFIER8)); return hr;
    }
    UINT __stdcall GetAdapterModeCount(UINT a) override { UINT n = r->GetAdapterModeCount(a); g.rec(OP_D3D_GetAdapterModeCount, id, S_OK, a, n); return n; }
    HRESULT __stdcall EnumAdapterModes(UINT a, UINT m, D3DDISPLAYMODE* p) override { HRESULT hr = r->EnumAdapterModes(a, m, p); g.rec(OP_D3D_EnumAdapterModes, id, hr, a, m, OUTP(p), 16u); return hr; }
    HRESULT __stdcall GetAdapterDisplayMode(UINT a, D3DDISPLAYMODE* p) override { HRESULT hr = r->GetAdapterDisplayMode(a, p); g.rec(OP_D3D_GetAdapterDisplayMode, id, hr, a, OUTP(p), 16u); return hr; }
    HRESULT __stdcall CheckDeviceType(UINT a, D3DDEVTYPE t, D3DFORMAT df, D3DFORMAT bf, BOOL w) override {
        HRESULT hr = r->CheckDeviceType(a, t, df, bf, w); g.rec(OP_D3D_CheckDeviceType, id, hr, a, t, df, bf, (uint32_t)w); return hr;
    }
    HRESULT __stdcall CheckDeviceFormat(UINT a, D3DDEVTYPE t, D3DFORMAT af, DWORD usage, D3DRESOURCETYPE rt, D3DFORMAT cf) override {
        HRESULT hr = r->CheckDeviceFormat(a, t, af, usage, rt, cf); g.rec(OP_D3D_CheckDeviceFormat, id, hr, a, t, af, usage, rt, cf); return hr;
    }
    HRESULT __stdcall CheckDeviceMultiSampleType(UINT a, D3DDEVTYPE t, D3DFORMAT f, BOOL w, D3DMULTISAMPLE_TYPE ms) override {
        HRESULT hr = r->CheckDeviceMultiSampleType(a, t, f, w, ms); g.rec(OP_D3D_CheckDeviceMultiSampleType, id, hr, a, t, f, (uint32_t)w, ms); return hr;
    }
    HRESULT __stdcall CheckDepthStencilMatch(UINT a, D3DDEVTYPE t, D3DFORMAT af, D3DFORMAT rf, D3DFORMAT df) override {
        HRESULT hr = r->CheckDepthStencilMatch(a, t, af, rf, df); g.rec(OP_D3D_CheckDepthStencilMatch, id, hr, a, t, af, rf, df); return hr;
    }
    HRESULT __stdcall GetDeviceCaps(UINT a, D3DDEVTYPE t, D3DCAPS8* c) override { HRESULT hr = r->GetDeviceCaps(a, t, c); g.rec(OP_D3D_GetDeviceCaps, id, hr, a, t, OUTP(c), (uint32_t)sizeof(D3DCAPS8)); return hr; }
    HMONITOR __stdcall GetAdapterMonitor(UINT a) override { HMONITOR m = r->GetAdapterMonitor(a); g.rec(OP_D3D_GetAdapterMonitor, id, S_OK, a, U(m)); return m; }
    HRESULT __stdcall CreateDevice(UINT a, D3DDEVTYPE t, HWND wnd, DWORD flags, D3DPRESENT_PARAMETERS* pp, IDirect3DDevice8** out) override {
        IDirect3DDevice8* rd = nullptr;
        bool lockable = false;
        HRESULT hr = createWithShotFlag(pp, lockable, [&](D3DPRESENT_PARAMETERS* p) { return r->CreateDevice(a, t, wnd, flags, p, &rd); });
        uint32_t oid = 0;
        if (SUCCEEDED(hr) && rd) { WDevice* d = new WDevice(rd, this); d->bbLockable = lockable; oid = d->id; *out = d; } else if (out) *out = rd;
        g.rec(OP_D3D_CreateDevice, id, hr, a, t, U(wnd), flags, (const void*)pp, 52u, oid);
        if (SUCCEEDED(hr)) g.event("device created, lockable back buffer for shots: %s", lockable ? "yes" : "no");
        g.flush(2000);   // device creation is a good moment to have the header + caps on disk
        return hr;
    }
};

/* ------------------------------------------------------------------ out-of-line methods */
HRESULT WDevice::GetDirect3D(IDirect3D8** pp) {
    IDirect3D8* rd = nullptr; HRESULT hr = r->GetDirect3D(&rd);
    if (pp) *pp = (SUCCEEDED(hr) && rd == d3d->r) ? (IDirect3D8*)d3d : rd;
    g.rec(OP_Device_GetDirect3D, id, hr, SUCCEEDED(hr) && rd == d3d->r ? d3d->id : 0u); return hr;
}

HRESULT WDevice::Reset(D3DPRESENT_PARAMETERS* pp) {
    bool lockable = false;
    HRESULT hr = createWithShotFlag(pp, lockable, [&](D3DPRESENT_PARAMETERS* p) { return r->Reset(p); });
    if (SUCCEEDED(hr)) bbLockable = lockable;
    g.rec(OP_Device_Reset, id, hr, (const void*)pp, 52u);
    return hr;
}

static inline void px(D3DFORMAT f, const uint8_t* s, uint32_t& r, uint32_t& g_, uint32_t& b) {
    switch (f) {
    case D3DFMT_X8R8G8B8: case D3DFMT_A8R8G8B8: case D3DFMT_R8G8B8: b = s[0]; g_ = s[1]; r = s[2]; return;
    case D3DFMT_R5G6B5: { uint32_t c = s[0] | s[1] << 8, R = c >> 11, G = (c >> 5) & 63, B = c & 31; r = R << 3 | R >> 2; g_ = G << 2 | G >> 4; b = B << 3 | B >> 2; return; }
    case D3DFMT_X1R5G5B5: case D3DFMT_A1R5G5B5: { uint32_t c = s[0] | s[1] << 8, R = (c >> 10) & 31, G = (c >> 5) & 31, B = c & 31; r = R << 3 | R >> 2; g_ = G << 3 | G >> 2; b = B << 3 | B >> 2; return; }
    }
    r = g_ = b = 0;
}

// Back-buffer shot BEFORE Present (the back buffer is undefined afterwards with SwapEffect DISCARD). Uses the REAL
// device and surfaces directly, so nothing of it appears in the call stream. RGBA8 output, box-downscaled by
// shot_scale with rounding (sum + n/2) / n, exactly like replayer.js. Methods, tried in this order by "auto" (the
// one that worked last time goes first):
//   lockbb    LockRect on the back buffer itself (device created with a lockable back buffer)
//   rtcopy    CopyRects back buffer -> lockable DEFAULT-pool render target (d3d8to9: StretchRect), LockRect on it
//   copyrects CopyRects back buffer -> system-memory image surface (d3d8to9: needs d3dx9_43.dll)
// Temporary surfaces are released at once (DEFAULT-pool objects must not survive into a Reset).
enum { SM_LOCKBB, SM_RTCOPY, SM_SYSCOPY, SM_N };
static const char* const SM_NAME[SM_N] = {"lockbb", "rtcopy", "copyrects"};

bool WDevice::shotWith(int m, IDirect3DSurface8* bb, const D3DSURFACE_DESC& d, HRESULT& hr, const char*& what) {
    IDirect3DSurface8* tmp = nullptr; IDirect3DSurface8* src = bb;
    if (m == SM_LOCKBB) {
        if (!bbLockable) { what = "back buffer not lockable"; hr = D3DERR_INVALIDCALL; return false; }
    } else {
        what = m == SM_RTCOPY ? "CreateRenderTarget" : "CreateImageSurface";
        hr = m == SM_RTCOPY ? r->CreateRenderTarget(d.Width, d.Height, d.Format, 0, TRUE, &tmp) : r->CreateImageSurface(d.Width, d.Height, d.Format, &tmp);
        if (FAILED(hr) || !tmp) return false;
        what = "CopyRects";
        hr = r->CopyRects(bb, nullptr, 0, tmp, nullptr);
        if (FAILED(hr)) { tmp->Release(); return false; }
        src = tmp;
    }
    D3DLOCKED_RECT lr{};
    what = "LockRect";
    hr = src->LockRect(&lr, nullptr, D3DLOCK_READONLY);
    if (FAILED(hr)) { if (tmp) tmp->Release(); return false; }
    FmtInfo fi = fmtInfo(d.Format);
    const uint32_t s = (uint32_t)g.cfg.shotScale, ow = d.Width / s, oh = d.Height / s, n = s * s;
    shotBuf.resize((size_t)ow * oh * 4);
    for (uint32_t oy = 0; oy < oh; oy++) {
        for (uint32_t ox = 0; ox < ow; ox++) {
            uint32_t R = 0, G = 0, B = 0;
            for (uint32_t yy = 0; yy < s; yy++) {
                const uint8_t* row = (const uint8_t*)lr.pBits + (size_t)(oy * s + yy) * lr.Pitch;
                for (uint32_t xx = 0; xx < s; xx++) {
                    uint32_t r_, g_, b_; px(d.Format, row + (size_t)(ox * s + xx) * fi.bpp, r_, g_, b_);
                    R += r_; G += g_; B += b_;
                }
            }
            uint8_t* o = &shotBuf[((size_t)oy * ow + ox) * 4];
            o[0] = (uint8_t)((R + n / 2) / n); o[1] = (uint8_t)((G + n / 2) / n); o[2] = (uint8_t)((B + n / 2) / n); o[3] = 255;
        }
    }
    src->UnlockRect();
    if (tmp) tmp->Release();
    g.rec(OP_Meta_Shot, 0, S_OK, g.frame, ow, oh, s, d.Format, (const void*)shotBuf.data(), (uint32_t)shotBuf.size());
    return true;
}

void WDevice::takeShot() {
    if (shotsOff) return;
    IDirect3DSurface8* bb = nullptr;
    HRESULT hr = r->GetBackBuffer(0, D3DBACKBUFFER_TYPE_MONO, &bb);
    const char* what = "GetBackBuffer";
    bool ok = false;
    if (SUCCEEDED(hr) && bb) {
        D3DSURFACE_DESC d{};
        bb->GetDesc(&d);
        int order[SM_N], n = 0;
        const char* m = g.cfg.shotMethod;
        if (_stricmp(m, "lockbb") == 0) order[n++] = SM_LOCKBB;
        else if (_stricmp(m, "rtcopy") == 0) order[n++] = SM_RTCOPY;
        else if (_stricmp(m, "copyrects") == 0) order[n++] = SM_SYSCOPY;
        else {   // auto
            if (shotMethod >= 0) order[n++] = shotMethod;
            for (int k = 0; k < SM_N; k++) if (k != shotMethod) order[n++] = k;
        }
        for (int k = 0; k < n && !ok; k++) {
            ok = shotWith(order[k], bb, d, hr, what);
            if (ok && shotMethod != order[k]) { shotMethod = order[k]; g.event("shots use method %s", SM_NAME[order[k]]); }
            else if (!ok && shotFails < 3) g.event("shot method %s failed at frame %u: %s hr=%08lx", SM_NAME[order[k]], g.frame, what, hr);
        }
        bb->Release();
    }
    if (ok) { shotFails = 0; return; }
    if (++shotFails <= 5) g.event("shot failed at frame %u: %s hr=%08lx", g.frame, what, hr);
    if (shotFails >= 30) { shotsOff = true; g.event("shots disabled after 30 consecutive failures"); }
}

HRESULT WDevice::Present(const RECT* src, const RECT* dst, HWND wnd, const RGNDATA* dirty) {
    if (g.on && g.cfg.shotInterval > 0 && g.frame % (uint32_t)g.cfg.shotInterval == 0) takeShot();
    HRESULT hr = r->Present(src, dst, wnd, dirty);
    uint32_t f = g.frame++;
    g.rec(OP_Device_Present, id, hr, src, dst, U(wnd), (uint32_t)(dirty != nullptr), f, (uint32_t)g.ms());
    g.endFrame();
    return hr;
}

// GetDevice of any resource: our device wrapper (the real call already AddRef'd the real device)
static IDirect3DDevice8* devOut(WDevice* dev, IDirect3DDevice8* rd) { return rd == dev->r ? (IDirect3DDevice8*)dev : rd; }
HRESULT WSurf::GetDevice(IDirect3DDevice8** pp) { IDirect3DDevice8* rd = nullptr; HRESULT hr = r->GetDevice(&rd); if (pp) *pp = devOut(dev, rd); g.rec(OP_Surface_GetDevice, id, hr, dev->id); return hr; }
HRESULT WTex::GetDevice(IDirect3DDevice8** pp) { IDirect3DDevice8* rd = nullptr; HRESULT hr = r->GetDevice(&rd); if (pp) *pp = devOut(dev, rd); g.rec(OP_Texture_GetDevice, id, hr, dev->id); return hr; }
template <class I, class D, int OPB>
HRESULT WBuf<I, D, OPB>::GetDevice(IDirect3DDevice8** pp) { IDirect3DDevice8* rd = nullptr; HRESULT hr = r->GetDevice(&rd); if (pp) *pp = devOut(dev, rd); g.rec(OPB + 3, id, hr, dev->id); return hr; }

HRESULT WSurf::QueryInterface(REFIID riid, void** ppv) {
    HRESULT hr = r->QueryInterface(riid, ppv); uint32_t oid = 0;
    if (SUCCEEDED(hr) && ppv && *ppv == (void*)r) { *ppv = this; oid = id; }
    g.rec(OP_Surface_QueryInterface, id, hr, &riid, 16u, oid); return hr;
}
HRESULT WTex::QueryInterface(REFIID riid, void** ppv) {
    HRESULT hr = r->QueryInterface(riid, ppv); uint32_t oid = 0;
    if (SUCCEEDED(hr) && ppv && *ppv == (void*)r) { *ppv = this; oid = id; }
    g.rec(OP_Texture_QueryInterface, id, hr, &riid, 16u, oid); return hr;
}
ULONG WSurf::Release() {
    ULONG c = r->Release();
    g.rec(OP_Surface_Release, id, S_OK, c);
    if (c == 0) {
        if (tex) tex->destroy();   // a texture level's count is its container's: the texture died with it
        else destroy();
    }
    return c;
}
HRESULT WSurf::GetContainer(REFIID riid, void** ppv) {
    HRESULT hr = r->GetContainer(riid, ppv); uint32_t oid = 0;
    if (SUCCEEDED(hr) && ppv && *ppv) {
        if (tex && *ppv == (void*)tex->r) { *ppv = tex; oid = tex->id; }
        else if (*ppv == (void*)dev->r) { *ppv = dev; oid = dev->id; }
        else { Ent e; if (mapGet(*ppv, e)) { *ppv = e.w; oid = e.id; } }
    }
    g.rec(OP_Surface_GetContainer, id, hr, &riid, 16u, oid); return hr;
}

IDirect3D8* wrapDirect3D8(IDirect3D8* real, UINT sdk) {
    WD3D* w = new WD3D(real);
    g.rec(OP_Meta_Create, 0, S_OK, sdk, w->id);
    return w;
}

} // namespace d3drec
