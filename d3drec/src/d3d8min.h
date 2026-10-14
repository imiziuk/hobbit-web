// Minimal Direct3D 8 declarations (the Windows 10/11 SDK no longer ships d3d8.h).
// Layouts and vtable order follow the DirectX 8.1 SDK d3d8.h / d3d8types.h / d3d8caps.h exactly; enum types are
// plain DWORDs (same ABI). Cross-checked against Meridian.exe's call offsets (docs/WEB_PORT_D3D8.md 1.1-1.2).
#pragma once
#include <windows.h>
#include <unknwn.h>

typedef DWORD D3DFORMAT, D3DPOOL, D3DRESOURCETYPE, D3DMULTISAMPLE_TYPE, D3DDEVTYPE, D3DBACKBUFFER_TYPE,
    D3DTRANSFORMSTATETYPE, D3DRENDERSTATETYPE, D3DTEXTURESTAGESTATETYPE, D3DPRIMITIVETYPE, D3DSTATEBLOCKTYPE,
    D3DSWAPEFFECT, D3DCOLOR;

enum : DWORD {
    D3DFMT_UNKNOWN = 0, D3DFMT_R8G8B8 = 20, D3DFMT_A8R8G8B8 = 21, D3DFMT_X8R8G8B8 = 22, D3DFMT_R5G6B5 = 23,
    D3DFMT_X1R5G5B5 = 24, D3DFMT_A1R5G5B5 = 25, D3DFMT_A4R4G4B4 = 26, D3DFMT_R3G3B2 = 27, D3DFMT_A8 = 28,
    D3DFMT_A8R3G3B2 = 29, D3DFMT_X4R4G4B4 = 30, D3DFMT_A2B10G10R10 = 31, D3DFMT_G16R16 = 34, D3DFMT_A8P8 = 40,
    D3DFMT_P8 = 41, D3DFMT_L8 = 50, D3DFMT_A8L8 = 51, D3DFMT_A4L4 = 52, D3DFMT_V8U8 = 60, D3DFMT_L6V5U5 = 61,
    D3DFMT_X8L8V8U8 = 62, D3DFMT_Q8W8V8U8 = 63, D3DFMT_V16U16 = 64, D3DFMT_W11V11U10 = 65, D3DFMT_A2W10V10U10 = 67,
    D3DFMT_D16_LOCKABLE = 70, D3DFMT_D32 = 71, D3DFMT_D15S1 = 73, D3DFMT_D24S8 = 75, D3DFMT_D16 = 80,
    D3DFMT_D24X8 = 77, D3DFMT_D24X4S4 = 79, D3DFMT_INDEX16 = 101, D3DFMT_INDEX32 = 102,
    D3DFMT_DXT1 = 0x31545844, D3DFMT_DXT2 = 0x32545844, D3DFMT_DXT3 = 0x33545844, D3DFMT_DXT4 = 0x34545844,
    D3DFMT_DXT5 = 0x35545844, D3DFMT_UYVY = 0x59565955, D3DFMT_YUY2 = 0x32595559,
};
enum : DWORD { D3DPOOL_DEFAULT = 0, D3DPOOL_MANAGED = 1, D3DPOOL_SYSTEMMEM = 2, D3DPOOL_SCRATCH = 3 };
enum : DWORD { D3DLOCK_READONLY = 0x10, D3DLOCK_DISCARD = 0x2000, D3DLOCK_NOOVERWRITE = 0x1000 };
enum : DWORD { D3DBACKBUFFER_TYPE_MONO = 0 };
enum : DWORD { D3DPT_POINTLIST = 1, D3DPT_LINELIST = 2, D3DPT_LINESTRIP = 3, D3DPT_TRIANGLELIST = 4,
               D3DPT_TRIANGLESTRIP = 5, D3DPT_TRIANGLEFAN = 6 };
enum : DWORD { D3DPRESENTFLAG_LOCKABLE_BACKBUFFER = 1 };
enum : DWORD { D3DCLEAR_TARGET = 1, D3DCLEAR_ZBUFFER = 2, D3DCLEAR_STENCIL = 4 };
#define D3D_OK S_OK
#define D3DERR_INVALIDCALL ((HRESULT)0x8876086CL)

typedef struct _D3DMATRIX { float m[4][4]; } D3DMATRIX;
typedef struct _D3DVIEWPORT8 { DWORD X, Y, Width, Height; float MinZ, MaxZ; } D3DVIEWPORT8;
typedef struct _D3DCOLORVALUE { float r, g, b, a; } D3DCOLORVALUE;
typedef struct _D3DMATERIAL8 { D3DCOLORVALUE Diffuse, Ambient, Specular, Emissive; float Power; } D3DMATERIAL8;
typedef struct _D3DVECTOR { float x, y, z; } D3DVECTOR;
typedef struct _D3DLIGHT8 {
    DWORD Type; D3DCOLORVALUE Diffuse, Specular, Ambient; D3DVECTOR Position, Direction;
    float Range, Falloff, Attenuation0, Attenuation1, Attenuation2, Theta, Phi;
} D3DLIGHT8;
typedef struct _D3DRECT { LONG x1, y1, x2, y2; } D3DRECT;
typedef struct _D3DCLIPSTATUS8 { DWORD ClipUnion, ClipIntersection; } D3DCLIPSTATUS8;
typedef struct _D3DGAMMARAMP { WORD red[256], green[256], blue[256]; } D3DGAMMARAMP;
typedef struct _D3DDISPLAYMODE { UINT Width, Height, RefreshRate; D3DFORMAT Format; } D3DDISPLAYMODE;
typedef struct _D3DDEVICE_CREATION_PARAMETERS { UINT AdapterOrdinal; D3DDEVTYPE DeviceType; HWND hFocusWindow; DWORD BehaviorFlags; } D3DDEVICE_CREATION_PARAMETERS;
typedef struct _D3DRASTER_STATUS { BOOL InVBlank; UINT ScanLine; } D3DRASTER_STATUS;
typedef struct _D3DPRESENT_PARAMETERS_ {
    UINT BackBufferWidth, BackBufferHeight; D3DFORMAT BackBufferFormat; UINT BackBufferCount;
    D3DMULTISAMPLE_TYPE MultiSampleType; D3DSWAPEFFECT SwapEffect; HWND hDeviceWindow; BOOL Windowed;
    BOOL EnableAutoDepthStencil; D3DFORMAT AutoDepthStencilFormat; DWORD Flags;
    UINT FullScreen_RefreshRateInHz, FullScreen_PresentationInterval;
} D3DPRESENT_PARAMETERS;
typedef struct _D3DSURFACE_DESC {
    D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool; UINT Size;
    D3DMULTISAMPLE_TYPE MultiSampleType; UINT Width, Height;
} D3DSURFACE_DESC;
typedef struct _D3DLOCKED_RECT { INT Pitch; void* pBits; } D3DLOCKED_RECT;
typedef struct _D3DVERTEXBUFFER_DESC { D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool; UINT Size; DWORD FVF; } D3DVERTEXBUFFER_DESC;
typedef struct _D3DINDEXBUFFER_DESC { D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool; UINT Size; } D3DINDEXBUFFER_DESC;
typedef struct _D3DADAPTER_IDENTIFIER8 {
    char Driver[512]; char Description[512]; LARGE_INTEGER DriverVersion;
    DWORD VendorId, DeviceId, SubSysId, Revision; GUID DeviceIdentifier; DWORD WHQLLevel;
} D3DADAPTER_IDENTIFIER8;
typedef struct _D3DCAPS8 { DWORD v[53]; } D3DCAPS8;   // 212 bytes; only copied as a blob
typedef struct _D3DRECTPATCH_INFO D3DRECTPATCH_INFO;
typedef struct _D3DTRIPATCH_INFO D3DTRIPATCH_INFO;

static_assert(sizeof(D3DLIGHT8) == 104, "D3DLIGHT8");
static_assert(sizeof(D3DMATERIAL8) == 68, "D3DMATERIAL8");
static_assert(sizeof(D3DPRESENT_PARAMETERS) == 52, "D3DPRESENT_PARAMETERS");
static_assert(sizeof(D3DSURFACE_DESC) == 32, "D3DSURFACE_DESC");
static_assert(sizeof(D3DCAPS8) == 212, "D3DCAPS8");

struct IDirect3D8; struct IDirect3DDevice8; struct IDirect3DSurface8; struct IDirect3DBaseTexture8;
struct IDirect3DTexture8; struct IDirect3DVolumeTexture8; struct IDirect3DCubeTexture8;
struct IDirect3DVertexBuffer8; struct IDirect3DIndexBuffer8; struct IDirect3DSwapChain8;

#define M virtual HRESULT __stdcall
struct IDirect3D8 : IUnknown {
    M RegisterSoftwareDevice(void* pInitializeFunction) = 0;
    virtual UINT __stdcall GetAdapterCount() = 0;
    M GetAdapterIdentifier(UINT Adapter, DWORD Flags, D3DADAPTER_IDENTIFIER8* pIdentifier) = 0;
    virtual UINT __stdcall GetAdapterModeCount(UINT Adapter) = 0;
    M EnumAdapterModes(UINT Adapter, UINT Mode, D3DDISPLAYMODE* pMode) = 0;
    M GetAdapterDisplayMode(UINT Adapter, D3DDISPLAYMODE* pMode) = 0;
    M CheckDeviceType(UINT Adapter, D3DDEVTYPE CheckType, D3DFORMAT DisplayFormat, D3DFORMAT BackBufferFormat, BOOL Windowed) = 0;
    M CheckDeviceFormat(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT AdapterFormat, DWORD Usage, D3DRESOURCETYPE RType, D3DFORMAT CheckFormat) = 0;
    M CheckDeviceMultiSampleType(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT SurfaceFormat, BOOL Windowed, D3DMULTISAMPLE_TYPE MultiSampleType) = 0;
    M CheckDepthStencilMatch(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT AdapterFormat, D3DFORMAT RenderTargetFormat, D3DFORMAT DepthStencilFormat) = 0;
    M GetDeviceCaps(UINT Adapter, D3DDEVTYPE DeviceType, D3DCAPS8* pCaps) = 0;
    virtual HMONITOR __stdcall GetAdapterMonitor(UINT Adapter) = 0;
    M CreateDevice(UINT Adapter, D3DDEVTYPE DeviceType, HWND hFocusWindow, DWORD BehaviorFlags, D3DPRESENT_PARAMETERS* pPresentationParameters, IDirect3DDevice8** ppReturnedDeviceInterface) = 0;
};

struct IDirect3DDevice8 : IUnknown {
    M TestCooperativeLevel() = 0;                                                        // 3
    virtual UINT __stdcall GetAvailableTextureMem() = 0;
    M ResourceManagerDiscardBytes(DWORD Bytes) = 0;
    M GetDirect3D(IDirect3D8** ppD3D8) = 0;
    M GetDeviceCaps(D3DCAPS8* pCaps) = 0;
    M GetDisplayMode(D3DDISPLAYMODE* pMode) = 0;
    M GetCreationParameters(D3DDEVICE_CREATION_PARAMETERS* pParameters) = 0;
    M SetCursorProperties(UINT XHotSpot, UINT YHotSpot, IDirect3DSurface8* pCursorBitmap) = 0;   // 10
    virtual void __stdcall SetCursorPosition(int X, int Y, DWORD Flags) = 0;
    virtual BOOL __stdcall ShowCursor(BOOL bShow) = 0;
    M CreateAdditionalSwapChain(D3DPRESENT_PARAMETERS* pPresentationParameters, IDirect3DSwapChain8** pSwapChain) = 0;
    M Reset(D3DPRESENT_PARAMETERS* pPresentationParameters) = 0;
    M Present(const RECT* pSourceRect, const RECT* pDestRect, HWND hDestWindowOverride, const RGNDATA* pDirtyRegion) = 0;  // 15
    M GetBackBuffer(UINT BackBuffer, D3DBACKBUFFER_TYPE Type, IDirect3DSurface8** ppBackBuffer) = 0;
    M GetRasterStatus(D3DRASTER_STATUS* pRasterStatus) = 0;
    virtual void __stdcall SetGammaRamp(DWORD Flags, const D3DGAMMARAMP* pRamp) = 0;
    virtual void __stdcall GetGammaRamp(D3DGAMMARAMP* pRamp) = 0;
    M CreateTexture(UINT Width, UINT Height, UINT Levels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DTexture8** ppTexture) = 0;  // 20
    M CreateVolumeTexture(UINT Width, UINT Height, UINT Depth, UINT Levels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DVolumeTexture8** ppVolumeTexture) = 0;
    M CreateCubeTexture(UINT EdgeLength, UINT Levels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DCubeTexture8** ppCubeTexture) = 0;
    M CreateVertexBuffer(UINT Length, DWORD Usage, DWORD FVF, D3DPOOL Pool, IDirect3DVertexBuffer8** ppVertexBuffer) = 0;
    M CreateIndexBuffer(UINT Length, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DIndexBuffer8** ppIndexBuffer) = 0;
    M CreateRenderTarget(UINT Width, UINT Height, D3DFORMAT Format, D3DMULTISAMPLE_TYPE MultiSample, BOOL Lockable, IDirect3DSurface8** ppSurface) = 0;  // 25
    M CreateDepthStencilSurface(UINT Width, UINT Height, D3DFORMAT Format, D3DMULTISAMPLE_TYPE MultiSample, IDirect3DSurface8** ppSurface) = 0;
    M CreateImageSurface(UINT Width, UINT Height, D3DFORMAT Format, IDirect3DSurface8** ppSurface) = 0;
    M CopyRects(IDirect3DSurface8* pSourceSurface, const RECT* pSourceRectsArray, UINT cRects, IDirect3DSurface8* pDestinationSurface, const POINT* pDestPointsArray) = 0;
    M UpdateTexture(IDirect3DBaseTexture8* pSourceTexture, IDirect3DBaseTexture8* pDestinationTexture) = 0;
    M GetFrontBuffer(IDirect3DSurface8* pDestSurface) = 0;                                // 30
    M SetRenderTarget(IDirect3DSurface8* pRenderTarget, IDirect3DSurface8* pNewZStencil) = 0;
    M GetRenderTarget(IDirect3DSurface8** ppRenderTarget) = 0;
    M GetDepthStencilSurface(IDirect3DSurface8** ppZStencilSurface) = 0;
    M BeginScene() = 0;
    M EndScene() = 0;                                                                    // 35
    M Clear(DWORD Count, const D3DRECT* pRects, DWORD Flags, D3DCOLOR Color, float Z, DWORD Stencil) = 0;
    M SetTransform(D3DTRANSFORMSTATETYPE State, const D3DMATRIX* pMatrix) = 0;
    M GetTransform(D3DTRANSFORMSTATETYPE State, D3DMATRIX* pMatrix) = 0;
    M MultiplyTransform(D3DTRANSFORMSTATETYPE State, const D3DMATRIX* pMatrix) = 0;
    M SetViewport(const D3DVIEWPORT8* pViewport) = 0;                                     // 40
    M GetViewport(D3DVIEWPORT8* pViewport) = 0;
    M SetMaterial(const D3DMATERIAL8* pMaterial) = 0;
    M GetMaterial(D3DMATERIAL8* pMaterial) = 0;
    M SetLight(DWORD Index, const D3DLIGHT8* pLight) = 0;
    M GetLight(DWORD Index, D3DLIGHT8* pLight) = 0;                                       // 45
    M LightEnable(DWORD Index, BOOL Enable) = 0;
    M GetLightEnable(DWORD Index, BOOL* pEnable) = 0;
    M SetClipPlane(DWORD Index, const float* pPlane) = 0;
    M GetClipPlane(DWORD Index, float* pPlane) = 0;
    M SetRenderState(D3DRENDERSTATETYPE State, DWORD Value) = 0;                          // 50
    M GetRenderState(D3DRENDERSTATETYPE State, DWORD* pValue) = 0;
    M BeginStateBlock() = 0;
    M EndStateBlock(DWORD* pToken) = 0;
    M ApplyStateBlock(DWORD Token) = 0;
    M CaptureStateBlock(DWORD Token) = 0;                                                 // 55
    M DeleteStateBlock(DWORD Token) = 0;
    M CreateStateBlock(D3DSTATEBLOCKTYPE Type, DWORD* pToken) = 0;
    M SetClipStatus(const D3DCLIPSTATUS8* pClipStatus) = 0;
    M GetClipStatus(D3DCLIPSTATUS8* pClipStatus) = 0;
    M GetTexture(DWORD Stage, IDirect3DBaseTexture8** ppTexture) = 0;                     // 60
    M SetTexture(DWORD Stage, IDirect3DBaseTexture8* pTexture) = 0;
    M GetTextureStageState(DWORD Stage, D3DTEXTURESTAGESTATETYPE Type, DWORD* pValue) = 0;
    M SetTextureStageState(DWORD Stage, D3DTEXTURESTAGESTATETYPE Type, DWORD Value) = 0;
    M ValidateDevice(DWORD* pNumPasses) = 0;
    M GetInfo(DWORD DevInfoID, void* pDevInfoStruct, DWORD DevInfoStructSize) = 0;       // 65
    M SetPaletteEntries(UINT PaletteNumber, const PALETTEENTRY* pEntries) = 0;
    M GetPaletteEntries(UINT PaletteNumber, PALETTEENTRY* pEntries) = 0;
    M SetCurrentTexturePalette(UINT PaletteNumber) = 0;
    M GetCurrentTexturePalette(UINT* PaletteNumber) = 0;
    M DrawPrimitive(D3DPRIMITIVETYPE PrimitiveType, UINT StartVertex, UINT PrimitiveCount) = 0;  // 70
    M DrawIndexedPrimitive(D3DPRIMITIVETYPE, UINT minIndex, UINT NumVertices, UINT startIndex, UINT primCount) = 0;
    M DrawPrimitiveUP(D3DPRIMITIVETYPE PrimitiveType, UINT PrimitiveCount, const void* pVertexStreamZeroData, UINT VertexStreamZeroStride) = 0;
    M DrawIndexedPrimitiveUP(D3DPRIMITIVETYPE PrimitiveType, UINT MinVertexIndex, UINT NumVertexIndices, UINT PrimitiveCount, const void* pIndexData, D3DFORMAT IndexDataFormat, const void* pVertexStreamZeroData, UINT VertexStreamZeroStride) = 0;
    M ProcessVertices(UINT SrcStartIndex, UINT DestIndex, UINT VertexCount, IDirect3DVertexBuffer8* pDestBuffer, DWORD Flags) = 0;
    M CreateVertexShader(const DWORD* pDeclaration, const DWORD* pFunction, DWORD* pHandle, DWORD Usage) = 0;  // 75
    M SetVertexShader(DWORD Handle) = 0;
    M GetVertexShader(DWORD* pHandle) = 0;
    M DeleteVertexShader(DWORD Handle) = 0;
    M SetVertexShaderConstant(DWORD Register, const void* pConstantData, DWORD ConstantCount) = 0;
    M GetVertexShaderConstant(DWORD Register, void* pConstantData, DWORD ConstantCount) = 0;  // 80
    M GetVertexShaderDeclaration(DWORD Handle, void* pData, DWORD* pSizeOfData) = 0;
    M GetVertexShaderFunction(DWORD Handle, void* pData, DWORD* pSizeOfData) = 0;
    M SetStreamSource(UINT StreamNumber, IDirect3DVertexBuffer8* pStreamData, UINT Stride) = 0;
    M GetStreamSource(UINT StreamNumber, IDirect3DVertexBuffer8** ppStreamData, UINT* pStride) = 0;
    M SetIndices(IDirect3DIndexBuffer8* pIndexData, UINT BaseVertexIndex) = 0;            // 85
    M GetIndices(IDirect3DIndexBuffer8** ppIndexData, UINT* pBaseVertexIndex) = 0;
    M CreatePixelShader(const DWORD* pFunction, DWORD* pHandle) = 0;
    M SetPixelShader(DWORD Handle) = 0;
    M GetPixelShader(DWORD* pHandle) = 0;
    M DeletePixelShader(DWORD Handle) = 0;                                               // 90
    M SetPixelShaderConstant(DWORD Register, const void* pConstantData, DWORD ConstantCount) = 0;
    M GetPixelShaderConstant(DWORD Register, void* pConstantData, DWORD ConstantCount) = 0;
    M GetPixelShaderFunction(DWORD Handle, void* pData, DWORD* pSizeOfData) = 0;
    M DrawRectPatch(UINT Handle, const float* pNumSegs, const D3DRECTPATCH_INFO* pRectPatchInfo) = 0;
    M DrawTriPatch(UINT Handle, const float* pNumSegs, const D3DTRIPATCH_INFO* pTriPatchInfo) = 0;  // 95
    M DeletePatch(UINT Handle) = 0;
};

struct IDirect3DResource8 : IUnknown {
    M GetDevice(IDirect3DDevice8** ppDevice) = 0;
    M SetPrivateData(REFGUID refguid, const void* pData, DWORD SizeOfData, DWORD Flags) = 0;
    M GetPrivateData(REFGUID refguid, void* pData, DWORD* pSizeOfData) = 0;
    M FreePrivateData(REFGUID refguid) = 0;
    virtual DWORD __stdcall SetPriority(DWORD PriorityNew) = 0;
    virtual DWORD __stdcall GetPriority() = 0;
    virtual void __stdcall PreLoad() = 0;
    virtual D3DRESOURCETYPE __stdcall GetType() = 0;
};
struct IDirect3DBaseTexture8 : IDirect3DResource8 {
    virtual DWORD __stdcall SetLOD(DWORD LODNew) = 0;
    virtual DWORD __stdcall GetLOD() = 0;
    virtual DWORD __stdcall GetLevelCount() = 0;
};
struct IDirect3DTexture8 : IDirect3DBaseTexture8 {
    M GetLevelDesc(UINT Level, D3DSURFACE_DESC* pDesc) = 0;
    M GetSurfaceLevel(UINT Level, IDirect3DSurface8** ppSurfaceLevel) = 0;
    M LockRect(UINT Level, D3DLOCKED_RECT* pLockedRect, const RECT* pRect, DWORD Flags) = 0;
    M UnlockRect(UINT Level) = 0;
    M AddDirtyRect(const RECT* pDirtyRect) = 0;
};
struct IDirect3DSurface8 : IUnknown {
    M GetDevice(IDirect3DDevice8** ppDevice) = 0;
    M SetPrivateData(REFGUID refguid, const void* pData, DWORD SizeOfData, DWORD Flags) = 0;
    M GetPrivateData(REFGUID refguid, void* pData, DWORD* pSizeOfData) = 0;
    M FreePrivateData(REFGUID refguid) = 0;
    M GetContainer(REFIID riid, void** ppContainer) = 0;
    M GetDesc(D3DSURFACE_DESC* pDesc) = 0;
    M LockRect(D3DLOCKED_RECT* pLockedRect, const RECT* pRect, DWORD Flags) = 0;
    M UnlockRect() = 0;
};
struct IDirect3DVertexBuffer8 : IDirect3DResource8 {
    M Lock(UINT OffsetToLock, UINT SizeToLock, BYTE** ppbData, DWORD Flags) = 0;
    M Unlock() = 0;
    M GetDesc(D3DVERTEXBUFFER_DESC* pDesc) = 0;
};
struct IDirect3DIndexBuffer8 : IDirect3DResource8 {
    M Lock(UINT OffsetToLock, UINT SizeToLock, BYTE** ppbData, DWORD Flags) = 0;
    M Unlock() = 0;
    M GetDesc(D3DINDEXBUFFER_DESC* pDesc) = 0;
};
#undef M

// No IIDs needed: QueryInterface results are matched by the returned pointer (see wrap.cpp).
