/* Runtime for the x86 -> C -> wasm32 static recompiler (Hobbit-Decomp/recomp).
   Machine state is literal: 8 GPRs, a direction flag, FS base, x87 stack/control/status, guest memory addressed by
   32-bit guest addresses. Arithmetic flags are C locals inside each translated function (clang removes the dead
   ones); they do not survive calls/returns (documented deviation, MSVC code never relies on them there). */
#ifndef RECOMP_RT_H
#define RECOMP_RT_H
#include <stdint.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef uint64_t u64;
typedef int8_t i8; typedef int16_t i16; typedef int32_t i32; typedef int64_t i64;

typedef struct {
    u32 eax, ecx, edx, ebx, esp, ebp, esi, edi;   /* 0..28 */
    u32 retaddr;                                  /* 32: address popped by the last ret */
    u32 df;                                       /* 36: direction flag */
    u32 fs_base;                                  /* 40 */
    u32 icount;                                   /* 44 */
    u32 ilimit;                                   /* 48 */
    u32 eflags;                                   /* 52: entry eflags (only DF/pushfd use) */
    u32 last_ip;                                  /* 56: address of the last trapped/ unsupported insn */
    u32 mut;                                      /* 60: negative-control mutations (harness --mutate), 0 = exact */
} CPU;
typedef struct {
    double st[8];                                 /* 0..64 physical registers */
    u32 top;                                      /* 64 */
    u32 cw;                                       /* 68 */
    u32 sw;                                       /* 72 (without TOP) */
    u32 tag[8];                                   /* 76: 0 valid, 3 empty */
} FPU;
typedef union { u64 q[2]; u32 d[4]; u16 w[8]; u8 b[16]; float f[4]; i16 sw[8]; i32 sd[4]; i8 sb[16]; } V128;
extern CPU R;
extern FPU F;
extern V128 XM[8];   /* SSE xmm0-7 */
extern u64 MM[8];    /* MMX mm0-7 (kept separate from the x87 registers: documented deviation) */
static inline void mmx_enter(void) { F.top = 0; for (int q = 0; q < 8; q++) F.tag[q] = 0; }

/* traps (implemented by the host: throws, never returns) */
enum { T_RD = 1, T_WR = 2, T_RO = 3, T_EXT = 4, T_UNSUP = 5, T_RET = 6, T_LIMIT = 7, T_DE = 8, T_INT = 9,
       T_BAD = 10, T_X87 = 11 };
__attribute__((import_module("env"), import_name("trap"))) void host_trap(u32 code, u32 a, u32 b);
static inline __attribute__((noreturn)) void rt_trap(u32 code, u32 a, u32 b) { host_trap(code, a, b); __builtin_unreachable(); }

/* ---------------------------------------------------------------- guest memory (paged model)
   PT[page] = host linear address of the 4 KiB page | flags (bit0 = read-only); 0 = unmapped.
   The game build would use a flat model (guest address = linear address); the replay harness needs the paged
   model to detect accesses outside a capsule exactly like Unicorn's unmapped-memory hook. */
#ifndef RT_FLAT
extern u32 PT[1u << 20];
u32 rd8(u32 a); u32 rd16(u32 a); u32 rd32(u32 a); u64 rd64(u32 a);
void wr8(u32 a, u32 v); void wr16(u32 a, u32 v); void wr32(u32 a, u32 v); void wr64(u32 a, u64 v);
#else
/* flat model (game build): guest address == wasm linear address; the exe image is mapped at 0x400000 by the host */
static inline u32 rd8(u32 a) { return *(u8 *)(uintptr_t)a; }
static inline u32 rd16(u32 a) { u16 v; __builtin_memcpy(&v, (void *)(uintptr_t)a, 2); return v; }
static inline u32 rd32(u32 a) { u32 v; __builtin_memcpy(&v, (void *)(uintptr_t)a, 4); return v; }
static inline u64 rd64(u32 a) { u64 v; __builtin_memcpy(&v, (void *)(uintptr_t)a, 8); return v; }
static inline void wr8(u32 a, u32 v) { *(u8 *)(uintptr_t)a = (u8)v; }
static inline void wr16(u32 a, u32 v) { u16 x = (u16)v; __builtin_memcpy((void *)(uintptr_t)a, &x, 2); }
static inline void wr32(u32 a, u32 v) { __builtin_memcpy((void *)(uintptr_t)a, &v, 4); }
static inline void wr64(u32 a, u64 v) { __builtin_memcpy((void *)(uintptr_t)a, &v, 8); }
#endif
static inline float rdf32(u32 a) { u32 v = rd32(a); float f; __builtin_memcpy(&f, &v, 4); return f; }
static inline double rdf64(u32 a) { u64 v = rd64(a); double f; __builtin_memcpy(&f, &v, 8); return f; }
static inline void wrf32(u32 a, float f) { u32 v; __builtin_memcpy(&v, &f, 4); wr32(a, v); }
static inline void wrf64(u32 a, double f) { u64 v; __builtin_memcpy(&v, &f, 8); wr64(a, v); }

static inline u32 PAR(u32 v) { return !__builtin_parity(v & 0xFF); }

/* dispatcher (generated): indirect call / indirect jump target -> translated function */
void disp(u32 target);
/* target that is not a translated entry: trap (harness) or host import / HLE thunk (flat game build) */
void rt_ext(u32 target);
#ifdef RT_FLAT
void rt_hle(u32 func);   /* translated function replaced by a host implementation (recomp/hle.txt) */
__attribute__((import_module("env"), import_name("host_probe"))) void rt_probe(u32 func);   /* recomp/probes.txt */
#endif

/* ---------------------------------------------------------------- x87 (float64 model with precision control) */
#define ST(i) F.st[(F.top + (i)) & 7]
static inline void fpush(double v) { F.top = (F.top - 1) & 7; F.st[F.top] = v; F.tag[F.top] = 0; }
static inline void fpop(void) { F.tag[F.top] = 3; F.top = (F.top + 1) & 7; }
/* arithmetic result rounding: PC=00 (24-bit) rounds to single; 53/64-bit kept as double */
static inline double PR(double v) { return (((F.cw >> 8) & 3) == 0 && !(R.mut & 1)) ? (double)(float)v : v; }
double rt_frnd(double v);
u32 rt_fist32(double v); u32 rt_fist16(double v); u64 rt_fist64(double v);
void rt_fcom(double a, double b);         /* sets C0/C2/C3 */
void rt_fxam(void);
void rt_fprem(int ieee);
void rt_fxtract(void);
void rt_fstenv(u32 a); void rt_fldenv(u32 a); void rt_fsave(u32 a); void rt_frstor(u32 a);
void rt_cpuid(u32 *eax, u32 *ebx, u32 *ecx, u32 *edx);
double rt_ldext(u32 a); void rt_stext(u32 a, double v);
double rt_sin(double), rt_cos(double), rt_tan(double), rt_atan2(double, double), rt_log2(double), rt_exp2(double),
       rt_ldexp(double, int), rt_trunc(double);
static inline u32 fstsw(void) { return (F.sw & ~0x3800u) | ((F.top & 7) << 11); }

/* rotate-through-carry helpers */
u32 rt_rcl(u32 d, u32 c, u32 bits, u32 *cf);
u32 rt_rcr(u32 d, u32 c, u32 bits, u32 *cf);

#define SYNC_OUT R.eax = eax; R.ecx = ecx; R.edx = edx; R.ebx = ebx; R.esp = esp; R.ebp = ebp; R.esi = esi; R.edi = edi;
#define SYNC_IN eax = R.eax; ecx = R.ecx; edx = R.edx; ebx = R.ebx; esp = R.esp; ebp = R.ebp; esi = R.esi; edi = R.edi;
#define LOCALS u32 eax = R.eax, ecx = R.ecx, edx = R.edx, ebx = R.ebx, esp = R.esp, ebp = R.ebp, esi = R.esi, edi = R.edi; \
               u32 cf = 0, zf = 0, sf = 0, of = 0, pf = 0, af = 0; (void)cf; (void)zf; (void)sf; (void)of; (void)pf; (void)af;
#define IC(n) do { if (__builtin_expect((R.icount += (n)) > R.ilimit, 0)) rt_trap(T_LIMIT, 0, 0); } while (0)
#define TRAP(code, a) do { SYNC_OUT R.last_ip = (a); rt_trap((code), (a), 0); } while (0)
#define CALLCHK(next) do { if (__builtin_expect(R.retaddr != (u32)(next), 0)) rt_trap(T_RET, (next), R.retaddr); } while (0)
#endif
