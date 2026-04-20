#!/usr/bin/env bash
# PostToolUse hook on Read: records that docs/SECURITY_REGULATIONS.md has
# been read in the current session, so compliance-check.sh can allow
# subsequent edits to security-relevant files.

set -u

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

if [ -z "$session_id" ] || [ -z "$file_path" ]; then
  exit 0
fi

case "$file_path" in
  */docs/SECURITY_REGULATIONS.md)
    marker_dir="${TMPDIR:-/tmp}/claude-compliance"
    mkdir -p "$marker_dir"
    touch "$marker_dir/$session_id"
    ;;
esac
exit 0
