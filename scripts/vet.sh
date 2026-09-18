#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
VET_BIN=${VET_BIN:-/opt/homebrew/bin/vet}
if [ ! -x "$VET_BIN" ]; then
  VET_BIN=$(command -v vet) || { echo 'Install SafeDep vet or set VET_BIN.' >&2; exit 1; }
fi
mkdir -p reports
"$VET_BIN" scan --silent --lockfiles package-lock.json --transitive \
  --report-json reports/vet.json --report-markdown reports/vet.md "$@"
ZOXIDE_BIN=${JOXIDE_ZOXIDE:-zoxide}
if command -v "$ZOXIDE_BIN" >/dev/null 2>&1; then
  ZOXIDE_VERSION=$("$ZOXIDE_BIN" --version)
  ZOXIDE_VERSION=${ZOXIDE_VERSION#zoxide }
  "$VET_BIN" scan --silent --purl "pkg:cargo/zoxide@$ZOXIDE_VERSION" \
    --report-json reports/vet-zoxide.json --report-markdown reports/vet-zoxide.md "$@"
else
  echo 'zoxide is not installed; skipped its package metadata scan.' >&2
fi
