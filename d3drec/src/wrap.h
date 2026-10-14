#pragma once
#include "rec.h"

namespace d3drec {
void wrapInit();
IDirect3D8* wrapDirect3D8(IDirect3D8* real, UINT sdkVersion);   // writes Meta::Create
}
