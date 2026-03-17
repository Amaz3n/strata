#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/supabase/schema.sql"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Schema snapshot not found: $SCHEMA_FILE" >&2
  exit 1
fi

REQUIRED_OBJECTS=()
while IFS= read -r PATTERN; do
  [[ -z "$PATTERN" ]] && continue
  REQUIRED_OBJECTS+=("$PATTERN")
done <<'EOF'
public.bid_packages
public.bid_invites
public.bid_submissions
public.ai_search_sessions
public.search_documents
public.ai_search_action_requests
EOF

MISSING=()
for PATTERN in "${REQUIRED_OBJECTS[@]}"; do
  if ! rg -q --fixed-strings "$PATTERN" "$SCHEMA_FILE"; then
    MISSING+=("$PATTERN")
  fi
done

if (( ${#MISSING[@]} > 0 )); then
  echo "supabase/schema.sql is missing required objects from active migrations:" >&2
  for PATTERN in "${MISSING[@]}"; do
    echo "  - $PATTERN" >&2
  done
  echo >&2
  echo "Regenerate the schema snapshot from the current migration state before merging." >&2
  exit 1
fi

echo "supabase/schema.sql contains required bids + AI search objects."
