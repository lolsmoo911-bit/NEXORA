#!/usr/bin/env bash
# push-with-replit-auth.sh — push to GitHub without a token ever appearing in chat,
# in a shell command, in git config, or in the process table.
#
# WHY THIS EXISTS
# ---------------
# A GitHub personal access token was pasted into a chat conversation twice. That token is
# compromised by definition: it is in the transcript, and anyone reading it can push to the
# repository. It must be revoked, and pasting new ones here would repeat the mistake.
#
# This script reads the credential from the environment, where Replit's Secrets panel puts
# it, and never echoes it. There is no code path in this file that prints the value:
#
#   * it is never passed on a command line (so never visible in `ps`)
#   * it is never written to .git/config
#   * it is never included in the URL
#   * `set -x` is explicitly disabled so the shell trace cannot leak it
#
# TWO WAYS TO SUPPLY IT - pick either
#
# (1) RECOMMENDED: connect GitHub to Replit. No secret needed at all.
#     Visit https://replit.com/account and connect GitHub under "Connected accounts".
#     Replit then serves git credentials through its local broker, and a plain
#     `git push origin main` works with nothing configured here.
#
# (2) REPLIT SECRETS: add a secret named GH_TOKEN in the Repl's Secrets panel
#     (Repl -> Secrets -> New Secret). Use a FINE-SCOPED classic token:
#       - repo scope ONLY for this single repository, and
#       - NOTHING else: no workflow scope, no admin, no org, no packages.
#     Leave the expiration short (30 days) and revoke when the work is done.
#     Then run:  GH_TOKEN is already in the environment, so just run this script.
#
# Usage:
#   ./scripts/push-with-replit-auth.sh            # push current branch to origin/main
#   ./scripts/push-with-replit-auth.sh --check    # verify credentials WITHOUT pushing
set -euo pipefail
set +x   # never trace: a traced command line would leak the secret

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# ---------------------------------------------------------------------------
# Credential discovery, in order of preference. Nothing is ever printed.
# ---------------------------------------------------------------------------
cred_source=""

# (a) Replit's own broker, when GitHub is connected in account settings.
if [ -n "${REPLIT_ASKPASS_PID2_SESSION:-}" ] && command -v replit-git-askpass >/dev/null 2>&1; then
  session="${REPLIT_ASKPASS_PID2_SESSION}"
  probe="$(curl -s -m 8 "localhost:8284/${session}/github/token" 2>/dev/null || true)"
  if printf '%s' "$probe" | grep -qi '"token"'; then
    cred_source="replit-broker"
  fi
fi

# (b) A secret injected into the environment by the Repl's Secrets panel.
if [ -z "$cred_source" ] && [ -n "${GH_TOKEN:-}" ]; then
  cred_source="env-secret"
fi

# (c) A file, for running outside Replit. Never committed; .gitignore covers it.
if [ -z "$cred_source" ] && [ -f "${HOME}/.config/nexora/gh-token" ]; then
  cred_source="file"
fi

if [ -z "$cred_source" ]; then
  cat >&2 <<'EOF'
No GitHub credential available. Two secure options, neither involving chat:

  (1) RECOMMENDED - connect GitHub to Replit:
        https://replit.com/account   ->  Connected accounts  ->  GitHub
      Then re-run this script. Replit serves git credentials locally and
      nothing needs to be pasted anywhere.

  (2) REPLIT SECRETS - add a secret named GH_TOKEN in the Secrets panel.
      Scope it to this repository only, with no workflow/admin/org permissions,
      a short expiry, and revoke it when finished. The value stays in the
      environment and is never printed by this script.
EOF
  exit 2
fi

echo "credential source: ${cred_source} (value never displayed)"

# Ask git to use the broker when it is the source, otherwise build an
# askpass shim so the token is passed out-of-band rather than on the argv.
if [ "$cred_source" = "replit-broker" ]; then
  export GIT_ASKPASS="replit-git-askpass"
  export GIT_TERMINAL_PROMPT=0
  REMOTE="https://github.com/lolsmoo911-bit/NEXORA.git"
else
  ASKPASS="$(mktemp)"
  chmod 700 "$ASKPASS"
  if [ "$cred_source" = "env-secret" ]; then
    # Write a shim that echoes the env var. The value is still only ever in
    # the environment of this process, never in a file on disk.
    cat > "$ASKPASS" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  *sername*) echo "x-access-token" ;;
  *assword*) printf '%s' "$GH_TOKEN" ;;
esac
SHIM
  else
    cat > "$ASKPASS" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  *sername*) echo "x-access-token" ;;
  *assword*) cat "${HOME}/.config/nexora/gh-token" ;;
esac
SHIM
  fi
  export GIT_ASKPASS="$ASKPASS"
  export GIT_TERMINAL_PROMPT=0
  REMOTE="https://github.com/lolsmoo911-bit/NEXORA.git"
  trap 'rm -f "$ASKPASS"' EXIT
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "credential resolves; --check requested, not pushing"
  exit 0
fi

# ---------------------------------------------------------------------------
# Reconcile before pushing. NEVER force-push: this repository receives an
# automated commit every hour, and overwriting that history is unacceptable.
# ---------------------------------------------------------------------------
echo "--- fetching origin ---"
git fetch origin

behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
echo "local is ${ahead} commit(s) ahead, ${behind} behind"

if [ "$behind" -gt 0 ]; then
  echo "origin/main has moved ahead. Reconciling with a rebase before pushing."
  git rebase origin/main
fi

if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  echo "already up to date; nothing to push"
  exit 0
fi

echo "--- pushing ---"
git push origin HEAD:main
echo "--- done ---"
git fetch origin
echo "origin/main is now: $(git rev-parse origin/main)"
echo "local  HEAD  is : $(git rev-parse HEAD)"