/*
 * vanity.c — CREATE2 vanity address miner for NEXORA.
 *
 * WHY CREATE2 AND NOT "DEPLOY AND DISCARD"
 * ---------------------------------------
 * The naive way to get a chosen contract address on EVM is to bump a nonce, deploy,
 * check the resulting address, and throw the contract away if it does not match. That
 * burns one transaction per attempt. For a four-byte suffix that is millions of
 * transactions and it is absurd.
 *
 * CREATE2 removes the waste entirely:
 *
 *     address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
 *
 * The salt is an arbitrary 32-byte value WE choose, and it is mixed in BEFORE the
 * hash. So we can search for a salt off-chain, in a tight loop, and then send exactly
 * one deployment that lands on the address we already know. Nothing is deployed until
 * the search succeeds.
 *
 * The cost is therefore pure CPU time and nothing else.
 *
 * INPUT FORMAT (argv)
 *   argv[1] = 0x-prefixed deployer address   (20 bytes)
 *   argv[2] = 0x-prefixed initcode hash     (32 bytes, keccak256 of the creation code)
 *   argv[3] = target suffix, lowercase hex, no 0x, EVEN length (1..16 bytes)
 *   argv[4] = start counter (hex or decimal, optional, default 0)
 *
 * OUTPUT
 *   On success:  "FOUND <32-byte salt hex> <counter>"
 *
 * Build:  gcc -O3 -fopenmp -o vanity vanity.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#ifdef _OPENMP
#include <omp.h>
#endif

/* ------------------------------------------------------------------ keccak-f[1600] */

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

static const int RHO[24] = { 1,  3,  6,  10, 15, 21, 28, 36, 45, 55, 2,  14,
                             27, 41, 56, 8,  25, 43, 62, 18, 39, 61, 20, 44 };
static const int PI[24] = { 10, 7,  11, 17, 18, 3, 5,  16, 8,  21, 24, 4,
                            15, 23, 19, 13, 12, 2,  20, 14, 22, 9,  6,  1 };

static inline uint64_t rotl64(uint64_t x, int n) { return (x << n) | (x >> (64 - n)); }

/* In-place Keccak-f[1600] permutation on a 5x5 lane array. */
static inline void keccakf(uint64_t A[25])
{
    int round, i, j;
    uint64_t C[5], B[5], t;

    for (round = 0; round < 24; round++) {
        /* theta */
        for (i = 0; i < 5; i++)
            C[i] = A[i] ^ A[i + 5] ^ A[i + 10] ^ A[i + 15] ^ A[i + 20];
        for (i = 0; i < 5; i++) {
            t = C[(i + 4) % 5] ^ rotl64(C[(i + 1) % 5], 1);
            for (j = 0; j < 25; j += 5) A[j + i] ^= t;
        }

        /* rho + pi
         *
         * This is a SEQUENTIAL swap chain, and it has to be. The RHO/PI tables below are
         * the standard pair that accompanies this exact chain. Writing the same step as the
         * seemingly equivalent parallel form `B[PI[i]] = rotl(A[i], RHO[i])` is WRONG: the
         * rotation values are indexed for the chain's traversal order, not for a direct
         * lane lookup. Doing that produced a permutation that ran cleanly and hashed
         * garbage - every output differed from the reference implementation. */
        t = A[1];
        for (i = 0; i < 24; i++) {
            j = PI[i];
            B[0] = A[j];
            A[j] = rotl64(t, RHO[i]);
            t = B[0];
        }

        /* chi */
        for (j = 0; j < 25; j += 5) {
            for (i = 0; i < 5; i++) B[i] = A[j + i];
            for (i = 0; i < 5; i++) A[j + i] ^= (~B[(i + 1) % 5]) & B[(i + 2) % 5];
        }

        /* iota */
        A[0] ^= RC[round];
    }
}

/*
 * keccak256 over a message shorter than the 136-byte rate.
 *
 * Every vanity attempt hashes exactly 85 bytes (0xff + 20 + 32 + 32), which is below
 * the 136-byte rate, so the whole search runs ONE permutation per attempt with no
 * buffering loop. That is the single biggest reason this is fast enough to be useful.
 *
 * NOTE: this is Keccak-256, not SHA3-256. They differ only in the domain padding byte
 * (0x01 vs 0x06). EVM uses Keccak, so this must be 0x01.
 */
static void keccak256_short(const uint8_t *msg, size_t len, uint8_t out[32])
{
    uint64_t A[25];
    uint8_t block[136];
    size_t i;

    memset(A, 0, sizeof(A));
    memset(block, 0, sizeof(block));
    memcpy(block, msg, len);
    block[len] = 0x01;                 /* keccak domain padding */
    block[135] |= 0x80;                /* final bit of the rate block */

    for (i = 0; i < 17; i++) {
        uint64_t lane;
        memcpy(&lane, block + i * 8, 8);
        A[i] = lane;                   /* little-endian load on x86-64 */
    }

    keccakf(A);

    for (i = 0; i < 4; i++)
        memcpy(out + i * 8, &A[i], 8); /* 32 bytes of output = first 4 lanes */
}

/* ------------------------------------------------------------------ hex helpers */

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Decode hex into out; returns byte count, or -1 on malformed input. */
static int unhex(const char *s, uint8_t *out, size_t max)
{
    size_t n = 0;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
    size_t slen = strlen(s);
    if (slen % 2 != 0) return -1;
    if (slen / 2 > max) return -1;
    for (size_t i = 0; i < slen; i += 2) {
        int hi = hexval(s[i]), lo = hexval(s[i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[n++] = (uint8_t)((hi << 4) | lo);
    }
    return (int)n;
}

/* ------------------------------------------------------------------ main */

/*
 * BENCHMARK MODE
 * --------------
 * `--bench <attempts>` hashes a fixed number of preimages and prints the MEASURED rate in
 * millions of hashes per second, then exits.
 *
 * This exists because the documentation previously quoted "8.4M/sec" as if it were a
 * property of the code, and then quoted a search time for a 6-byte suffix that was wrong by
 * more than two orders of magnitude. The rate was never measured; it was guessed. A number
 * nobody measured eventually gets used as if it were.
 *
 * Re-run this before relying on any figure in the docs:
 *     ./vanity --bench 20000000
 */
static int bench_mode(uint64_t attempts)
{
    uint8_t buf[85];
    uint8_t out[32];
    volatile uint64_t sink = 0;
    struct timespec t0, t1;
    double secs, rate;

    /* Both clocks are read HERE. An earlier version read t0 in main() and t1 in this
     * function, so t0 was whatever the stack happened to hold and the printed elapsed time
     * was meaningless - it reported 2593 seconds for a 20M-hash run that takes about two. */
    clock_gettime(CLOCK_MONOTONIC, &t0);

    memset(buf, 0, sizeof(buf));
    buf[0] = 0xff; /* 0xff, mirroring a CREATE2 preimage */

#ifdef _OPENMP
    #pragma omp parallel for schedule(static) reduction(^:sink) shared(buf, out)
#endif
    for (long long t = 0; t < (long long)attempts; t++) {
        /* Vary bytes inside the salt window so the compiler cannot hoist the hash out. */
        buf[21 + 6] = (uint8_t)(t >> 8);
        buf[21 + 7] = (uint8_t)t;
        keccak256_short(buf, 85, out);
        sink ^= out[0];
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);
    secs = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    rate = secs > 0 ? (double)attempts / secs / 1e6 : 0.0;

#ifdef _OPENMP
    fprintf(stderr, "threads   %d\n", omp_get_max_threads());
#endif
    fprintf(stderr, "attempts  %llu\n", (unsigned long long)attempts);
    fprintf(stderr, "elapsed   %.4f s\n", secs);
    printf("%.3f\n", rate);
    sink; /* keep the XOR observable so nothing is optimised away */
    return 0;
}

int main(int argc, char **argv)
{
    /* benchmark mode short-circuits everything else */
    if (argc == 3 && strcmp(argv[1], "--bench") == 0) {
        return bench_mode(strtoull(argv[2], NULL, 0));
    }

    if (argc < 4) {
        fprintf(stderr,
                "usage: %s <deployer> <initcodehash> <hexsuffix> [start]\n"
                "       %s --bench <attempts>   measure hash rate, print M/s\n"
                "  deployer     0x + 40 hex chars\n"
                "  initcodehash 0x + 64 hex chars\n"
                "  hexsuffix    even number of hex chars, 2..16 (1..8 bytes)\n",
                argv[0]);
        return 2;
    }

    uint8_t deployer[20], ichash[32], suffix[8];
    int dlen = unhex(argv[1], deployer, 20);
    int ilen = unhex(argv[2], ichash, 32);
    int slen = unhex(argv[3], suffix, 8);

    if (dlen != 20) { fprintf(stderr, "bad deployer address\n"); return 2; }
    if (ilen != 32) { fprintf(stderr, "bad initcode hash\n"); return 2; }
    if (slen < 1 || slen > 8) { fprintf(stderr, "suffix must be 1..8 bytes\n"); return 2; }

    uint64_t start = 0;
    if (argc > 4) start = strtoull(argv[4], NULL, 0);

    /* Preimage layout for every attempt, exactly 85 bytes:
     *
     *     [0]      0xff              1 byte
     *     [1..21)  deployer        20 bytes
     *     [21..53) salt            32 bytes   <- the only part that changes
     *     [53..85) initCodeHash    32 bytes
     *
     * The offsets must sum to 85. An earlier version packed the initcode hash directly
     * after the deployer and then wrote the salt over it, leaving a 53-byte array while
     * hashing 85. It read 32 bytes past the end of its own buffer on every single
     * attempt, produced plausible-looking addresses, and failed the cross-check against
     * Foundry. The vector test did not catch it because keccak256 itself was correct. */
    uint8_t preimage[85];
    preimage[0] = 0xff;
    memcpy(preimage + 1, deployer, 20);
    memcpy(preimage + 53, ichash, 32);

    /* Target as an integer, big-endian in `suffix`. Compared against the last
     * `slen` bytes of the 20-byte address. */
    const uint64_t trials_per_match = 1ULL << (8 * slen);
    fprintf(stderr, "mining for %d-byte suffix, ~%.4g trials expected\n",
            slen, (double)trials_per_match);

    uint8_t salt[32];
    uint8_t addr[32];
    volatile int done = 0;
    volatile uint64_t found = 0;

    /*
     * Parallel search. Each thread owns a strided band of counters so no two threads
     * ever test the same salt. The first thread to match publishes its counter and
     * sets done; the others stop at their next band boundary.
     */
/*
     * OpenMP forbids `break` inside a parallel for, so the thread loop runs to its band
     * limit and exits early only via the `done` flag checked at the top of each pass.
     */
#ifdef _OPENMP
    #pragma omp parallel for schedule(static, 1) shared(found, done)
#endif
    for (long t = 0; t < (long)(1 << 20); t++) {
        if (done) continue;

        uint64_t base = start + (uint64_t)t * (1ULL << 24);

        for (uint64_t k = 0; k < (1ULL << 24); k++) {
            if (done) break;
            uint64_t ctr = base + k;

            /* salt = big-endian counter in the low 8 bytes, rest zero */
            memset(salt, 0, 32);
            for (int i = 0; i < 8; i++)
                salt[24 + i] = (uint8_t)(ctr >> (56 - 8 * i));

            /* write only the salt window; deployer and initcode hash never move */
            memcpy(preimage + 21, salt, 32);
            keccak256_short(preimage, 85, addr);

            /* address is the LAST 20 bytes of the digest */
            const uint8_t *a = addr + 12;
            int match = 1;
            for (int i = 0; i < slen; i++)
                if (a[20 - slen + i] != suffix[i]) { match = 0; break; }

            if (match) {
                found = ctr;
                done = 1;
                break;
            }
        }
    }

    if (!done) {
        fprintf(stderr, "search space exhausted without a match\n");
        return 1;
    }

    /* Recompute the winning address from the salt we are about to print, rather than
     * reusing whatever was in `addr` when the match was found. The printed salt and the
     * printed address must be provably consistent with each other. */
    memset(salt, 0, 32);
    for (int i = 0; i < 8; i++)
        salt[24 + i] = (uint8_t)(found >> (56 - 8 * i));
    memcpy(preimage + 21, salt, 32);
    keccak256_short(preimage, 85, addr);

    printf("FOUND ");
    for (int i = 0; i < 32; i++) printf("%02x", salt[i]);
    printf(" 0x");
    for (int i = 12; i < 32; i++) printf("%02x", addr[i]);
    printf("\n");
    return 0;
}