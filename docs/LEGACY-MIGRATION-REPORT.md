# NEXORA — Legacy Migration Report

**Date:** 2026-11-01
**Source:** `E:\NEXORA-ANEX-REBUILT\logs`
**Destination:** `C:\Users\Administrator\NEXORA-ANEX-REBUILT\logs\legacy`
**Method:** one-shot PowerShell copy → SHA-256 verify → remove source only on full match
**Result:** **10/10 files verified, 0 mismatches, source removed after verification**

---

## 1. Context

The canonical workspace is `C:\Users\Administrator\NEXORA-ANEX-REBUILT`. The old workspace `E:\NEXORA-ANEX-REBUILT` contained only a `logs/` directory with 10 probe log files from two runs:

- `inspect-20261031233746.*` (5 files)
- `recheck-1031-20261031233330.*` (5 files)

No `docs/`, source code, build artifacts, or databases existed on the old path.

## 2. Procedure

1. Enumerated the source directory; count = 10.
2. For each file: computed source SHA-256, copied to destination preserving filename, computed destination SHA-256, compared hash and byte length.
3. Because all 10 matched, removed the source files.
4. Wrote a raw completion log: `logs/legacy-migration-20261101-000352.txt`.
5. Independently re-listed the destination and recomputed all hashes.

No sleeps, polling loops, or repeated probes were used. No elevation, identity change, or security bypass was attempted.

## 3. Verified file manifest

| File | Bytes | SHA-256 |
|---|---:|---|
| `inspect-20261031233746.cmd.txt` | 629 | `015E5EF8E15400E357D46E44D9BA68DA7ADFFBA4215716EDED5F624F0BDC9023` |
| `inspect-20261031233746.err.log` | 509 | `15237F19631CFAEEDD4C81F03F7E2F84F1249A4E91F9FDB5F127B0DC50DC6DE2` |
| `inspect-20261031233746.out.log` | 719 | `1518A5E2279DF303E1AC0BA6B6030DCA6FF56F412489114C59C01E26D65B03E2` |
| `inspect-20261031233746.pid.txt` | 10 | `3FD9478E74045C625327313134931C753F13D7F9AC99CD6B07D1B2E6F9E730CE` |
| `inspect-20261031233746.status.txt` | 56 | `0E21C0355B6BA8442E83667DBF5DD16FAA102A48B4D5E75C29D712F815C64D83` |
| `recheck-1031-20261031233330.cmd.txt` | 501 | `1EA6B4564AC4A00757B66FD613D49D7F6F2A1FBBFB5B48FB50926F7F432E2875` |
| `recheck-1031-20261031233330.err.log` | 513 | `616CB13F17D131AE8472E55C4BBC23B6FCF5C661777542B4BAEAAAB1225DA477` |
| `recheck-1031-20261031233330.out.log` | 1305 | `E9F44F7CB38D82C0DEA687B9310E30B74EE2CB037F76CA1B297AEC704548AC03` |
| `recheck-1031-20261031233330.pid.txt` | 9 | `F71FD3426F624DDAB48FF81D97DBF27109850CEB8E7DEB4223720DB034FD01E1` |
| `recheck-1031-20261031233330.status.txt` | 55 | `08C4B134350492BF8F003CB876FA0BCF49A0EC2A89B8564F649DCB25CEE168FA` |

All destination hashes matched the source hashes exactly; byte lengths matched as shown.

## 4. Post-move verification

- Destination file count: **10**.
- Source remaining files: **0** (old `logs\` directory empty).
- Recomputed destination hashes: identical to the manifest above.

## 5. What the legacy logs contain

The files are environment probe outputs, not application data. They record:

- Identity `NT AUTHORITY\SYSTEM` and non-interactive session.
- WSL error `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`.
- Missing `go`, `git`, `docker`, `ignite`, `qemu-system-x86_64`.
- Presence of `wsl.exe`, `7z.exe`, and `tar.exe` (not a Linux build toolchain).
- Old path `E:\NEXORA-ANEX-REBUILT` existing with only `logs/`.

They contain no credentials or secrets.

## 6. Rollback / preservation note

The source files were removed only after verification. The destination is authoritative and complete. If restoration to `E:` were ever required, copy from `logs/legacy/` using the hashes above as the integrity reference. No source artifact was deleted before verification, per project rule.
