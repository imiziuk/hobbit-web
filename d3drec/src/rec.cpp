// d3drec recorder core. See rec.h and docs/D3DREC.md.
#include "rec.h"
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <intrin.h>

namespace d3drec {

Recorder g;
thread_local int t_inRec = 0;
static DWORD s_writerTid = 0;

static inline uint32_t rd32(const uint8_t* p) { uint32_t v; memcpy(&v, p, 4); return v; }

/* ------------------------------------------------------------------ LZ4 block format (compressor) */
// Standard LZ4 block: [token: lit<<4 | (match-4)] [lit len ext] [literals] [offset u16] [match len ext] ...
// The last sequence is literals only; the last 5 bytes are literals and the last match starts >= 12 bytes
// before the end, so any LZ4 block decoder (and reader.js) accepts it.
size_t lz4Compress(const uint8_t* src, size_t n, uint8_t* dst) {
    static thread_local std::vector<uint32_t> table;
    uint8_t* op = dst;
    auto emit = [&](size_t litStart, size_t litLen, size_t off, size_t mlen) {
        uint8_t* tok = op++;
        uint8_t t = (uint8_t)((litLen >= 15 ? 15 : litLen) << 4);
        if (litLen >= 15) { size_t r = litLen - 15; while (r >= 255) { *op++ = 255; r -= 255; } *op++ = (uint8_t)r; }
        memcpy(op, src + litStart, litLen); op += litLen;
        if (mlen) {
            *op++ = (uint8_t)(off & 255); *op++ = (uint8_t)(off >> 8);
            size_t ml = mlen - 4;
            t |= (uint8_t)(ml >= 15 ? 15 : ml);
            if (ml >= 15) { size_t r = ml - 15; while (r >= 255) { *op++ = 255; r -= 255; } *op++ = (uint8_t)r; }
        }
        *tok = t;
    };
    size_t anchor = 0;
    if (n >= 13) {
        table.assign(1u << 16, 0);
        const size_t mflimit = n - 12, matchlimit = n - 5;
        size_t ip = 0;
        while (ip < mflimit) {
            uint32_t seq = rd32(src + ip), h = (seq * 2654435761u) >> 16;
            uint32_t ref = table[h];
            table[h] = (uint32_t)ip + 1;
            if (ref && ip - (ref - 1) <= 65535 && rd32(src + ref - 1) == seq) {
                size_t r = ref - 1;
                while (ip > anchor && r > 0 && src[ip - 1] == src[r - 1]) { ip--; r--; }
                size_t len = 4;
                while (ip + len < matchlimit && src[r + len] == src[ip + len]) len++;
                emit(anchor, ip - anchor, ip - r, len);
                ip += len; anchor = ip;
                if (ip < mflimit) table[(rd32(src + ip - 2) * 2654435761u) >> 16] = (uint32_t)(ip - 2) + 1;
            } else {
                ip += 1 + ((ip - anchor) >> 6);   // skip faster through incompressible data
            }
        }
    }
    emit(anchor, n - anchor, 0, 0);
    return (size_t)(op - dst);
}

/* ------------------------------------------------------------------ content hash (dedupe key, with the length) */
uint64_t hash64(const uint8_t* p, size_t n) {
    uint32_t a = 0x9E3779B1u ^ (uint32_t)n, b = 0x85EBCA77u, i2;
    size_t i = 0;
    for (; i + 8 <= n; i += 8) {
        a = _rotl(a + rd32(p + i) * 0x85EBCA77u, 13) * 0x9E3779B1u;
        b = _rotl(b + rd32(p + i + 4) * 0xC2B2AE3Du, 17) * 0x27D4EB2Fu;
    }
    for (; i < n; i++) a = _rotl(a ^ (p[i] * 0x165667B1u), 11) * 0x9E3779B1u;
    auto fm = [](uint32_t h) { h ^= h >> 16; h *= 0x85EBCA6Bu; h ^= h >> 13; h *= 0xC2B2AE35u; h ^= h >> 16; return h; };
    i2 = fm(b ^ _rotl(a, 19) ^ (uint32_t)n);
    return (uint64_t)fm(a ^ _rotl(b, 7)) << 32 | i2;
}

/* ------------------------------------------------------------------ writer thread */
static const uint32_t FILE_MAGIC = 0x52443344;   // "D3DR"
static const uint32_t CHUNK_MAGIC = 0x4B4E4843;  // "CHNK"
static const uint32_t FILE_VERSION = 1;

bool Writer::open(const char* path, const std::string& headerJson) {
    file_ = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) return false;
    std::vector<uint8_t> h(12);
    uint32_t v[3] = {FILE_MAGIC, FILE_VERSION, (uint32_t)headerJson.size()};
    memcpy(h.data(), v, 12);
    h.insert(h.end(), headerJson.begin(), headerJson.end());
    DWORD wr = 0;
    WriteFile(file_, h.data(), (DWORD)h.size(), &wr, nullptr);
    written_ = wr;
    InitializeCriticalSectionAndSpinCount(&cs_, 2000);
    InitializeConditionVariable(&cvWork_); InitializeConditionVariable(&cvSpace_); InitializeConditionVariable(&cvIdle_);
    thread_ = CreateThread(nullptr, 0, threadMain, this, 0, &s_writerTid);
    return thread_ != nullptr;
}

void Writer::writeChunk(const std::vector<uint8_t>& raw, uint32_t seq, std::vector<uint8_t>& out) {
    size_t n = raw.size();
    out.resize(16 + (compress ? lz4Bound(n) : n));
    uint32_t comp = 0;
    if (compress) {
        size_t c = lz4Compress(raw.data(), n, out.data() + 16);
        if (c < n) comp = (uint32_t)c;
    }
    if (!comp) memcpy(out.data() + 16, raw.data(), n);
    uint32_t hd[4] = {CHUNK_MAGIC, seq, (uint32_t)n, comp};
    memcpy(out.data(), hd, 16);
    DWORD total = 16 + (comp ? comp : (DWORD)n), wr = 0;
    WriteFile(file_, out.data(), total, &wr, nullptr);   // one call per chunk: a chunk is on disk whole or not at all
    written_ += wr; raw_ += n;
}

DWORD WINAPI Writer::threadMain(void* self) {
    Writer* w = (Writer*)self;
    std::vector<uint8_t> out;
    EnterCriticalSection(&w->cs_);
    for (;;) {
        while (w->q_.empty() && !w->stop_) SleepConditionVariableCS(&w->cvWork_, &w->cs_, INFINITE);
        if (w->q_.empty()) break;
        auto& item = w->q_.front();   // deque references stay valid across push_back
        w->busy_ = true;
        LeaveCriticalSection(&w->cs_);
        w->writeChunk(item.second, item.first, out);
        EnterCriticalSection(&w->cs_);
        w->lastWritten_ = item.first;
        w->queued_ -= item.second.size();
        w->q_.pop_front();
        w->busy_ = false;
        WakeAllConditionVariable(&w->cvSpace_);
        if (w->q_.empty()) WakeAllConditionVariable(&w->cvIdle_);
    }
    LeaveCriticalSection(&w->cs_);
    return 0;
}

void Writer::push(std::vector<uint8_t>&& chunk) {
    if (!thread_ || chunk.empty()) return;
    EnterCriticalSection(&cs_);
    while (queued_ > queueLimit && !stop_) SleepConditionVariableCS(&cvSpace_, &cs_, 50);
    queued_ += chunk.size();
    q_.emplace_back(nextSeq_++, std::move(chunk));
    WakeConditionVariable(&cvWork_);
    LeaveCriticalSection(&cs_);
}

void Writer::drain(DWORD timeoutMs) {
    if (!thread_) return;
    DWORD t0 = GetTickCount();
    EnterCriticalSection(&cs_);
    while (!q_.empty()) {
        DWORD el = GetTickCount() - t0;
        if (el >= timeoutMs) break;
        SleepConditionVariableCS(&cvIdle_, &cs_, timeoutMs - el);
    }
    LeaveCriticalSection(&cs_);
}

void Writer::close() {
    if (!thread_) return;
    drain(15000);
    EnterCriticalSection(&cs_);
    stop_ = true;
    WakeAllConditionVariable(&cvWork_);
    LeaveCriticalSection(&cs_);
    WaitForSingleObject(thread_, 15000);
    CloseHandle(thread_); thread_ = nullptr;
    CloseHandle(file_); file_ = INVALID_HANDLE_VALUE;
}

void Writer::emergency() {
    // All other threads are gone (DLL_PROCESS_DETACH at process exit): the writer may have died mid-chunk, after its
    // WriteFile but before pop_front, so the reader drops repeated sequence numbers.
    if (file_ == INVALID_HANDLE_VALUE) return;
    std::vector<uint8_t> out;
    for (auto& it : q_) if (it.first > lastWritten_) writeChunk(it.second, it.first, out);
    q_.clear();
    CloseHandle(file_); file_ = INVALID_HANDLE_VALUE;
    thread_ = nullptr;
}

/* ------------------------------------------------------------------ recorder */
Recorder::Recorder() {
    InitializeCriticalSectionAndSpinCount(&cs_, 4000);
    QueryPerformanceFrequency(&freq_);
    QueryPerformanceCounter(&t0_);
}

double Recorder::ms() const {
    LARGE_INTEGER t; QueryPerformanceCounter(&t);
    return (double)(t.QuadPart - t0_.QuadPart) * 1000.0 / (double)freq_.QuadPart;
}

void Recorder::textf(const char* fmt, ...) {
    if (!text) return;
    va_list ap; va_start(ap, fmt);
    fprintf(text, "[%9.1f ms] ", ms());
    vfprintf(text, fmt, ap);
    fputc('\n', text);
    fflush(text);
    va_end(ap);
}

void Recorder::loadConfig(HMODULE self) {
    char path[MAX_PATH];
    GetModuleFileNameA(self, path, MAX_PATH);
    char* slash = strrchr(path, '\\');
    if (slash) slash[1] = 0;
    strcpy_s(cfg.dllDir, path);
    char ini[MAX_PATH];
    sprintf_s(ini, "%sd3drec.ini", cfg.dllDir);
    const char* S = "d3drec";
    cfg.enabled = GetPrivateProfileIntA(S, "enabled", 1, ini) != 0;
    GetPrivateProfileStringA(S, "chain", cfg.chain, cfg.chain, MAX_PATH, ini);
    GetPrivateProfileStringA(S, "output_dir", cfg.outDir, cfg.outDir, MAX_PATH, ini);
    GetPrivateProfileStringA(S, "shot_method", cfg.shotMethod, cfg.shotMethod, sizeof cfg.shotMethod, ini);
    cfg.shotInterval = GetPrivateProfileIntA(S, "shot_interval", cfg.shotInterval, ini);
    cfg.shotScale = GetPrivateProfileIntA(S, "shot_scale", cfg.shotScale, ini);
    cfg.chunkKB = GetPrivateProfileIntA(S, "chunk_kb", cfg.chunkKB, ini);
    cfg.queueMB = GetPrivateProfileIntA(S, "queue_mb", cfg.queueMB, ini);
    cfg.maxMB = GetPrivateProfileIntA(S, "max_mb", cfg.maxMB, ini);
    cfg.diff = GetPrivateProfileIntA(S, "diff", cfg.diff, ini);
    cfg.compress = GetPrivateProfileIntA(S, "compress", cfg.compress, ini);
    cfg.stopAfterFrames = GetPrivateProfileIntA(S, "stop_after_frames", cfg.stopAfterFrames, ini);
    cfg.vehFlush = GetPrivateProfileIntA(S, "veh_flush", cfg.vehFlush, ini);
    if (cfg.shotScale < 1) cfg.shotScale = 1;
    if (cfg.chunkKB < 64) cfg.chunkKB = 64;
    if (_stricmp(cfg.shotMethod, "off") == 0) cfg.shotInterval = 0;
}

static std::string jsonStr(const char* s) {
    std::string o = "\"";
    for (; *s; s++) {
        if (*s == '\\') o += '/';
        else if (*s == '"') o += "\\\"";
        else if ((unsigned char)*s < 0x20) o += ' ';
        else o += *s;
    }
    return o + "\"";
}

static bool isFatal(DWORD c) {
    switch (c) {
    case 0xC0000005: case 0xC0000006: case 0xC000001D: case 0xC0000096: case 0xC00000FD:
    case 0xC000008C: case 0xC000008D: case 0xC000008E: case 0xC000008F: case 0xC0000090:
    case 0xC0000091: case 0xC0000092: case 0xC0000093: case 0xC0000094: case 0xC0000095:
    case 0xC0000374: case 0xC0000409: return true;
    }
    return false;
}

// Vectored handler, registered LAST and always returning CONTINUE_SEARCH: the game's own
// SetUnhandledExceptionFilter (0065ea60) and any SEH still run exactly as before. It only pushes the current
// chunk to the writer and waits for the disk, so a crash loses nothing that was recorded before it.
LONG CALLBACK vehHandler(PEXCEPTION_POINTERS ep) {
    DWORD code = ep->ExceptionRecord->ExceptionCode;
    if (!g.on || !isFatal(code) || GetCurrentThreadId() == s_writerTid) return EXCEPTION_CONTINUE_SEARCH;
    static volatile LONG count = 0;
    LONG c = InterlockedIncrement(&count);
    if (t_inRec == 0 && TryEnterCriticalSection(&g.cs_)) {
        if (c <= 50 && code != 0xC00000FD)
            g.event("first-chance exception %08lx at %p, frame %u", code, ep->ExceptionRecord->ExceptionAddress, g.frame);
        g.handOff();
        LeaveCriticalSection(&g.cs_);
    }
    if (c <= 200) g.w_.drain(1000);
    return EXCEPTION_CONTINUE_SEARCH;
}

bool Recorder::start() {
    if (on) return true;
    char dir[MAX_PATH];
    if (strchr(cfg.outDir, ':') || cfg.outDir[0] == '\\') strcpy_s(dir, cfg.outDir);
    else sprintf_s(dir, "%s%s", cfg.dllDir, cfg.outDir);
    CreateDirectoryA(dir, nullptr);
    SYSTEMTIME st; GetLocalTime(&st);
    char base[MAX_PATH];
    sprintf_s(base, "%s\\d3drec_%04d%02d%02d_%02d%02d%02d", dir, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    logPath = std::string(base) + ".d3dr";
    std::string txt = std::string(base) + ".txt";
    fopen_s(&text, txt.c_str(), "w");
    char exe[MAX_PATH] = "";
    GetModuleFileNameA(nullptr, exe, MAX_PATH);
    char buf[2048];
    sprintf_s(buf, "{\"format\":\"d3drec\",\"version\":1,\"created\":\"%04d-%02d-%02dT%02d:%02d:%02d\",\"pid\":%lu,"
        "\"exe\":%s,\"chain\":%s,\"shot_interval\":%d,\"shot_scale\":%d,\"shot_method\":%s,\"chunk_kb\":%d,\"diff\":%d,\"compress\":%d}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, GetCurrentProcessId(), jsonStr(exe).c_str(),
        jsonStr(cfg.chain).c_str(), cfg.shotInterval, cfg.shotScale, jsonStr(cfg.shotMethod).c_str(), cfg.chunkKB, cfg.diff, cfg.compress);
    w_.compress = cfg.compress != 0;
    w_.queueLimit = (size_t)cfg.queueMB << 20;
    if (!w_.open(logPath.c_str(), buf)) { textf("cannot open %s", logPath.c_str()); return false; }
    cur_.reserve((size_t)cfg.chunkKB * 1024 + 65536);
    lastHandOff_ = GetTickCount();
    on = true;
    if (cfg.vehFlush) AddVectoredExceptionHandler(0, vehHandler);
    textf("recording to %s", logPath.c_str());
    textf("header %s", buf);
    return true;
}

void Recorder::handOff() {
    if (cur_.empty()) return;
    std::vector<uint8_t> v;
    v.reserve((size_t)cfg.chunkKB * 1024 + 65536);
    v.swap(cur_);
    w_.push(std::move(v));
    lastHandOff_ = GetTickCount();
}

void Recorder::putData(const DataArg* d) {
    if (!d || !d->p) { put8(0); return; }
    const uint8_t* a = d->p;
    const uint32_t n = d->len;
    Key k{hash64(a, n), n};
    auto it = blobs_.find(k);
    if (it != blobs_.end()) {
        put8(2); putU(it->second);
        refBytes_ += n;
        if (d->shadow) memcpy(d->shadow, a, n);
        return;
    }
    if (d->shadow && cfg.diff) {
        const uint8_t* s = d->shadow;
        spans_.clear();
        size_t cost = 0, i = 0;
        bool giveUp = false;
        for (;;) {
            while (i + 4 <= n && rd32(a + i) == rd32(s + i)) i += 4;
            while (i < n && a[i] == s[i]) i++;
            if (i >= n) break;
            size_t st = i, last = i;
            for (i = st + 1; i < n; i++) {
                if (a[i] != s[i]) last = i;
                else if (i - last > 8) break;
            }
            size_t en = last + 1;
            spans_.push_back((uint32_t)st); spans_.push_back((uint32_t)en);
            cost += en - st + 4;
            if (cost > n / 2) { giveUp = true; break; }
            i = en;
        }
        if (!giveUp) {
            put8(3); putU((uint32_t)spans_.size() / 2);
            uint32_t prev = 0;
            for (size_t j = 0; j < spans_.size(); j += 2) {
                putU(spans_[j] - prev); putU(spans_[j + 1] - spans_[j]);
                putRaw(a + spans_[j], spans_[j + 1] - spans_[j]);
                prev = spans_[j + 1];
            }
            memcpy(d->shadow, a, n);
            diffIn_ += n; diffOut_ += cost;
            return;
        }
    }
    uint32_t id = nextBlob_++;
    blobs_[k] = id;
    put8(1); putU(id); putU(n); putRaw(a, n);
    newBytes_ += n;
    if (d->shadow) memcpy(d->shadow, a, n);
}

// Matrices go through a 4096-slot cache (same slot rule in reader.js): static objects re-send the same WORLD
// matrices every frame, and LZ4's 64 KB window cannot reach back to the previous frame.
void Recorder::putMatrix(const float* m) {
    if (!m) { put8(0); return; }
    uint64_t h = hash64((const uint8_t*)m, 64);
    auto it = mtxIndex_.find(h);
    if (it != mtxIndex_.end() && memcmp(mtx_[it->second].m, m, 64) == 0) { put8(2); putU(it->second); return; }
    uint32_t slot = mtxNext_++ & (MTX_SLOTS - 1);
    if (mtx_[slot].used) { auto old = mtxIndex_.find(mtx_[slot].h); if (old != mtxIndex_.end() && old->second == slot) mtxIndex_.erase(old); }
    memcpy(mtx_[slot].m, m, 64); mtx_[slot].h = h; mtx_[slot].used = true;
    mtxIndex_[h] = slot;
    put8(1); putRaw(m, 64);
}

void Recorder::rec(int op, uint32_t self, HRESULT hr, ...) {
    if (!on) return;
    const char* sig = OP_SIG[op];
    if (!sig) return;
    EnterCriticalSection(&cs_);
    t_inRec++;
    if (hr != S_OK) { put8(OP_Meta_HR); put32((uint32_t)hr); }
    put8((uint8_t)op);
    if (op < 192) putU(self);
    va_list ap;
    va_start(ap, hr);
    for (const char* s = sig; *s; s++) {
        switch (*s) {
        case 'u': case 'o': putU(va_arg(ap, uint32_t)); break;
        case 'i': putI(va_arg(ap, int32_t)); break;
        case 'd': put32(va_arg(ap, uint32_t)); break;
        case 'f': { float f = (float)va_arg(ap, double); uint32_t b; memcpy(&b, &f, 4); put32(b); break; }
        case 'r': {
            const RECT* r = va_arg(ap, const RECT*);
            if (!r) put8(0); else { put8(1); putI(r->left); putI(r->top); putI(r->right); putI(r->bottom); }
            break;
        }
        case 'R': case 'P': {
            uint32_t cnt = va_arg(ap, uint32_t);
            const LONG* p = va_arg(ap, const LONG*);
            if (!p) { putU(0); break; }
            putU(cnt + 1);
            for (uint32_t k = 0; k < cnt * (*s == 'R' ? 4u : 2u); k++) putI(p[k]);
            break;
        }
        case 'M': putMatrix(va_arg(ap, const float*)); break;
        case 'B': {
            const void* p = va_arg(ap, const void*);
            uint32_t len = va_arg(ap, uint32_t);
            if (!p) putU(0); else { putU(len + 1); putRaw(p, len); }
            break;
        }
        case 's': {
            const char* p = va_arg(ap, const char*);
            if (!p) putU(0); else { uint32_t len = (uint32_t)strlen(p); putU(len + 1); putRaw(p, len); }
            break;
        }
        case 'X': putData(va_arg(ap, const DataArg*)); break;
        }
    }
    va_end(ap);
    calls++;
    t_inRec--;
    if (cur_.size() >= (size_t)cfg.chunkKB * 1024) handOff();
    LeaveCriticalSection(&cs_);
}

void Recorder::event(const char* fmt, ...) {
    char buf[600];
    va_list ap; va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    textf("%s", buf);
    rec(OP_Meta_Event, 0, S_OK, buf);
}

void Recorder::endFrame() {
    if (!on) return;
    EnterCriticalSection(&cs_);
    if (GetTickCount() - lastHandOff_ > 250 || cur_.size() > (size_t)cfg.chunkKB * 512) handOff();
    LeaveCriticalSection(&cs_);
    if (frame % 900 == 0) {
        event("stats frame %u: calls %llu, raw %.1f MB, file %.1f MB, new data %.1f MB, dedupe hits %.1f MB, diff %.1f -> %.1f MB",
              frame, calls, w_.rawBytes() / 1048576.0, w_.fileBytes() / 1048576.0, newBytes_ / 1048576.0,
              refBytes_ / 1048576.0, diffIn_ / 1048576.0, diffOut_ / 1048576.0);
    }
    if (cfg.stopAfterFrames && frame >= (uint32_t)cfg.stopAfterFrames) finish("stop_after_frames reached");
    else if (w_.fileBytes() > ((uint64_t)cfg.maxMB << 20)) finish("max_mb reached");
}

void Recorder::flush(DWORD waitMs) {
    if (!on) return;
    EnterCriticalSection(&cs_);
    handOff();
    LeaveCriticalSection(&cs_);
    w_.drain(waitMs);
}

void Recorder::finish(const char* why) {
    if (!on) return;
    event("end: %s", why);
    rec(OP_Meta_End, 0, S_OK, frame, (uint32_t)calls);
    EnterCriticalSection(&cs_);
    handOff();
    on = false;
    LeaveCriticalSection(&cs_);
    w_.close();
    textf("closed: %u frames, %llu calls, raw %.1f MB, file %.1f MB (%s)", frame, calls,
          w_.rawBytes() / 1048576.0, w_.fileBytes() / 1048576.0, why);
    if (text) { fclose(text); text = nullptr; }
}

void Recorder::emergency() {
    if (!on) return;
    on = false;
    // no locks: every other thread is gone; write END into the current chunk by hand
    put8(OP_Meta_End); putU(frame); putU((uint32_t)calls);
    if (!cur_.empty()) w_.emergencyAppend(std::move(cur_));
    w_.emergency();
    if (text) { fprintf(text, "process exit: emergency flush at frame %u\n", frame); fclose(text); text = nullptr; }
}

/* ------------------------------------------------------------------ format helpers */
FmtInfo fmtInfo(DWORD f) {
    switch (f) {
    case D3DFMT_DXT1: return {0, 8, true};
    case D3DFMT_DXT2: case D3DFMT_DXT3: case D3DFMT_DXT4: case D3DFMT_DXT5: return {0, 16, true};
    case D3DFMT_A8R8G8B8: case D3DFMT_X8R8G8B8: case D3DFMT_A2B10G10R10: case D3DFMT_G16R16: case D3DFMT_X8L8V8U8:
    case D3DFMT_Q8W8V8U8: case D3DFMT_V16U16: case D3DFMT_W11V11U10: case D3DFMT_A2W10V10U10: case D3DFMT_D32:
    case D3DFMT_D24S8: case D3DFMT_D24X8: case D3DFMT_D24X4S4: return {4, 0, true};
    case D3DFMT_R8G8B8: return {3, 0, true};
    case D3DFMT_R5G6B5: case D3DFMT_X1R5G5B5: case D3DFMT_A1R5G5B5: case D3DFMT_A4R4G4B4: case D3DFMT_A8R3G3B2:
    case D3DFMT_X4R4G4B4: case D3DFMT_A8P8: case D3DFMT_A8L8: case D3DFMT_V8U8: case D3DFMT_L6V5U5:
    case D3DFMT_D16_LOCKABLE: case D3DFMT_D15S1: case D3DFMT_D16: case D3DFMT_UYVY: case D3DFMT_YUY2: return {2, 0, true};
    case D3DFMT_R3G3B2: case D3DFMT_A8: case D3DFMT_P8: case D3DFMT_L8: case D3DFMT_A4L4: return {1, 0, true};
    }
    return {4, 0, false};
}

uint32_t primVertexCount(DWORD pt, UINT n) {
    switch (pt) {
    case D3DPT_POINTLIST: return n;
    case D3DPT_LINELIST: return n * 2;
    case D3DPT_LINESTRIP: return n + 1;
    case D3DPT_TRIANGLELIST: return n * 3;
    case D3DPT_TRIANGLESTRIP: case D3DPT_TRIANGLEFAN: return n + 2;
    }
    return 0;
}

} // namespace d3drec
