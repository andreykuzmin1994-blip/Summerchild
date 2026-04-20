#!/usr/bin/env bash
# PreToolUse hook: reminds the editor to review docs/SECURITY_REGULATIONS.md
# before modifying security-relevant files, per CLAUDE.md "Compliance Source
# of Truth". Allows the edit only if SECURITY_REGULATIONS.md has already been
# read in the current session (tracked by compliance-mark-read.sh).

set -u

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

if [ -z "$file_path" ]; then
  exit 0
fi

# Security-relevant paths — keep in sync with docs/SECURITY_REGULATIONS.md §2
# Evidence column. Update both when new controls land.
case "$file_path" in
  */src/middleware/auth*|\
  */src/middleware/csrf*|\
  */src/middleware/injectionGuard*|\
  */src/middleware/outputGuardrails*|\
  */src/middleware/outputSanitizer*|\
  */src/middleware/ipAllowlist*|\
  */src/middleware/kioskAuth*|\
  */src/middleware/rateLimit*|\
  */src/lib/fieldCrypto*|\
  */src/lib/cookies*|\
  */src/services/auditLogger*|\
  */src/services/sessionStore*|\
  */src/services/piiStripper*|\
  */src/services/PIIStripper*|\
  */src/routes/caseworker*|\
  */src/routes/admin*|\
  */src/app.js|\
  */prisma/schema.prisma|\
  */.env.example)
    ;;
  *)
    exit 0
    ;;
esac

marker_dir="${TMPDIR:-/tmp}/claude-compliance"
marker="$marker_dir/${session_id:-unknown}"

if [ -n "$session_id" ] && [ -f "$marker" ]; then
  exit 0
fi

reason="This file is listed in docs/SECURITY_REGULATIONS.md §2 Evidence column. Per CLAUDE.md \"Compliance Source of Truth\", before editing: (1) read docs/SECURITY_REGULATIONS.md, (2) confirm the change does not regress an OK control, (3) if posture changes, update the Status/Evidence row in the same commit, (4) if a §3 backlog item is delivered, move it out and flip the §2 row to OK. After reading the doc in this session, retry the edit."

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
