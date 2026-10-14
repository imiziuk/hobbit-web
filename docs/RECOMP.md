# Static x86 -> WebAssembly recompiler (MVP, 2026-10-14)

Goal of the track: run the original `Meridian.exe` in Chrome by translating its machine code mechanically
(no types, no calling-convention guessing). This MVP translates every function to C, compiles the C to one wasm
module, and verifies it function by function against the recorded real-game capsules.

**Main result:** all 22,227 recorded capsules (3,731 functions) PASS in wasm, with the same rules as
`tools/replay.py`. 22,226 of them are bit-exact (EAX/ECX/EDX equal too, no float tolerance needed). The one
exception (FUN_0044cb00) is within the 1e-5 float tolerance. 0 FAIL, 0 INCONCLUSIVE. Four negative controls are
all detected.

## 1. Toolchain (installed this session)
| what | where | notes |
|---|---|---|
| wasi-sdk 34 (clang/LLVM 23.1.0-rc3, wasm-ld, wasi-libc incl. libm) | `C:\tools\wasi-sdk-34.0-x86_64-windows\` | official release from github.com/WebAssembly/wasi-sdk (x86_64-windows tar.gz, about 620 MB; the tarball was deleted after extraction) |
| capstone 5.0.7 + pefile | existing scratch venv `%TEMP%\capvenv` and `tools/.venv` | disassembly |
| Node 24.15 | existing | harness, WebAssembly runtime |

No emscripten or wabt is needed. Target `wasm32-wasip1`, `-nostartfiles --no-entry`. Only `env.trap` is imported.

## 2. Files
| file | role |
|---|---|
| `recomp/cfg.py` | Loads the image and discovers functions. Builds the CFG of each function by recursive traversal. |
| `recomp/x86c.py` | The translator. Writes `out/c/chunk_NNN.c` (120 functions each), `funcs.h`, `dispatch.c`, `out/coverage.{tsv,json}` and `out/funcs.txt`. It only rewrites files whose content changed. Run it with the capvenv Python. |
| `recomp/runtime/rt.h`, `rt.c` | Machine state, paged guest memory, x87 helpers, rotate-through-carry, x87 environment save/restore, cpuid, and the harness exports (`rt_cpu/rt_fpu/rt_pt/rt_pool/rt_run`). |
| `recomp/build.py` | Compiles all chunks with clang `-O2` in parallel (about 2.5 min cold on 12 cores, objects cached), then links `out/hobbit.wasm` (38 MB). |
| `recomp/harness/replay_wasm.mjs` | Capsule replay in Node worker threads. Writes `auto/wasm_replay_results.tsv` and `recomp/out/wasm_replay_caps.tsv` (one row per capsule: verdict, strictness, x86 instructions executed). |
| `recomp/tests/insn_diff.py` | Instruction-level differential test, Unicorn vs wasm (section 6). Run it with `tools/.venv`. |
| `recomp/out/` | Generated output, gitignored (`recomp/.gitignore`). About 240 MB. |
| `recomp/PROGRESS.json` | Progress file for the user. |

To rebuild and verify:
```
%TEMP%\capvenv\Scripts\python recomp/x86c.py          # about 40 s
python recomp/build.py                                  # about 2.5 min cold
node recomp/harness/replay_wasm.mjs capsules_store/rec_20261011_stage3   # about 6 s on 11 workers
```

## 3. Design (as built)
- **Pipeline:** x86 -> C -> clang -> wasm32 (N64Recomp-style). There is one C function `void F_<addr>(void)` per
  x86 function. Basic blocks become `L_<addr>:` labels plus `goto`.
- **Function set (20,025):**
  - all 15,891 `auto/abi.tsv` entries;
  - 23 `auto/units.tsv` function starts that are missing from abi.tsv. They are reached by tail jumps. 5 capsule
    functions FAILED with "untranslated target" until these were added;
  - direct call targets;
  - code addresses referenced as data in `auto/xrefs.tsv` (vtable, EH, CRT init table, data pointer, pointer
    constant), iterated to a fixpoint.
- **CFG:** a function is everything reachable from its entry through fallthrough, jcc, jmp and switch tables.
  Switch targets come from Ghidra's `computed-jump` refs, or from reading the `[disp+r*4]` table.
  - A direct jmp or jcc to another *strong* entry (abi.tsv or units.tsv) is a tail call:
    `SYNC_OUT F_x(); return;`.
  - Code that several functions jump into is duplicated into each of them.
  - Weak entries (pointer targets) become callable functions, but never turn intra-function jumps into tail calls.
    Otherwise loops could become recursion.
- **State:**
  - `CPU R`: 8 GPRs, DF, FS base, the non-arithmetic EFLAGS bits (IF/AC/ID for pushfd/popfd), and an instruction
    counter.
  - Inside a function the GPRs are C locals. They are synced to `R` around every call and return, so no
    convention is assumed.
  - CF/PF/AF/ZF/SF/OF are C locals computed literally per instruction. clang deletes the dead ones.
- **Calls are literal:**
  - A call pushes the real return address to the emulated stack, calls `F_target()`, then checks that the callee's
    `ret` popped exactly that address (`CALLCHK`). That is why `_chkstk` and `__EH_prolog` (they move the return
    address) work unchanged.
  - `ret N` pops the address, adds N to ESP and stores the address in `R.retaddr`.
  - Indirect calls and jumps go through `disp(target)`: a binary search over the 20,025 sorted entries, then a
    call through a function-pointer table (wasm `call_indirect`).
  - A switch `jmp [table]` becomes a C `switch` over its known targets. Anything else falls back to `disp`.
  - An unknown target traps with its address.
- **Guest memory:** guest addresses are used unchanged. The harness build uses a **paged model**: `PT[addr>>12]`
  gives the page's place in a pool inside linear memory, or 0 if unmapped (bit 0 = read-only).
  - Accessors are out of line. Inlined, they made the code 2.5x bigger.
  - The paged model reproduces Unicorn's "memory outside the capsule" detection exactly.
  - For the game, the same C can be compiled against a flat model (guest address = linear address, exe mapped at
    0x400000). See next steps.
- **x87:** 8 `double` registers with TOP, tags, CW and SW.
  - Precision control is emulated: with PC=24 bit (CW 0x007F, the state in **20,999 of 22,227 capsules**,
    because Direct3D lowers it), every add/sub/mul/div/sqrt result is rounded to single precision.
  - Rounding control is applied to fist/fistp/frndint.
  - fcom/fucom/ftst/fxam/fnstsw, transcendentals (via libm), fprem/fprem1/fscale/fxtract, 80-bit load/store,
    fnstenv/fldenv/fnsave/frstor.
  - The x87 code is decoded from the opcode bytes, not from capstone's mnemonics (this avoids the fsub/fsubr
    reg-form ambiguity).
- **MMX/SSE:** the subset the exe uses.
  - MMX: movd/movq, padd/psub(s), pmullw, pmaddwd, shifts, punpck, packssdw/packuswb, logic, emms.
  - SSE: movaps/movups/movss, shufps, add/sub/mul/div/min/max ps and ss.
  - MMX instructions set TOP to 0 and the tags to valid, as on hardware.
- **Traps** call the imported `env.trap`, which throws a JS exception. That unwinds all wasm frames, and the
  harness restores `__stack_pointer`. Trap kinds: unmapped read/write, write to code, external or untranslated
  target, unsupported or undecodable instruction, bad return, instruction limit (3,000,000, counted per basic
  block), #DE, int3/int/hlt.

## 4. Translation coverage
| kind | functions | fully translated | x86 instructions |
|---|---|---|---|
| game | 8,373 | **8,373** | 729,783 (100%) |
| crt/lib | 837 | **837** | 52,848 (100%) |
| unwind funclets | 6,596 | 6,596 | 16,824 |
| thunks | 83 | 83 | 84 |
| SEH catch funclets | 2 | 2 | 25 |
| units.tsv-only | 23 | 23 | 726 |
| call/pointer targets (extra) | 4,111 | 4,036 | 99,773 (99.6%) |
| **total** | **20,025** | 19,950 | 900,063 instructions, 899,711 translated |

The 321 untranslated instructions (plus 31 undecodable) are all in the "call/pointer-target" group. They are
garbage decodes: pointer constants that land in data or in the middle of instructions (`outsd` 257, `push es` 18,
`les`, `in/out`, `das`, ...). Each one compiles to a trap. Details are in `recomp/out/coverage.json`.

Generated C is 62 MB; `hobbit.wasm` is 38 MB. TurboFan compiles the whole module in 5.5 s (`--no-liftoff`).

## 5. Capsule results (`auto/wasm_replay_results.tsv`)
- **Rules.** The PASS rules are those of `tools/replay.py check_outputs`, plus the NaN fix from replay_exe.py:
  - ESP after return, EBX/ESI/EDI/EBP, x87 depth;
  - EAX/EDX/ST0 according to the return kind recorded in the capsule;
  - every byte the original wrote;
  - every byte we wrote must keep its old value (frame, TEB and >= 0xBAD00000 excluded);
  - float tolerance 1e-5.
- **Gate.** The determinism gate (run A) is the Unicorn baseline from REPLAY_EXE.md: 22,227/22,227 capsules
  reproduce. The verdict is therefore about our run only.
  - A read or write outside the capsule, or a jump outside the image, would be INCONCLUSIVE.
  - An untranslated in-image target is counted as FAIL, not INCONCLUSIVE.

| run | capsules PASS / FAIL / INC | functions PASS / FAIL / INC |
|---|---|---|
| first full run | 22,214 / 13 / 0 | 3,724 / 7 / 0 (5 functions missing from abi.tsv, 2 capsules with SSE) |
| **final** | **22,227 / 0 / 0** | **3,731 / 0 / 0** |

- **Strictness of the final run.**
  - 22,226 capsules are exact: EAX, ECX and EDX match the recording too, even where the rules do not require
    it, and no float tolerance was used.
  - 1 capsule (FUN_0044cb00) needed the tolerance.
- **Size of the test.**
  - The replay executed **78.4 M x86 instructions**.
  - It entered **3,982 distinct translated functions**: 3,807 game, 134 CRT, 7 thunks, 34 others
    (`recomp/out/wasm_replay_entered.txt`).
  - Callees run as translated code, so the capsules test whole call trees, not isolated functions.
- **Speed.** About 6 s on 11 workers, 8.6 s on 1 worker, harness I/O included. That is more than 9 M x86
  instructions per second single-threaded, with the paged accessors.

**Negative controls (all detected).**
| mutation | capsules PASS / FAIL / INC |
|---|---|
| `--mutate 1`: x87 precision control ignored (pure double) | 22,166 / 60 / 1. In addition, 917 of the PASSes now need the float tolerance |
| `--mutate 2`: x87 rounding control ignored (`_ftol` chop becomes round-to-nearest) | 21,210 / 506 / 511 |
| `--mutate 4`: flip bit 0 of 32-bit stores at page offset 0x100 | 22,168 / 36 / 23 |
| translator mutation `RECOMP_MUTATE=sbb` (sbb ignores the borrow) | 21,074 / 672 / 481 |

`--mutate 1` shows that the 24-bit precision emulation is required for exact results.

## 6. Instruction-level differential test (`recomp/tests/insn_diff.py`)
The capsules only reach about 4,000 functions. This test covers instruction *forms* that the capsules may never
execute.
- **Test functions.**
  - For each (mnemonic, operand shape) used by the abi/units functions, take up to 4 real instruction encodings
    from the exe: 269 shapes, 868 encodings.
  - Wrap each one as `push [FLAGIN]; popfd; I; pushfd; and [esp], MASK; pop [FLAGOUT]; ret`.
  - MASK removes the flags Intel documents as undefined: AF after logic ops and shifts, OF after multi-bit shifts,
    SZAP after mul/imul, everything after div, and so on.
- **Inputs.** Each test runs in Unicorn on 8 random inputs: GPRs, flags including DF, and lazily mapped random
  memory. The touched pages and the changed bytes are written as capsules.
- **Replay.** The same translator produces `tests.wasm`, and the harness replays it with `--all-regs` (all 8 GPRs).

**Result: 5,530 PASS, 0 FAIL, 2 INCONCLUSIVE, all bit-exact.**
- The 2 INCONCLUSIVE are test artefacts: random addresses that hit the synthetic code region, which Unicorn has
  mapped.
- 1,412 inputs were skipped because they fault in Unicorn (mostly #DE).

Not covered by this test, but covered by the capsules: x87, MMX/SSE, string instructions (segment-prefixed
operands are filtered out), push/pop/stack and control flow.

## 7. Known deviations (documented, none visible in the capsules)
1. **Arithmetic flags do not survive call/ret.** They are per-function locals that start at 0. MSVC code never
   reads flags set by a callee.
2. **x87 is float64, not 80-bit.**
   - PC=64 is treated as 53-bit.
   - Arithmetic always rounds to nearest (wasm has no rounding modes), so chop-mode arithmetic is wrong. Only
     21 capsules run with CW 0x0C7F, and all of them pass.
   - With PC=24, results beyond the float exponent range overflow to inf. On x87 the exponent range stays
     extended.
   - Transcendentals use libm, not x87 microcode.
   - `fld`/`fstp tbyte` keeps only 53 mantissa bits.
   - x87 exceptions and stack-fault flags are not emulated.
3. **MMX registers are separate from ST0-7.** Aliasing of the values is not emulated; TOP and the tags are.
4. **cpuid returns a fixed identity:** GenuineIntel family 6 with FPU, TSC, CX8, CMOV, MMX, FXSR, SSE and SSE2.
   The game's MMX check (0x69154e) then takes the MMX path, as it presumably did on the recording machine.
5. **Non-local control flow traps.** A `ret` to an address other than the pushed one traps, and so do SEH, C++
   throw and longjmp. Nothing in the capsules needs them.
6. **No runtime code discovery.** An indirect target that is not a known entry traps with its address.
7. **Segment overrides other than FS are ignored** (flat model). GS and far calls are unsupported (they appear
   only in garbage decodes).
8. **The instruction limit counts per basic block:** a `rep` string instruction counts as 1.

## 8. Next steps
1. **Flat memory model for the game build.** The guest address is the linear address, with an offset or base 0
   and the exe mapped at 0x400000. Accesses become single wasm loads (the paged model costs a call plus a table
   lookup each).
   - The guest heap and stack need a 2-4 GB `WebAssembly.Memory`, or a 31-bit remap of the game's address ranges.
   - Keep the paged build for verification.
2. **Import layer.** Map every IAT slot (`auto/imports.tsv`, 167 imports) to a host function id. `disp` then
   routes those ids to JS stubs that pop the stdcall arguments (`popBytes` from the D3D8 bridge,
   WEB_PORT_D3D8.md) and set EAX. The bridge reads arguments from the emulated stack: `R.esp` plus linear memory.
3. **Process start.** Start from entry 0x006C0C90 (RUNTIME_INIT.md): CRT init, static initializers and the TEB/FS
   chain in emulated memory.
4. **SEH and C++ exceptions.** Use host-side `RaiseException` that walks the FS:[0] chain and calls translated
   handlers. A "resume at address" path is needed for `_except_handler3` and catch funclets, for example
   multi-entry functions or wasm exception handling.
5. **Threads and blocking loops:** WEB_PORT_THREADS.md and WEB_PORT_LOOPS.md (JSPI yield points in the
   translated loops).
6. **More verification.**
   - Record new capsule sessions covering other levels and menus, so that more of the 8,373 game functions are
     tested.
   - Extend `insn_diff.py` to x87, MMX and string instructions.
   - Add a whole-program differential test against the HBRC recorder traces.

## 9. Boot (game build)
The flat game build, the JS host (Win32/DirectX shims, JSPI green threads) and the boot to the main menu in Node and
Chrome are documented in `docs/RECOMP_BOOT.md`.
