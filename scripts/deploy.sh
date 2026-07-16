#!/usr/bin/env bash
# Deploys ONE report as an isolated static Vercel site at an unguessable path.
# Reports never enter git history (results/ and reports/ are gitignored);
# the deploy stages into a temp dir so only the single report + headers ship.
#
#   ./scripts/deploy.sh reports/report-2026-07-31.html
set -euo pipefail

REPORT="${1:?usage: ./scripts/deploy.sh <report.html>}"
[ -f "$REPORT" ] || { echo "✗ not found: $REPORT" >&2; exit 1; }

command -v vercel >/dev/null 2>&1 || { echo "✗ vercel CLI not installed: npm i -g vercel" >&2; exit 1; }

# Unguessable path segment (32 hex chars) — the report's URL identity.
TOKEN=$(openssl rand -hex 16)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$TOKEN"
cp "$REPORT" "$STAGE/$TOKEN/index.html"
cp "$(dirname "$0")/../deploy/vercel.json" "$STAGE/vercel.json"

echo "Deploying $REPORT → /$TOKEN/ (X-Robots-Tag: noindex)"
vercel deploy "$STAGE" --prod --yes

echo
echo "Forward the URL above + /$TOKEN/ — immutability is best-effort until the hosted version."
