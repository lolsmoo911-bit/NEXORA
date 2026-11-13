# Contributing to NEXORA

Thanks for your interest in contributing.

## Principles

- **Correctness first:** prefer clear, verifiable changes over speed.
- **Reproducibility:** document commands, environments, and expected outcomes.
- **Safety:** do not introduce secrets, private keys, or production/mainnet assumptions.
- **Honesty in status:** do not label unverified work as audited, secure, production-ready, or live.

## Development Workflow

1. Create a focused branch for your change.
2. Keep changes scoped and consistent with existing project structure.
3. Run relevant tests and checks before submitting:
   - `pnpm run typecheck`
   - `pnpm run build`
   - Relevant `node --test ...` and/or `forge test` suites
4. Update documentation when behavior, interfaces, or status changes.

## Pull Requests

Please include:

- A clear summary of what changed and why
- Test/verification evidence (commands and results)
- Known limitations or follow-up work
- Any security-relevant considerations

## Reporting Issues

When reporting bugs, include:

- Environment details
- Steps to reproduce
- Expected vs actual behavior
- Logs or minimal repro cases (without secrets)
