// d3drec recorder core: config, record encoder, blob dedupe/diff, background writer (LZ4 chunks), crash flush.
// File format: docs/D3DREC.md section 3.
#pragma once
#include <windows.h>
#include <stdint.h>
#include <vector>
#include <deque>
#include <unordered_map>
#include <string>
#include "d3d8min.h"
#include "ops_gen.h"

namespace d3drec {

struct Config {
    bool enabled = true;
    char chain[MAX_PATH] = "d3d8_chain.dll";  // relative to the DLL folder, absolute, or "system"
    char outDir[MAX_PATH] = "d3drec_logs";    // relative to the DLL folder or absolute
    int shotInterval = 60;                    // frames between back-buffer shots (0 = off)
    int shotScale = 2;                        // box downscale factor of shots (1 = full size)
    char shotMethod[32] = "auto";             // auto | lockbb | rtcopy | copyrects | off (wrap.cpp takeShot)
    int chunkKB = 512;                        // uncompressed chunk size handed to the writer
    int queueMB = 256;                        // writer backlog before the game thread waits
    int maxMB = 8192;                         // stop recording when the file reaches this size
    int diff = 1;                             // VB/IB unlocks: send changed spans when cheaper
    int compress = 1;                         // LZ4 chunks
    int stopAfterFrames = 0;                  // 0 = record until exit
    int vehFlush = 1;                         // flush on first-chance fatal exceptions (vectored handler, CONTINUE_SEARCH)
    char dllDir[MAX_PATH] = "";
};

// Lock data handed to the 'X' field: the locked bytes plus an optional per-buffer shadow (= what the replayer has).
struct DataArg {
    const uint8_t* p = nullptr;   // NULL -> kind 0 (nothing to replay, e.g. READONLY locks)
    uint32_t len = 0;
    uint8_t* shadow = nullptr;    // same range of the buffer's shadow copy (VB/IB) or NULL (textures)
};

size_t lz4Compress(const uint8_t* src, size_t n, uint8_t* dst);   // dst capacity: lz4Bound(n)
inline size_t lz4Bound(size_t n) { return n + n / 255 + 16; }
uint64_t hash64(const uint8_t* p, size_t n);

class Writer {
public:
    bool open(const char* path, const std::string& headerJson);
    void push(std::vector<uint8_t>&& chunk);   // blocks while the backlog exceeds the limit
    void drain(DWORD timeoutMs);               // wait until everything queued is on disk (bounded)
    void close();                              // drain + stop thread + close file
    void emergency();                          // process is dying: write the backlog synchronously, no locks
    void emergencyAppend(std::vector<uint8_t>&& v) { q_.emplace_back(nextSeq_++, std::move(v)); }
    uint64_t fileBytes() const { return written_; }
    uint64_t rawBytes() const { return raw_; }
    size_t queueLimit = 256u << 20;
    bool compress = true;
private:
    static DWORD WINAPI threadMain(void* self);
    void writeChunk(const std::vector<uint8_t>& raw, uint32_t seq, std::vector<uint8_t>& out);
    HANDLE file_ = INVALID_HANDLE_VALUE, thread_ = nullptr;
    CRITICAL_SECTION cs_;
    CONDITION_VARIABLE cvWork_, cvSpace_, cvIdle_;
    std::deque<std::pair<uint32_t, std::vector<uint8_t>>> q_;   // front = being written (popped only after the write)
    size_t queued_ = 0;
    uint32_t nextSeq_ = 1, lastWritten_ = 0;
    bool stop_ = false, busy_ = false;
    volatile uint64_t written_ = 0, raw_ = 0;
};

class Recorder {
public:
    Config cfg;
    bool on = false;                // recording active
    uint32_t frame = 0;
    uint64_t calls = 0;

    void loadConfig(HMODULE self);
    bool start();                   // opens the log; called on the first Direct3DCreate8
    void rec(int op, uint32_t self, HRESULT hr, ...);   // varargs follow OP_SIG[op] (see ops.def for each field kind)
    void event(const char* fmt, ...);
    void endFrame();                // after Present: periodic stats, chunk hand-off, stop conditions
    void flush(DWORD waitMs);       // hand the current chunk to the writer and wait for the disk
    void finish(const char* why);   // END record + close (device released / DLL unload)
    void emergency();               // DLL_PROCESS_DETACH during process termination
    uint32_t newId() { return InterlockedIncrement(&nextId_); }
    double ms() const;
    std::string logPath;
    FILE* text = nullptr;           // human-readable side log (d3drec_<time>.txt)
    void textf(const char* fmt, ...);

    Recorder();
private:
    void put8(uint8_t v) { cur_.push_back(v); }
    void putU(uint32_t v) { while (v >= 0x80) { cur_.push_back((uint8_t)(v | 0x80)); v >>= 7; } cur_.push_back((uint8_t)v); }
    void putI(int32_t v) { putU(((uint32_t)v << 1) ^ (uint32_t)(v >> 31)); }
    void put32(uint32_t v) { uint8_t b[4]; memcpy(b, &v, 4); cur_.insert(cur_.end(), b, b + 4); }
    void putRaw(const void* p, size_t n) { const uint8_t* b = (const uint8_t*)p; cur_.insert(cur_.end(), b, b + n); }
    void putData(const DataArg* d);
    void putMatrix(const float* m);
    static const uint32_t MTX_SLOTS = 4096;
    struct Mtx { float m[16]; uint64_t h; bool used; };
    std::vector<Mtx> mtx_ = std::vector<Mtx>(MTX_SLOTS, Mtx{{0}, 0, false});
    std::unordered_map<uint64_t, uint32_t> mtxIndex_;
    uint32_t mtxNext_ = 0;
    void handOff();
    CRITICAL_SECTION cs_;
    std::vector<uint8_t> cur_;
    Writer w_;
    struct Key { uint64_t h; uint32_t n; bool operator==(const Key& o) const { return h == o.h && n == o.n; } };
    struct KeyHash { size_t operator()(const Key& k) const { return (size_t)(k.h ^ (k.h >> 32) ^ k.n); } };
    std::unordered_map<Key, uint32_t, KeyHash> blobs_;
    uint32_t nextBlob_ = 1;
    volatile LONG nextId_ = 0;
    LARGE_INTEGER t0_{}, freq_{};
    DWORD lastHandOff_ = 0;
    uint64_t newBytes_ = 0, refBytes_ = 0, diffIn_ = 0, diffOut_ = 0, shots_ = 0;
    std::vector<uint32_t> spans_;
    friend LONG CALLBACK vehHandler(PEXCEPTION_POINTERS);
};

extern Recorder g;
extern thread_local int t_inRec;   // >0 while this thread is inside Recorder::rec (crash handler must not touch cur_)

// format helpers shared by the wrappers
struct FmtInfo { uint32_t bpp; uint32_t block; bool known; };   // block > 0: bytes per 4x4 block
FmtInfo fmtInfo(DWORD fmt);
uint32_t primVertexCount(DWORD pt, UINT prims);

} // namespace d3drec
