#!/usr/bin/env bash
#
# scripts/check-zero-special-case.sh
#
# Zero-special-case gate for the web store.
#
# The decision (docs/decisions/2026-11-15-python-script-card.md, "通用基础设施零 script 特例")
# is that the script card is ONE ordinary function card: the generic infrastructure —
# bindings, dependency graph, workspace migration, card metrics, connection geometry —
# must not know the card's kind. Any `builtin:python` / `isScriptCard` / `kind === 'script'`
# check there is a branch the next card kind will have to copy, which is exactly how a
# "generic" layer turns into a pile of per-kind ifs.
#
# The ONE place allowed to know is the workspace store, and only inside its script-card
# section (the store is the adapter that gives every kind its verbs). The allowed regions are
# lead-adjudicated (2026-11-15) and written down here so a future edit can be judged against
# the rule instead of against memory:
#
#   1. the top import block that pulls symbols from './types.ts';
#   2. a section slice: from a "── script card (" marker line to the next "── " marker line;
#   3. pure comment lines (first non-space character is // or *);
#   4. the implementation body of a script verb / private helper — addScriptCard,
#      setScriptText, renameScriptPort, renameScriptOutput, addScriptOutput,
#      removeScriptOutput, addScriptPort, runScriptCard, debugScriptCard, dismissScriptNotice,
#      and runScriptCardNow / scriptCardStillCurrent / patchScriptRun / applyScriptOutputIds /
#      scriptDeclarationError (body tracked by brace depth from the declaration);
#   5. three line-level micro-whitelists: the loadSnapshot card count
#      (`.filter(isScriptCard).length`) and the two WorkspaceState field declarations.
#
# Everything else in web/src/ui/workspaceStore.ts is generic code, and the five files below
# must be completely free of the four discriminating literals:
#
#   web/src/ui/bindings.ts            web/src/ui/migrate.ts
#   web/src/core/DependencyGraph.ts   web/src/ui/cardMetrics.ts
#   web/src/ui/connectionGeometry.ts
#
# The component-selection layer (CardCanvas / MatrixCard / ScriptCard / App / MenuBar / i18n)
# is out of scope on purpose: choosing the component by kind is the one legal branch.
#
# Output: `file:line:content` for every violation, then a count; exit 1 if there is any.
# A missing scanned file is a violation too — a gate that passes when its subject disappears
# is not a gate.
#
# The scan is exercised against synthetic files before the real tree (--self-test, on by
# default; `--no-self-test` to skip): a grep gate that has never failed cannot be told apart
# from a grep gate that is broken.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

ZERO_FILES=(
  "web/src/ui/bindings.ts"
  "web/src/core/DependencyGraph.ts"
  "web/src/ui/migrate.ts"
  "web/src/ui/cardMetrics.ts"
  "web/src/ui/connectionGeometry.ts"
)
STORE_FILE="web/src/ui/workspaceStore.ts"

# ── the four discriminating literals (lead's ruling; nothing else is grepped) ────────────
LITERALS=(
  "builtin:python"
  "PYTHON_SIGNATURE"
  "isScriptCard"
  "kind === 'script'"
)

# ── the scan programs ────────────────────────────────────────────────────────────────────

# Files that must contain none of the literals: a plain fixed-string grep, one line per hit.
scan_zero_file() {
  local root="$1" rel="$2"
  if [ ! -f "$root/$rel" ]; then
    printf '%s:<missing>:scanned file does not exist\n' "$rel"
    return 0
  fi
  # -H: with a single file argument grep omits the filename, and the report needs it.
  grep -HnF \
    -e "${LITERALS[0]}" -e "${LITERALS[1]}" -e "${LITERALS[2]}" -e "${LITERALS[3]}" \
    -- "$root/$rel" | sed "s|^$root/||" || true
}

# AWK program for the store. Two passes over the same file:
#   pass 1 records the line range of the './types.ts' import block (region 1);
#   pass 2 walks the five allowed regions and reports every other hit.
# The program lives in a temp file (quoted heredoc, so the quotes in `kind === 'script'`
# need no shell escaping).
STORE_AWK="$(mktemp "${TMPDIR:-/tmp}/zero-special-case.XXXXXX.awk")"
STORE_SCAN="$(mktemp "${TMPDIR:-/tmp}/zero-special-case.XXXXXX.out")"
cleanup() { rm -f -- "$STORE_AWK" "$STORE_SCAN"; }
trap cleanup EXIT

cat >"$STORE_AWK" <<'AWK'
function has_hit(s) {
  return index(s, "builtin:python") > 0 || index(s, "PYTHON_SIGNATURE") > 0 ||
         index(s, "isScriptCard") > 0 || index(s, "kind === 'script'") > 0
}

function count_char(s, ch,   n, i) {
  n = 0
  for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == ch) n++
  return n
}

function is_comment(t) { return t ~ /^(\/\/|\*)/ }

# Region 4: does this (leading-space-stripped) line DECLARE one of the allowed names?
function starts_verb(t,   s, n, verb, verbs) {
  n = split("addScriptCard setScriptText renameScriptPort renameScriptOutput addScriptOutput removeScriptOutput addScriptPort runScriptCard debugScriptCard dismissScriptNotice runScriptCardNow scriptCardStillCurrent patchScriptRun applyScriptOutputIds scriptDeclarationError", verbs, " ")
  s = t
  sub(/^(export[ \t]+)?(async[ \t]+)?function[ \t]+/, "", s)
  for (i = 1; i <= n; i++) {
    verb = verbs[i]
    if (index(s, verb "(") == 1) return 1     # function decl or store method shorthand
    if (index(s, verb ":") == 1) return 1     # interface member / object property
  }
  return 0
}

# Region 5: the three line-level micro-whitelists, written as content regexes.
function is_micro_allowed(line) {
  if (line ~ /[.]filter[(]isScriptCard[)][.]length/) return 1   # loadSnapshot card count
  if (line ~ /^[ \t]*scriptNotice[ \t]*:[ \t]*number[ \t]*\|[ \t]*null[ \t]*;/) return 1
  if (line ~ /^[ \t]*scriptRuns[ \t]*:[ \t]*Record<number,[ \t]*ScriptRunState>[ \t]*;/) return 1
  return 0
}

# ── pass 1: the './types.ts' import block ───────────────────────────────────────────────
FNR == NR {
  if ($0 ~ /^[ \t]*import[ \t]+(type[ \t]+)?\{.*from[ \t]+'\.\/types(\.ts)?'/) {
    types[FNR] = 1
    next
  }
  if (pending) {
    if ($0 ~ /from[ \t]+'\.\/types(\.ts)?'/) {
      for (l = start; l <= FNR; l++) types[l] = 1
      pending = 0
      next
    }
    if ($0 ~ /from[ \t]+'/) {
      pending = 0   # a different module: this block is not region 1
      next
    }
    next
  }
  if ($0 ~ /^[ \t]*import[ \t]+(type[ \t]+)?\{[ \t]*$/) {
    pending = 1
    start = FNR
  }
  next
}

# ── pass 2: the scan ────────────────────────────────────────────────────────────────────
{
  line = $0
  t = line
  sub(/^[ \t]+/, "", t)

  # Section slices: a marker line opens or closes a region. Checked before every other rule
  # so the state is current for the line that carries the marker itself.
  if (index(line, "\342\224\200\342\224\200 ") > 0) {
    if (index(line, "\342\224\200\342\224\200 script card (") > 0) in_section = 1
    else in_section = 0
  }

  # Verb bodies: once declared, follow braces until they balance. A declaration without a
  # body (`verb: (...) => T;`) is released by the terminating semicolon.
  if (verb_depth > 0) {
    verb_depth += count_char(line, "{") - count_char(line, "}")
    next
  }
  if (verb_pending) {
    if (index(line, "{") > 0) {
      verb_depth = count_char(line, "{") - count_char(line, "}")
      verb_pending = 0
      next
    }
    if (index(line, ";") > 0) verb_pending = 0
    next
  }
  if (starts_verb(t)) {
    # The brace usually sits on the declaration line (`...): Promise<void> {`); a signature
    # split over several lines leaves verb_pending set until its opening brace arrives.
    if (index(t, "{") > 0) {
      verb_depth = count_char(t, "{") - count_char(t, "}")
      if (verb_depth < 0) verb_depth = 0
    } else {
      verb_pending = 1
    }
    next
  }

  if (!has_hit(line)) next
  if (types[FNR]) next
  if (in_section) next
  if (is_comment(t)) next
  if (is_micro_allowed(line)) next
  printf "%s:%d:%s\n", display, FNR, line
}
AWK

scan_store() {
  local root="$1"
  if [ ! -f "$root/$STORE_FILE" ]; then
    printf '%s:<missing>:scanned file does not exist\n' "$STORE_FILE"
    return 0
  fi
  # Same file twice: pass 1 learns the import range, pass 2 scans. The UTF-8 section rule
  # ("── ") is spelled in octal so awk's byte-wise strings match it without locale help.
  awk -v display="$STORE_FILE" -f "$STORE_AWK" \
    "$root/$STORE_FILE" "$root/$STORE_FILE"
}

# Every violation in one tree, as `file:line:content` lines on stdout.
scan_root() {
  local root="$1" rel
  for rel in "${ZERO_FILES[@]}"; do scan_zero_file "$root" "$rel"; done
  scan_store "$root"
}

# ── the gate's own check: synthetic files with known legal and illegal hits ─────────────

self_test() {
  local tmp produced expected
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/zero-special-case-selftest.XXXXXX")"
  mkdir -p "$tmp/web/src/ui" "$tmp/web/src/core"

  # The five zero-hit files exist and are clean, except for two planted cases: a literal in
  # bindings.ts (the grep branch) and a DELETED file (a gate that passes when its subject
  # disappears is not a gate).
  local rel
  for rel in "${ZERO_FILES[@]}"; do : >"$tmp/$rel"; done
  cat >"$tmp/web/src/ui/bindings.ts" <<'FIXTURE'
export function pickKind(signatureId: string) {
  return signatureId === 'builtin:python';
}
FIXTURE
  rm -f -- "$tmp/web/src/ui/cardMetrics.ts"

  # A store exercising all five allowed regions plus three violations. The line numbers below
  # are the whole point: the expected set pins WHERE the gate may stay silent.
  cat >"$tmp/$STORE_FILE" <<'FIXTURE'
/**
 * prose in a block comment may say builtin:python (region 3)
 */
import {
  PYTHON_SIGNATURE,
  isScriptCard,
} from './types.ts';
import { unrelated } from './other.ts';

function genericHelper() {
  return 'builtin:python';
}

// ── script card (`builtin:python`) ──────────────────────────────────────────────
const legalInSection = 'builtin:python';
// ── next section ────────────────────────────────────────────────────────────────

// a pure line comment may say builtin:python (region 3)
const genericOutside = PYTHON_SIGNATURE;

export function addScriptCard(ids: number[]) {
  const kind = isScriptCard;
  return kind ? ids : [];
}

const scriptCount = restored.filter(isScriptCard).length;

function genericTwo() {
  return kind === 'script';
}
FIXTURE

  # Violations: bindings.ts line 2 (a generic file), the missing cardMetrics.ts, and in the
  # store the body of genericHelper (line 11), the generic const (line 19) and the second
  # generic body (line 29). Everything else in that store — the types import, the
  # script-card section, both comment lines, the addScriptCard body and the
  # `.filter(isScriptCard).length` count — is an allowed region and must stay silent.
  expected="$(printf '%s\n' \
    "web/src/ui/bindings.ts:2" \
    "web/src/ui/cardMetrics.ts:<missing>" \
    "$STORE_FILE:11" \
    "$STORE_FILE:19" \
    "$STORE_FILE:29" | sort)"
  produced="$(scan_root "$tmp" | cut -d: -f1,2 | sort)"

  if [ "$produced" != "$expected" ]; then
    printf 'zero-special-case: SELF-TEST FAILED — the scanner no longer detects the known cases\n'
    printf '  expected:\n%s\n  produced:\n%s\n' "$expected" "$produced"
    rm -rf -- "$tmp"
    return 1
  fi
  rm -rf -- "$tmp"
  printf '  ok   self-test (%s planted violations found, every allowed region ignored)\n' \
    "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')"
}

# ── main ────────────────────────────────────────────────────────────────────────────────

run_selftest=1
for arg in "$@"; do
  case "$arg" in
    --no-self-test) run_selftest=0 ;;
    -h|--help)
      sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if [ "$run_selftest" = "1" ]; then
  self_test || exit 1
fi

scan_root "$ROOT" >"$STORE_SCAN" || true
if [ -s "$STORE_SCAN" ]; then
  printf '%s\n' "zero-special-case: the generic layer must not know the script card kind"
  printf '%s\n' "  (allowed only in $STORE_FILE, its script-card sections; see the header)"
  cat "$STORE_SCAN"
  printf 'zero-special-case: %s violation(s)\n' "$(wc -l <"$STORE_SCAN" | tr -d ' ')"
  exit 1
fi

printf 'zero-special-case: clean (%s generic files + %s outside the allowed regions)\n' \
  "${#ZERO_FILES[@]}" "$STORE_FILE"
exit 0