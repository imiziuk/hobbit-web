/* Runtime support: state, x87 helpers, harness exports. */
#include "rt.h"
#include <math.h>

CPU R;
FPU F;
V128 XM[8];
u64 MM[8];
#ifndef RT_FLAT
u32 PT[1u << 20] __attribute__((aligned(16)));

/* paged guest memory accessors (out of line: keeps the generated wasm small) */
static inline u32 hpr(u32 a) { u32 e = PT[a >> 12]; if (__builtin_expect(e == 0, 0)) rt_trap(T_RD, a, 0); return (e & ~0xFFFu) | (a & 0xFFF); }
static inline u32 hpw(u32 a) { u32 e = PT[a >> 12]; if (__builtin_expect(e == 0 || (e & 1), 0)) rt_trap(e ? T_RO : T_WR, a, 0); return e | (a & 0xFFF); }
u32 rd8(u32 a) { return *(u8 *)(uintptr_t)hpr(a); }
void wr8(u32 a, u32 v) { *(u8 *)(uintptr_t)hpw(a) = (u8)v; }
u32 rd16(u32 a) {
    if (__builtin_expect((a & 0xFFF) == 0xFFF, 0)) return rd8(a) | (rd8(a + 1) << 8);
    u16 v; __builtin_memcpy(&v, (void *)(uintptr_t)hpr(a), 2); return v; }
u32 rd32(u32 a) {
    if (__builtin_expect((a & 0xFFF) > 0xFFC, 0)) return rd8(a) | (rd8(a + 1) << 8) | (rd8(a + 2) << 16) | (rd8(a + 3) << 24);
    u32 v; __builtin_memcpy(&v, (void *)(uintptr_t)hpr(a), 4); return v; }
void wr16(u32 a, u32 v) {
    if (__builtin_expect((a & 0xFFF) == 0xFFF, 0)) { wr8(a, v); wr8(a + 1, v >> 8); return; }
    u16 x = (u16)v; __builtin_memcpy((void *)(uintptr_t)hpw(a), &x, 2); }
void wr32(u32 a, u32 v) {
    if (__builtin_expect(R.mut & 4, 0) && (a & 0xFFF) == 0x100) v ^= 1;   /* mutation: corrupt some stores */
    if (__builtin_expect((a & 0xFFF) > 0xFFC, 0)) { wr8(a, v); wr8(a + 1, v >> 8); wr8(a + 2, v >> 16); wr8(a + 3, v >> 24); return; }
    __builtin_memcpy((void *)(uintptr_t)hpw(a), &v, 4); }
u64 rd64(u32 a) { u32 lo = rd32(a); return lo | ((u64)rd32(a + 4) << 32); }
void wr64(u32 a, u64 v) { wr32(a, (u32)v); wr32(a + 4, (u32)(v >> 32)); }


/* page pool for the harness (capsule pages + executable image pages) */
#define POOL_PAGES 6144
static u8 POOL[POOL_PAGES * 4096] __attribute__((aligned(4096)));

__attribute__((export_name("rt_pt"))) u32 rt_pt(void) { return (u32)(uintptr_t)PT; }
__attribute__((export_name("rt_pool"))) u32 rt_pool(void) { return (u32)(uintptr_t)POOL; }
__attribute__((export_name("rt_pool_pages"))) u32 rt_pool_pages(void) { return POOL_PAGES; }
void rt_ext(u32 t) { R.last_ip = t; rt_trap(T_EXT, t, 0); }
#else
/* ---------------------------------------------------------------- flat game build: host interface
   host_call(t): the host runs import/HLE thunk t (reads its stdcall args from the guest stack at R.esp, pops the return
   address + args, sets R.eax/R.edx and R.retaddr). Returns non-zero when the call must block (Sleep, waits, async file
   reads, Present): then host_wait() is called, which is a JSPI suspending import in the async build. */
__attribute__((import_module("env"), import_name("host_call"))) u32 host_call(u32 t);
__attribute__((import_module("env"), import_name("host_wait"))) void host_wait(void);
void rt_ext(u32 t) {
    if (__builtin_expect(t >= 0x7F000000u && t < 0x80000000u, 1)) { if (host_call(t)) host_wait(); return; }
    R.last_ip = t; rt_trap(T_EXT, t, 0);
}
/* HLE of a translated function (flat build only): same protocol as an import */
void rt_hle(u32 t) { if (host_call(t)) host_wait(); }
__attribute__((export_name("rt_xm"))) u32 rt_xm(void) { return (u32)(uintptr_t)XM; }
__attribute__((export_name("rt_mm"))) u32 rt_mm(void) { return (u32)(uintptr_t)MM; }
/* host -> guest call: the host has pushed the arguments and a return address on the guest stack */
__attribute__((export_name("rt_call"))) void rt_call(u32 func) { disp(func); }
#endif
__attribute__((export_name("rt_cpu"))) u32 rt_cpu(void) { return (u32)(uintptr_t)&R; }
__attribute__((export_name("rt_fpu"))) u32 rt_fpu(void) { return (u32)(uintptr_t)&F; }
__attribute__((export_name("rt_run"))) void rt_run(u32 func) { disp(func); }

/* ---------------------------------------------------------------- x87 */
double rt_frnd(double v) {
    switch ((R.mut & 2) ? 0 : (F.cw >> 10) & 3) {
    case 0: return __builtin_rint(v);       /* wasm f64.nearest: ties to even */
    case 1: return __builtin_floor(v);
    case 2: return __builtin_ceil(v);
    default: return __builtin_trunc(v);
    }
}
u32 rt_fist32(double v) { double r = rt_frnd(v); if (!(r >= -2147483648.0 && r <= 2147483647.0)) return 0x80000000u; return (u32)(i32)r; }
u32 rt_fist16(double v) { double r = rt_frnd(v); if (!(r >= -32768.0 && r <= 32767.0)) return 0x8000u; return (u32)(u16)(i16)r; }
u64 rt_fist64(double v) { double r = rt_frnd(v); if (!(r >= -9223372036854775808.0 && r < 9223372036854775808.0)) return 0x8000000000000000ull; return (u64)(i64)r; }

void rt_fcom(double a, double b) {
    u32 c;
    if (a != a || b != b) c = 0x4500;            /* unordered: C3 C2 C0 */
    else if (a > b) c = 0;
    else if (a < b) c = 0x0100;                  /* C0 */
    else c = 0x4000;                             /* C3 */
    F.sw = (F.sw & ~0x4700u) | c;                /* C1 cleared too */
}

void rt_fxam(void) {
    u32 c;
    double v = ST(0);
    u64 bits; __builtin_memcpy(&bits, &v, 8);
    if (F.tag[F.top] == 3) c = 0x4100;           /* empty: C3 C0 */
    else if (v != v) c = 0x0100;                 /* NaN: C0 */
    else if (__builtin_isinf(v)) c = 0x0500;     /* inf: C2 C0 */
    else if (v == 0) c = 0x4000;                 /* zero: C3 */
    else c = 0x0400;                             /* normal: C2 (double denormals are normal in extended) */
    if (bits >> 63) c |= 0x0200;                 /* C1 = sign */
    F.sw = (F.sw & ~0x4700u) | c;
}

void rt_fprem(int ieee) {
    double a = ST(0), b = ST(1);
    double q = ieee ? __builtin_rint(a / b) : __builtin_trunc(a / b);
    double r = ieee ? remainder(a, b) : fmod(a, b);
    long long qi = (long long)__builtin_fabs(q);
    ST(0) = r;
    u32 c = 0;
    if (qi & 1) c |= 0x0200;                     /* C1 = Q0 */
    if (qi & 2) c |= 0x4000;                     /* C3 = Q1 */
    if (qi & 4) c |= 0x0100;                     /* C0 = Q2 */
    F.sw = (F.sw & ~0x4700u) | c;                /* C2 = 0: complete */
}

void rt_fxtract(void) {
    double v = ST(0);
    if (v == 0) { ST(0) = -__builtin_inf(); fpush(v); return; }
    int e = ilogb(v);
    ST(0) = (double)e;
    fpush(scalbn(v, -e));
}

double rt_ldext(u32 a) {
    u64 mant = rd64(a);
    u32 se = rd16(a + 8);
    int ex = se & 0x7FFF;
    double v;
    if (ex == 0 && mant == 0) v = 0.0;
    else if (ex == 0x7FFF) v = (mant << 1) ? __builtin_nan("") : __builtin_inf();
    else v = ldexp((double)mant, ex - 16383 - 63);
    return (se & 0x8000) ? -v : v;
}
void rt_stext(u32 a, double v) {
    u64 bits; __builtin_memcpy(&bits, &v, 8);
    u32 sign = (u32)(bits >> 63) << 15;
    int ex = (int)((bits >> 52) & 0x7FF);
    u64 frac = bits & 0xFFFFFFFFFFFFFull;
    u64 mant; u32 se;
    if (ex == 0 && frac == 0) { mant = 0; se = sign; }
    else if (ex == 0x7FF) { mant = 0x8000000000000000ull | (frac << 11); se = sign | 0x7FFF; }
    else if (ex == 0) {                           /* double denormal -> normal extended */
        int sh = __builtin_clzll(frac) - 11;      /* bring leading 1 to bit 52 */
        frac <<= sh; mant = (frac << 11); se = sign | (u32)(1 - 1023 - sh + 16383);
    } else { mant = 0x8000000000000000ull | (frac << 11); se = sign | (u32)(ex - 1023 + 16383); }
    wr64(a, mant); wr16(a + 8, se);
}
double rt_sin(double v) { return sin(v); }
double rt_cos(double v) { return cos(v); }
double rt_tan(double v) { return tan(v); }
double rt_atan2(double y, double x) { return atan2(y, x); }
double rt_log2(double v) { return log2(v); }
double rt_exp2(double v) { return exp2(v); }
double rt_ldexp(double v, int e) { return ldexp(v, e); }
double rt_trunc(double v) { return __builtin_trunc(v); }

/* ---------------------------------------------------------------- rotate through carry */
u32 rt_rcl(u32 d, u32 c, u32 bits, u32 *cf) {
    u32 m = bits == 32 ? 0xFFFFFFFFu : ((1u << bits) - 1);
    c = (c & 31) % (bits + 1);
    u32 carry = *cf;
    while (c--) { u32 msb = (d >> (bits - 1)) & 1; d = ((d << 1) | carry) & m; carry = msb; }
    *cf = carry; return d;
}
u32 rt_rcr(u32 d, u32 c, u32 bits, u32 *cf) {
    u32 m = bits == 32 ? 0xFFFFFFFFu : ((1u << bits) - 1);
    c = (c & 31) % (bits + 1);
    u32 carry = *cf;
    while (c--) { u32 lsb = d & 1; d = ((d >> 1) | (carry << (bits - 1))) & m; carry = lsb; }
    *cf = carry; return d;
}

/* ---------------------------------------------------------------- x87 environment (32-bit protected-mode layout) */
static u32 tagword(void) {
    u32 tw = 0;
    for (int p = 0; p < 8; p++) {
        u32 t = F.tag[p];
        if (t != 3) { double v = F.st[p]; t = (v == 0) ? 1 : (v != v || __builtin_isinf(v)) ? 2 : 0; }
        tw |= t << (2 * p);
    }
    return tw;
}
void rt_fstenv(u32 a) {
    wr32(a, F.cw | 0xFFFF0000u); wr32(a + 4, fstsw() | 0xFFFF0000u); wr32(a + 8, tagword() | 0xFFFF0000u);
    wr32(a + 12, 0); wr32(a + 16, 0); wr32(a + 20, 0); wr32(a + 24, 0xFFFF0000u);
}
void rt_fldenv(u32 a) {
    F.cw = rd16(a); u32 sw = rd16(a + 4); F.top = (sw >> 11) & 7; F.sw = sw & ~0x3800u;
    u32 tw = rd16(a + 8);
    for (int p = 0; p < 8; p++) F.tag[p] = ((tw >> (2 * p)) & 3) == 3 ? 3 : 0;
}
void rt_fsave(u32 a) {
    rt_fstenv(a);
    for (int i = 0; i < 8; i++) rt_stext(a + 28 + 10 * i, ST(i));
    F.cw = 0x37F; F.sw = 0; F.top = 0; for (int q = 0; q < 8; q++) F.tag[q] = 3;
}
void rt_frstor(u32 a) {
    rt_fldenv(a);
    for (int i = 0; i < 8; i++) ST(i) = rt_ldext(a + 28 + 10 * i);
}
/* fixed CPU identity (the recording machine is not known): GenuineIntel, family 6, MMX/SSE/SSE2/CMOV/TSC/FXSR */
void rt_cpuid(u32 *eax, u32 *ebx, u32 *ecx, u32 *edx) {
    u32 leaf = *eax;
    if (leaf == 0) { *eax = 1; *ebx = 0x756E6547; *edx = 0x49656E69; *ecx = 0x6C65746E; return; }
    if (leaf == 1) { *eax = 0x000006F6; *ebx = 0; *ecx = 0; *edx = 0x07808111u; /* FPU TSC CX8 CMOV MMX FXSR SSE SSE2 */ return; }
    *eax = *ebx = *ecx = *edx = 0;
}
