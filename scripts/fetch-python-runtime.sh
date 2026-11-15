#!/usr/bin/env bash
#
# scripts/fetch-python-runtime.sh
#
# Provision a self-contained Python 3.13 + numpy runtime under third_party/, so the
# project runs offline and without pip.
#
# Layout produced (all of third_party/ is git-ignored):
#
#   third_party/.cache/                 verified download cache
#   third_party/pyruntime/bin/python3   CPython 3.13.18 (python-build-standalone)
#   third_party/pylib/numpy/            numpy 2.5.4, imported through PYTHONPATH
#   third_party/pyruntime/.version      idempotency marker
#
# Every download is pinned by URL + SHA256 below. A mismatch deletes the file and
# aborts; verification is never skipped, cached or fresh.
#
# Usage:
#   scripts/fetch-python-runtime.sh              # no-op once provisioned
#   FORCE=1 scripts/fetch-python-runtime.sh      # re-download and re-extract
#
set -euo pipefail

# ── Pinned sources: URL and SHA256 are part of the contract, do not edit ──────
PY_VERSION="3.13.18+20261110"
NUMPY_VERSION="2.5.4"
MARKER_CONTENT="$PY_VERSION numpy-$NUMPY_VERSION"
EXPECTED_SELF_CHECK="3.13.18 2.5.4"

PY_NAME="cpython-3.13.18+20261110-x86_64-unknown-linux-gnu-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.13.18%2B20261110-x86_64-unknown-linux-gnu-install_only.tar.gz"
PY_SHA256="50c774f6674740739f791c05a9177ed03e2fe02abebda9bca3512eb7309b37cc"

NUMPY_NAME="numpy-2.5.4-cp313-cp313-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"
NUMPY_URL="https://files.pythonhosted.org/packages/da/24/3bd070f3269dc609d8f26b2643f62ef91bb415841c0b294805aaf7fe06da/numpy-2.5.4-cp313-cp313-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"
NUMPY_SHA256="6ffa07666f8da0eef81d149934a626d0d95fbd6838432a33e66245423a9062c0"

# ── Paths: the repo root comes from this script's own location, so any cwd works ─
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

THIRD_PARTY="$ROOT/third_party"
CACHE_DIR="$THIRD_PARTY/.cache"
RUNTIME_DIR="$THIRD_PARTY/pyruntime"
PYLIB_DIR="$THIRD_PARTY/pylib"
MARKER="$RUNTIME_DIR/.version"
PY_EXE="$RUNTIME_DIR/bin/python3"

FETCHED_BYTES=0

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

sha256_of() {
  local out
  out="$(sha256sum -- "$1")"
  printf '%s\n' "${out%% *}"
}

not_provisioned() {
  printf 'runtime for %s/%s not yet provisioned\n' "$1" "$2"
  exit 2
}

detect_platform() {
  local kernel machine
  kernel="$(uname -s)"
  machine="$(uname -m)"

  case "$machine" in
    x86_64|amd64)  PLATFORM_ARCH="x86_64" ;;
    arm64|aarch64) PLATFORM_ARCH="aarch64" ;;
    *)             PLATFORM_ARCH="$machine" ;;
  esac

  case "$kernel" in
    Linux)
      # Only this combination is provisioned today.
      [ "$PLATFORM_ARCH" = "x86_64" ] || not_provisioned linux "$PLATFORM_ARCH"
      PLATFORM_OS="linux"
      ;;
    Darwin)
      # Placeholder: a macOS runtime (universal2 or per-arch) has to be pinned
      # here before it can be fetched. Nothing is downloaded until then.
      not_provisioned darwin "$PLATFORM_ARCH"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      # Placeholder: a Windows runtime (embeddable CPython + its DLLs) has to be
      # pinned here before it can be fetched. Nothing is downloaded until then.
      not_provisioned mingw "$PLATFORM_ARCH"
      ;;
    *)
      not_provisioned "$kernel" "$PLATFORM_ARCH"
      ;;
  esac
}

# Download $1 into $2 and require $3, unless $2 is already a verified cache hit.
# The body lands in a temp file and is renamed only after the SHA256 matches, so a
# truncated download can never be mistaken for a cached artifact.
fetch_verified() {
  local url="$1" dest="$2" want="$3" label="$4"
  local have tmp bytes

  if [ -f "$dest" ]; then
    have="$(sha256_of "$dest")"
    if [ "$have" = "$want" ]; then
      log "cache hit    $label (sha256 $have)"
      return 0
    fi
    # A cached file whose digest disagrees with the pin is tampered or corrupt,
    # not merely stale: drop it and abort. Re-downloading here would silently
    # turn a failed verification into a self-heal, so it is never attempted.
    rm -f -- "$dest"
    printf 'sha256 mismatch: %s\n' "$label" >&2
    printf '  expected: %s\n' "$want" >&2
    printf '  actual:   %s\n' "$have" >&2
    printf '  removed:  %s\n' "$dest" >&2
    exit 1
  fi

  tmp="${dest}.part.$$"
  log "downloading  $label"
  if ! curl -fL --retry 3 -o "$tmp" "$url"; then
    rm -f -- "$tmp"
    die "download failed: $url"
  fi

  have="$(sha256_of "$tmp")"
  if [ "$have" != "$want" ]; then
    rm -f -- "$tmp"
    printf 'sha256 mismatch: %s\n' "$label" >&2
    printf '  expected: %s\n' "$want" >&2
    printf '  actual:   %s\n' "$have" >&2
    printf '  removed:  %s\n' "$tmp" >&2
    exit 1
  fi

  mv -f -- "$tmp" "$dest"
  bytes="$(wc -c < "$dest")"
  bytes="${bytes//[[:space:]]/}"
  FETCHED_BYTES=$((FETCHED_BYTES + bytes))
  log "saved        $label ($bytes bytes, sha256 $have)"
}

extract_runtime() {
  local archive="$1"
  log "extracting   pyruntime -> $RUNTIME_DIR"
  rm -rf -- "$RUNTIME_DIR"
  mkdir -p -- "$RUNTIME_DIR"
  tar -xzf "$archive" --strip-components=1 -C "$RUNTIME_DIR"
  [ -x "$PY_EXE" ] || die "extraction incomplete: $PY_EXE is missing"
}

extract_pylib() {
  local wheel="$1"
  log "extracting   pylib -> $PYLIB_DIR"
  rm -rf -- "$PYLIB_DIR"
  mkdir -p -- "$PYLIB_DIR"
  # A wheel is a zip archive; the interpreter itself is what unpacks it, no pip.
  python3 -m zipfile -e "$wheel" "$PYLIB_DIR/"
  [ -f "$PYLIB_DIR/numpy/__init__.py" ] || die "extraction incomplete: $PYLIB_DIR/numpy/__init__.py is missing"
}

main() {
  detect_platform
  log "platform     $PLATFORM_OS/$PLATFORM_ARCH"
  log "repo root    $ROOT"

  # Idempotency: the marker is written only after a fully successful run.
  if [ "${FORCE:-0}" = "1" ]; then
    log "force        re-provisioning $MARKER_CONTENT"
  elif [ -f "$MARKER" ] && [ "$(cat -- "$MARKER")" = "$MARKER_CONTENT" ]; then
    if [ -x "$PY_EXE" ] && [ -f "$PYLIB_DIR/numpy/__init__.py" ]; then
      log "up to date   $MARKER_CONTENT"
      log "nothing to do ($THIRD_PARTY)"
      exit 0
    fi
    log "rebuild      marker is current but the runtime files are missing"
  fi

  for tool in curl sha256sum tar python3; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
  done

  mkdir -p -- "$CACHE_DIR"
  fetch_verified "$PY_URL" "$CACHE_DIR/$PY_NAME" "$PY_SHA256" "$PY_NAME"
  fetch_verified "$NUMPY_URL" "$CACHE_DIR/$NUMPY_NAME" "$NUMPY_SHA256" "$NUMPY_NAME"

  extract_runtime "$CACHE_DIR/$PY_NAME"
  extract_pylib "$CACHE_DIR/$NUMPY_NAME"

  # Offline smoke test: the runtime must import numpy straight from pylib.
  local actual status
  if actual="$(PYTHONPATH="$PYLIB_DIR" "$PY_EXE" -c 'import sys,numpy;print(sys.version.split()[0],numpy.__version__)')"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -ne 0 ]; then
    printf 'self-check failed (exit %d): could not import numpy from %s\n' "$status" "$PYLIB_DIR" >&2
    exit 1
  fi
  if [ "$actual" != "$EXPECTED_SELF_CHECK" ]; then
    printf 'self-check mismatch\n' >&2
    printf '  expected: %s\n' "$EXPECTED_SELF_CHECK" >&2
    printf '  actual:   %s\n' "$actual" >&2
    exit 1
  fi

  printf '%s\n' "$MARKER_CONTENT" > "$MARKER"

  log "ready        $THIRD_PARTY"
  log "  marker:     $MARKER_CONTENT"
  log "  downloaded: $FETCHED_BYTES bytes (this run)"
  log "  self-check: PYTHONPATH=\"$PYLIB_DIR\" \"$PY_EXE\" -c 'import sys,numpy;print(sys.version.split()[0],numpy.__version__)'"
  printf '%s\n' "$actual"
}

main "$@"