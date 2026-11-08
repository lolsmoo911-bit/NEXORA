# NEXORA — Scripts

**Status:** No scripts implemented. This directory is reserved for approved operational tooling.

## Purpose

Scripts here support verification, environment auditing, and repeatable operations. They must be safe by default and must never enable real-money, Mainnet, custody, or secret-exposing behavior.

## Conventions

1. **One-shot, bounded.** No `Start-Sleep`, polling loops, or repeated probes. A script writes a completion report and exits.
2. **Idempotent where possible.** Re-running must not corrupt state.
3. **Evidence-producing.** Each run writes a timestamped log with inputs, outputs, and pass/fail.
4. **No secrets.** Never read, print, or store credentials, keys, or tokens.
5. **No destructive default.** Deletion requires prior hash verification; default is copy-and-verify.
6. **Least privilege.** No elevation, service/registry/policy changes, or security bypass.
7. **Cross-platform clarity.** State the shell and version a script requires.

## Planned scripts (not yet written)

| Script | Purpose | Status |
|---|---|---|
| `verify-hashes.ps1` | Compare source/destination SHA-256 for a file set | Planned |
| `audit-environment.ps1` | Record identity, WSL status, and toolchain availability | Planned |
| `check-secrets.ps1` | Scan workspace for obvious secret patterns | Planned |
| `report-tree.ps1` | Emit a workspace inventory with sizes and hashes | Planned |

## Naming

- `verb-noun.ps1` for PowerShell.
- Timestamped outputs: `logs/<name>-YYYYMMDD-HHMMSS.txt`.
- No spaces in filenames.

## Current environment note

The active process runs as `NT AUTHORITY\SYSTEM`; WSL returns `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`. Scripts must not attempt to change identity, elevate, or install around this restriction. Build-related scripts are blocked until a supported Linux/WSL session exists.
