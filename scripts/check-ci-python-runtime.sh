#!/usr/bin/env bash
# Run from the repository root, using the same interpreter and import paths as the runner.
set -euo pipefail
runtime=${DC_PYRUNTIME:-"$PWD/third_party/pyruntime"}
if ! PYTHONPATH="$PWD/third_party/pylib:$PWD/backend/runner" \
  "$runtime/bin/python3" -c 'import numpy, sys; print("CI runtime:", sys.executable, "NumPy", numpy.__version__)'; then
  printf 'Required Python runtime is unusable: %s/bin/python3 (including NumPy import)\n' "$runtime" >&2
  exit 1
fi
