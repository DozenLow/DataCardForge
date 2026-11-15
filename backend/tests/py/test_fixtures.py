#!/usr/bin/env python3
"""Golden fixtures, LAYER 1/3 (runner): the vendored interpreter alone must reproduce them.

The same five cases under ``backend/tests/py/fixtures/`` are replayed by three layers, and
each layer judges the part only it can see:

  1. RUNNER (this file, ctest ``py_fixtures``): ``runner.py --in <case> --out <tmp>`` is run
     with no server in the way, and every output file is compared with ``expected/`` **byte
     for byte**. This is the layer where the fixture bytes are the oracle: the frames were
     frozen from this serialisation (``json.dumps`` puts a space after each comma).
  2. NODE (``backend/tests/xlayer_fixture_node_test.cpp``): the same cases through the real
     HttpServer — upload the input frame, create a ``builtin:python`` card, compute, read the
     result frame back. Header fields and the data segment are compared byte for byte, the
     names payload semantically (see that file's header for the lead's byte exemption).
  3. CLIENT (``web/tests/xlayerGoldenFrames.test.ts``): the golden frames decoded by the
     front end's own frame decoder.

Exit codes: 0 = every case byte-identical, 1 = at least one difference (the first differing
byte offset is printed). The file is a plain assert-style runner like ``test_runner.py``: no
pytest, no unittest, no third-party test framework.

Run with the vendored interpreter (the acceptance command, and what ctest runs)::

    PYTHONPATH=third_party/pylib:backend/runner \\
        third_party/pyruntime/bin/python3 backend/tests/py/test_fixtures.py

``--update`` is deliberately NOT implemented: fixtures/ is read-only for this task, a changed
expectation needs the lead to redo the independent oracle (fixtures/README.md).
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))  # backend/tests/py -> repo root
FIXTURES = os.path.join(HERE, "fixtures")
RUNNER_DIR = os.path.join(PROJECT, "backend", "runner")
RUNNER = os.path.join(RUNNER_DIR, "runner.py")
PYLIB_DIR = os.path.join(PROJECT, "third_party", "pylib")

CASE_RE = re.compile(r"^\d\d-")


def cases():
    """The fixture case directories, in the order their numeric prefix declares."""
    if not os.path.isdir(FIXTURES):
        raise SystemExit(f"missing fixture directory: {FIXTURES}")
    names = sorted(n for n in os.listdir(FIXTURES) if CASE_RE.match(n))
    if not names:
        raise SystemExit(f"no fixture cases in {FIXTURES}")
    for name in names:
        if not os.path.isdir(os.path.join(FIXTURES, name)):
            raise SystemExit(f"{name} is not a directory")
    return names


def first_difference(got, want):
    """Offset of the first differing byte, or -1 when the two buffers are identical."""
    for index in range(min(len(got), len(want))):
        if got[index] != want[index]:
            return index
    if len(got) != len(want):
        return min(len(got), len(want))
    return -1


def describe_byte(data, offset):
    """`offset 12: got 0x1b want 0x19` — the byte itself, which a length-only diff hides."""
    if offset >= len(data):
        return "end of file"
    return f"0x{data[offset]:02x}"


def report_difference(where, got, want):
    offset = first_difference(got, want)
    if offset < 0:
        return False
    print(
        f"MISMATCH {where}: first differing byte at offset {offset} "
        f"(got {describe_byte(got, offset)} want {describe_byte(want, offset)}; "
        f"lengths got {len(got)} want {len(want)})"
    )
    # A short window on both sides makes a shifted payload visible without dumping the file.
    lo = max(0, offset - 8)
    print(f"  got  [{lo}:{offset + 8}] {got[lo:offset + 8].hex(' ')}")
    print(f"  want [{lo}:{offset + 8}] {want[lo:offset + 8].hex(' ')}")
    return True


def run_case(name):
    """Run runner.py over one case directory; return the list of failure lines."""
    case_dir = os.path.join(FIXTURES, name)
    meta_path = os.path.join(case_dir, "meta.json")
    expected_dir = os.path.join(case_dir, "expected")
    if not os.path.isfile(meta_path):
        return [f"{name}: no meta.json"]
    if not os.path.isdir(expected_dir):
        return [f"{name}: no expected/"]

    work = tempfile.mkdtemp(prefix=f"fixtures-{name}-")
    try:
        out_path = os.path.join(work, "out.dcm2")
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([PYLIB_DIR, RUNNER_DIR])
        proc = subprocess.run(
            [sys.executable, RUNNER, "--in", case_dir, "--out", out_path, "--meta", meta_path],
            cwd=PROJECT,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0:
            return [
                f"{name}: runner.py exited {proc.returncode}",
                f"  stderr: {proc.stderr.strip()[:4000]}",
            ]

        expected = sorted(os.listdir(expected_dir))
        produced = sorted(os.listdir(work))
        failures = []
        for filename in expected:
            # The runner derives every output path from --out, so `expected/out.1.dcm2`
            # is the same relative name in the scratch directory.
            produced_path = os.path.join(work, filename)
            if not os.path.isfile(produced_path):
                failures.append(f"{name}: runner wrote no {filename}")
                continue
            with open(os.path.join(expected_dir, filename), "rb") as fh:
                want = fh.read()
            with open(produced_path, "rb") as fh:
                got = fh.read()
            if report_difference(f"{name}/{filename}", got, want):
                failures.append(f"{name}: {filename} differs from expected/")
        for filename in produced:
            if filename not in expected:
                # An extra file is a mismatch too: the manifest promises exactly these
                # frames, and a stray frame means the output set moved.
                failures.append(f"{name}: runner wrote unexpected {filename}")
        return failures
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv):
    if any(arg in ("-h", "--help") for arg in argv[1:]):
        print(__doc__.strip())
        return 0
    if argv[1:]:
        raise SystemExit(f"unknown argument: {argv[1]} (no options; fixtures/ is read-only)")

    if not os.path.isfile(RUNNER):
        raise SystemExit(f"missing runner: {RUNNER}")
    if not os.path.isdir(PYLIB_DIR):
        raise SystemExit("python runtime not provisioned: run bash scripts/fetch-python-runtime.sh")

    names = cases()
    failures = []
    failed_cases = 0
    for name in names:
        try:
            case_failures = run_case(name)
        except Exception:  # noqa: BLE001 — one broken case must not hide the others
            case_failures = [f"{name}: EXCEPTION\n{traceback.format_exc()}"]
        failures.extend(case_failures)
        if case_failures:
            failed_cases += 1
        print(f"{name}: {'FAILED' if case_failures else 'ok'}")

    if failures:
        print()
        for line in failures:
            print(line)
        print(f"\nFAIL {failed_cases}/{len(names)} cases ({len(failures)} difference(s))")
        return 1

    print(f"\nPASS {len(names)}/{len(names)} (runner layer, byte-for-byte)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))