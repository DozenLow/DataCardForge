#!/usr/bin/env python3
"""Tests for backend/runner: the DCM2 frame codec and runner.py.

Run with the vendored interpreter (the acceptance command)::

    PYTHONPATH=third_party/pylib:backend/runner \\
        third_party/pyruntime/bin/python3 backend/tests/py/test_runner.py

The file is a plain assert-based runner (no pytest, no unittest needed): every
``@case`` function is executed in order, failures do not stop the run, and the
summary line is ``PASS n/n`` (exit 0) or ``FAIL k/n`` plus the failing names
(exit 1). The test also bootstraps ``third_party/pylib`` and ``backend/runner``
on ``sys.path`` so it behaves the same with or without PYTHONPATH; only the
vendored runtime can satisfy it, because the script cards themselves are
executed by that interpreter.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
import types

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(  # backend/tests/py -> repo root
    os.path.dirname(os.path.dirname(HERE))
)
RUNNER_DIR = os.path.join(PROJECT, "backend", "runner")
PYLIB_DIR = os.path.join(PROJECT, "third_party", "pylib")
RUNNER = os.path.join(RUNNER_DIR, "runner.py")
PYTHON = sys.executable

for _path in (PYLIB_DIR, RUNNER_DIR):
    if _path not in sys.path:
        sys.path.insert(0, _path)

if not os.path.isfile(RUNNER):
    sys.exit(f"missing runner: {RUNNER}")
if not os.path.isdir(PYLIB_DIR):
    sys.exit("python runtime not provisioned: run bash scripts/fetch-python-runtime.sh")

import numpy as np  # noqa: E402  (after sys.path bootstrap)

import dcm2  # noqa: E402
import runner  # noqa: E402  (unit-level access to the DataFrame validator)

TMP_ROOT = os.path.join(HERE, "tmp")
os.makedirs(TMP_ROOT, exist_ok=True)
WORK = tempfile.mkdtemp(prefix="runner-test-", dir=TMP_ROOT)

try:
    import pandas as _pandas
except Exception:  # the vendored pylib ships numpy only
    _pandas = None


# ── tiny case registry ────────────────────────────────────────────────

CASES = []


def case(func):
    CASES.append(func)
    return func


# ── helpers ───────────────────────────────────────────────────────────


def _case_dir():
    return tempfile.mkdtemp(prefix="case-", dir=WORK)


def _env(overrides=None):
    """Environment for the runner subprocess (self-sufficient PYTHONPATH)."""
    env = dict(os.environ)
    parts = [p for p in env.get("PYTHONPATH", "").split(os.pathsep) if p]
    for path in (PYLIB_DIR, RUNNER_DIR):
        if path not in parts:
            parts.insert(0, path)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    if overrides:
        env.update(overrides)
    return env


def _run_runner(args, env_overrides=None):
    return subprocess.run(
        [PYTHON, RUNNER, *args],
        capture_output=True,
        text=True,
        env=_env(env_overrides),
    )


def _default_names(cols):
    return [f"Pos.{index + 1}" for index in range(cols)]


def _write_inputs(root, ports):
    in_dir = os.path.join(root, "in")
    os.makedirs(in_dir)
    entries = []
    for item in ports:
        name = item["port"]
        arr = np.asarray(item["arr"], dtype=np.float64)
        if arr.ndim == 1:
            arr = arr.reshape(-1, 1)
        names = item.get("names") or _default_names(arr.shape[1])
        filename = f"{name}.dcm2"
        dcm2.write_frame(os.path.join(in_dir, filename), arr, names)
        entries.append({"port": name, "frame": filename})
    with open(os.path.join(in_dir, "ports.json"), "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False)
    return in_dir


def _write_meta(root, script, outputs):
    meta_path = os.path.join(root, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(
            {"script": script, "outputs": list(outputs), "timeout_ms": 10000},
            fh,
            ensure_ascii=False,
        )
    return meta_path


def _execute(script, outputs, ports=(), out_name="out.dcm2"):
    root = _case_dir()
    in_dir = _write_inputs(root, ports)
    meta = _write_meta(root, script, outputs)
    out = os.path.join(root, out_name)
    proc = _run_runner(["--in", in_dir, "--out", out, "--meta", meta])
    return proc, root, out


def _stderr_json(proc):
    """The first stderr line of a 3/6 failure is the machine-readable object."""
    lines = proc.stderr.splitlines()
    assert lines, f"stderr should not be empty\nstdout={proc.stdout!r}"
    return json.loads(lines[0])


def _manifest(out_path):
    manifest_path = os.path.splitext(out_path)[0] + ".manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _header(path):
    with open(path, "rb") as fh:
        raw = fh.read(24)
    assert len(raw) == 24, f"{path}: shorter than a DCM2 header"
    return list(struct.unpack("<6I", raw))


def _assert_frame_layout(path):
    magic, rows, cols, names_len, total_rows, total_cols = _header(path)
    size = os.path.getsize(path)
    assert magic == 0x44434D32, f"{path}: bad magic 0x{magic:08X}"
    assert size == 24 + rows * cols * 8 + names_len, (
        f"{path}: {size} bytes, expected 24 + {rows}*{cols}*8 + {names_len}"
    )
    return rows, cols, total_rows, total_cols


def _assert_no_output(out_path):
    assert not os.path.exists(out_path), f"unexpected output frame: {out_path}"


def _check(script_source, path=None):
    """Write the source, run --check, return (proc, stdout_json_or_None)."""
    if path is None:
        path = os.path.join(_case_dir(), "script.py")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(script_source)
    proc = _run_runner(["--check", path])
    payload = json.loads(proc.stdout) if proc.stdout.strip() else None
    return proc, payload, path


# ── DCM2 codec ────────────────────────────────────────────────────────


@case
def test_dcm2_roundtrip_names_and_layout():
    root = _case_dir()
    path = os.path.join(root, "frame.dcm2")
    arr = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float64)
    names = ["Pos.1 alpha", "Pos.2 β 描述", "Pos.3 gamma"]
    dcm2.write_frame(path, arr, names)

    rows, cols, total_rows, total_cols = _assert_frame_layout(path)
    assert (rows, cols, total_rows, total_cols) == (2, 3, 2, 3), (
        rows,
        cols,
        total_rows,
        total_cols,
    )

    with open(path, "rb") as fh:
        raw = fh.read()
    names_len = _header(path)[3]
    expected_names = json.dumps(names, ensure_ascii=False).encode("utf-8")
    assert raw[24 + arr.size * 8 :] == expected_names, "names payload bytes"
    assert raw[24 : 24 + arr.size * 8] == arr.tobytes(order="F"), (
        "data block must be column-major f64"
    )

    back, back_names, total = dcm2.read_frame(path)
    assert back.shape == arr.shape
    assert back.dtype == np.float64
    assert back.flags.c_contiguous, "read_frame must return a C-order array"
    assert np.array_equal(back, arr)
    assert back_names == names
    assert total == (2, 3)


@case
def test_dcm2_nan_travels_unchanged():
    root = _case_dir()
    path = os.path.join(root, "frame.dcm2")
    arr = np.array([[np.nan, np.inf], [-np.inf, -0.0]], dtype=np.float64)
    dcm2.write_frame(path, arr, _default_names(2))
    back, _, _ = dcm2.read_frame(path)
    assert np.isnan(back[0, 0]), "NaN must survive"
    assert np.isposinf(back[0, 1]) and np.isneginf(back[1, 0])
    assert np.signbit(back[1, 1]), "-0.0 must survive bit-for-bit"
    assert back.tobytes() == arr.tobytes(), "NaN/Inf payload bytes must be identical"


@case
def test_dcm2_window_total_fields_are_independent():
    root = _case_dir()
    path = os.path.join(root, "window.dcm2")
    arr = np.array([[1.0], [2.0]], dtype=np.float64)
    dcm2.write_frame(path, arr, ["Pos.1 a"], total=(100000, 7))
    rows, cols, total_rows, total_cols = _assert_frame_layout(path)
    assert (rows, cols) == (2, 1)
    assert (total_rows, total_cols) == (100000, 7)
    back, names, total = dcm2.read_frame(path)
    assert back.shape == (2, 1) and names == ["Pos.1 a"] and total == (100000, 7)


@case
def test_dcm2_rejects_truncated_and_bad_magic():
    root = _case_dir()
    good = os.path.join(root, "good.dcm2")
    dcm2.write_frame(good, np.array([[1.0, 2.0]]), ["a", "b"])
    with open(good, "rb") as fh:
        raw = fh.read()

    truncated = os.path.join(root, "truncated.dcm2")
    with open(truncated, "wb") as fh:
        fh.write(raw[:-1])
    try:
        dcm2.read_frame(truncated)
    except dcm2.Dcm2Error as exc:
        assert "length mismatch" in str(exc), str(exc)
        assert "49 bytes" in str(exc), str(exc)
    else:
        raise AssertionError("truncated frame must raise Dcm2Error")

    bad_magic = os.path.join(root, "magic.dcm2")
    with open(bad_magic, "wb") as fh:
        fh.write(struct.pack("<I", 0x44434D31) + raw[4:])
    try:
        dcm2.read_frame(bad_magic)
    except dcm2.Dcm2Error as exc:
        assert "magic" in str(exc).lower(), str(exc)
    else:
        raise AssertionError("bad magic must raise Dcm2Error")


# ── runner execution ──────────────────────────────────────────────────


@case
def test_runner_identity_passes_matrix_through():
    source = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float64)
    proc, _root, out = _execute(
        "out = A\n",
        ["out"],
        ports=[{"port": "A", "arr": source, "names": ["Pos.1 x", "Pos.2 y"]}],
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == "", "execute mode must keep stdout clean"
    arr, names, total = dcm2.read_frame(out)
    assert np.array_equal(arr, source)
    assert names == ["Pos.1", "Pos.2"], names  # ndarray outputs get default names
    assert total == (2, 2)
    _assert_frame_layout(out)


@case
def test_runner_matrix_transpose():
    source = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float64)
    proc, _root, out = _execute(
        "import numpy as np\nout = np.ascontiguousarray(A.T)\n",
        ["out"],
        ports=[{"port": "A", "arr": source}],
    )
    assert proc.returncode == 0, proc.stderr
    arr, _names, _total = dcm2.read_frame(out)
    assert arr.shape == (3, 2)
    assert np.array_equal(arr, source.T)


@case
def test_runner_input_globals_names_and_shape():
    source = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float64)
    script = (
        "import numpy as np\n"
        "assert names_a == ['Pos.1 x', 'Pos.2 y', 'Pos.3 z'], names_a\n"
        "assert shape_a == (2, 3), shape_a\n"
        "out = np.full(shape_a, float(len(names_a)), dtype=np.float64)\n"
    )
    proc, _root, out = _execute(
        script,
        ["out"],
        ports=[{"port": "A", "arr": source, "names": ["Pos.1 x", "Pos.2 y", "Pos.3 z"]}],
    )
    assert proc.returncode == 0, proc.stderr
    arr, _names, _total = dcm2.read_frame(out)
    assert arr.shape == (2, 3)
    assert np.array_equal(arr, np.full((2, 3), 3.0))


@case
def test_runner_two_ports_multiply():
    a = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float64)
    b = np.array([[5.0, 6.0], [7.0, 8.0]], dtype=np.float64)
    proc, _root, out = _execute(
        "import numpy as np\nout = A @ B\n",
        ["out"],
        ports=[{"port": "A", "arr": a}, {"port": "B", "arr": b}],
    )
    assert proc.returncode == 0, proc.stderr
    arr, _names, _total = dcm2.read_frame(out)
    assert np.array_equal(arr, a @ b)


@case
def test_runner_int64_within_2p53_widens_to_float64():
    script = (
        "import numpy as np\n"
        "out = np.array([[1, -2], [2**53, -(2**53)]], dtype=np.int64)\n"
    )
    proc, _root, out = _execute(script, ["out"])
    assert proc.returncode == 0, proc.stderr
    arr, _names, _total = dcm2.read_frame(out)
    assert arr.dtype == np.float64
    assert np.array_equal(arr, np.array([[1.0, -2.0], [2.0**53, -(2.0**53)]]))


@case
def test_runner_int64_beyond_2p53_is_rejected():
    script = "import numpy as np\nout = np.array([2**53 + 1], dtype=np.int64)\n"
    proc, _root, out = _execute(script, ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert payload["output"] == "out", payload
    assert "2**53" in payload["reason"], payload
    assert "int64" in payload["actual"], payload
    assert len(proc.stderr.splitlines()) >= 2, "a human-readable line follows the JSON"
    _assert_no_output(out)


@case
def test_runner_int_scalar_beyond_2p53_is_rejected():
    # A bare Python int never reaches asarray (it takes the _coerce_value
    # scalar branch), so the +-2**53 gate must live there too. Without it,
    # float(2**53 + 1) rounded silently to 9007199254740992.0 and exited 0,
    # while [2**53 + 1] exited 3 -- two answers for the same value.
    proc, _root, out = _execute("out = 2**53 + 1\n", ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert payload["output"] == "out", payload
    assert "2**53" in payload["reason"], payload
    assert payload["actual"] == "int", payload
    assert len(proc.stderr.splitlines()) >= 2, "a human-readable line follows the JSON"
    _assert_no_output(out)


@case
def test_runner_negative_int_scalar_beyond_2p53_is_rejected():
    proc, _root, out = _execute("out = -(2**53 + 1)\n", ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert payload["output"] == "out", payload
    assert "2**53" in payload["reason"], payload
    assert payload["actual"] == "int", payload
    _assert_no_output(out)


@case
def test_runner_int_scalar_at_2p53_boundary_is_accepted():
    # +-2**53 is exactly representable in float64: the gate is a closed
    # interval (`>` MAX_SAFE_INT, not `>=`), matching the ndarray rule.
    proc, _root, out = _execute("out = 2**53\n", ["out"])
    assert proc.returncode == 0, proc.stderr
    arr, _names, _total = dcm2.read_frame(out)
    assert arr.shape == (1, 1), arr.shape
    assert arr.dtype == np.float64
    assert arr[0, 0] == 9007199254740992.0, arr[0, 0]
    _assert_frame_layout(out)


@case
def test_runner_bool_scalar_keeps_1x1_float():
    # bool subclasses int; the magnitude gate must leave True/False on the
    # historical exact mapping (1.0 -> a 1x1 frame) instead of rejecting it.
    proc, _root, out = _execute("out = True\n", ["out"])
    assert proc.returncode == 0, proc.stderr
    arr, _names, _total = dcm2.read_frame(out)
    assert arr.shape == (1, 1), arr.shape
    assert arr.dtype == np.float64
    assert arr[0, 0] == 1.0, arr[0, 0]
    _assert_frame_layout(out)


@case
def test_runner_object_dtype_is_rejected():
    script = "import numpy as np\nout = np.array([['1'], ['2']], dtype=object)\n"
    proc, _root, out = _execute(script, ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert "object" in payload["actual"], payload
    assert "object" in payload["reason"], payload
    _assert_no_output(out)


@case
def test_runner_object_dtype_list_is_rejected():
    proc, _root, out = _execute("out = [1, 'two']\n", ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert payload["output"] == "out", payload
    _assert_no_output(out)


@case
def test_runner_float32_is_rejected():
    script = "import numpy as np\nout = np.zeros((2, 2), dtype=np.float32)\n"
    proc, _root, out = _execute(script, ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert "float32" in payload["actual"], payload
    _assert_no_output(out)


@case
def test_runner_missing_output_exits_3():
    proc, _root, out = _execute("x = 1\n", ["cleaned"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload == {"error": "missingOutput", "output": "cleaned"}, payload
    lines = proc.stderr.splitlines()
    assert len(lines) >= 2 and "cleaned" in lines[1], proc.stderr
    _assert_no_output(out)


@case
def test_runner_declared_but_unassigned_output_exits_3():
    script = "cleaned: float\n"  # annotation only: no binding is created
    proc, _root, out = _execute(script, ["cleaned"])
    assert proc.returncode == 3, proc.stderr
    assert _stderr_json(proc) == {"error": "missingOutput", "output": "cleaned"}
    _assert_no_output(out)


@case
def test_runner_str_scalar_is_rejected():
    proc, _root, out = _execute("out = 'hello'\n", ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert payload["actual"] == "str", payload
    _assert_no_output(out)


@case
def test_runner_scalars_and_sequences_shapes():
    script = (
        "import numpy as np\n"
        "a = np.array(5.0)\n"
        "b = [1.0, 2.0, 3.0]\n"
        "c = True\n"
        "d = 7\n"
        "e = (2.0, 3.0)\n"
    )
    proc, _root, out = _execute(script, ["a", "b", "c", "d", "e"])
    assert proc.returncode == 0, proc.stderr

    first = dcm2.read_frame(out)[0]
    assert first.shape == (1, 1) and first[0, 0] == 5.0
    second = dcm2.read_frame(os.path.join(os.path.dirname(out), "out.1.dcm2"))[0]
    assert second.shape == (3, 1) and np.array_equal(second[:, 0], [1.0, 2.0, 3.0])
    third = dcm2.read_frame(os.path.join(os.path.dirname(out), "out.2.dcm2"))[0]
    assert third.shape == (1, 1) and third[0, 0] == 1.0
    fourth = dcm2.read_frame(os.path.join(os.path.dirname(out), "out.3.dcm2"))[0]
    assert fourth.shape == (1, 1) and fourth[0, 0] == 7.0
    fifth = dcm2.read_frame(os.path.join(os.path.dirname(out), "out.4.dcm2"))[0]
    assert fifth.shape == (2, 1) and np.array_equal(fifth[:, 0], [2.0, 3.0])
    _assert_frame_layout(out)


@case
def test_runner_bool_array_is_rejected():
    # A bool ndarray is not float64 and is not an integer dtype: the ndarray
    # rule rejects it, so a tuple of bools must not sneak through either.
    proc, _root, out = _execute("out = (True, False)\n", ["out"])
    assert proc.returncode == 3, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "invalidOutput", payload
    assert "bool" in payload["reason"] or "bool" in payload["actual"], payload
    _assert_no_output(out)


@case
def test_runner_multi_output_manifest():
    a = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float64)
    script = "import numpy as np\nx = A\ny = A.T\nz = 2.5\n"
    proc, root, out = _execute(script, ["x", "y", "z"], ports=[{"port": "A", "arr": a}])
    assert proc.returncode == 0, proc.stderr

    frames = [out, os.path.join(root, "out.1.dcm2"), os.path.join(root, "out.2.dcm2")]
    for frame in frames:
        assert os.path.isfile(frame), frame
        _assert_frame_layout(frame)

    x, x_names, _ = dcm2.read_frame(frames[0])
    y, _y_names, _ = dcm2.read_frame(frames[1])
    z, z_names, _ = dcm2.read_frame(frames[2])
    assert np.array_equal(x, a)
    assert np.array_equal(y, a.T)
    assert z.shape == (1, 1) and z[0, 0] == 2.5
    assert x_names == ["Pos.1", "Pos.2"]
    assert z_names == ["Pos.1"]

    manifest = _manifest(out)
    assert len(manifest) == 3, manifest
    assert [entry["name"] for entry in manifest] == ["x", "y", "z"]
    assert [entry["frame"] for entry in manifest] == ["out.dcm2", "out.1.dcm2", "out.2.dcm2"]
    assert [(entry["rows"], entry["cols"]) for entry in manifest] == [(2, 2), (2, 2), (1, 1)]
    for entry in manifest:
        assert set(entry) == {"name", "frame", "rows", "cols"}, entry


@case
def test_runner_later_bad_output_writes_nothing():
    proc, root, out = _execute(
        "a = 1.0\nb = 'nope'\n", ["a", "b"]
    )
    assert proc.returncode == 3, proc.stderr
    assert _stderr_json(proc)["output"] == "b"
    _assert_no_output(out)
    assert not os.path.exists(os.path.join(root, "out.manifest.json"))


# ── runner script failures ────────────────────────────────────────────


@case
def test_runner_exception_traceback_keeps_source_lines():
    script = "x = 1\nraise ValueError('boom')\n"
    proc, _root, out = _execute(script, ["out"])
    assert proc.returncode == 2, proc.stderr
    assert "Traceback (most recent call last):" in proc.stderr
    assert "<脚本卡>" in proc.stderr, proc.stderr
    assert "line 2" in proc.stderr, proc.stderr
    assert "ValueError: boom" in proc.stderr, proc.stderr
    _assert_no_output(out)


@case
def test_runner_does_not_preinject_numpy():
    proc, _root, out = _execute("out = numpy.zeros((1, 1))\n", ["out"])
    assert proc.returncode == 2, proc.stderr
    assert "NameError" in proc.stderr and "numpy" in proc.stderr, proc.stderr
    _assert_no_output(out)


@case
def test_runner_runtime_missing_exits_5():
    sentinel = os.path.join(TMP_ROOT, "runtime-missing-sentinel.txt")
    if os.path.exists(sentinel):
        os.remove(sentinel)
    script = (
        f"open({json.dumps(sentinel)}, 'w').write('executed')\n"
        "out = 1.0\n"
    )
    root = _case_dir()
    in_dir = _write_inputs(root, [])
    meta = _write_meta(root, script, ["out"])
    out = os.path.join(root, "out.dcm2")
    proc = _run_runner(
        ["--in", in_dir, "--out", out, "--meta", meta],
        env_overrides={"PYTHONPATH": "", "PYTHONNOUSERSITE": "1"},
    )
    assert proc.returncode == 5, proc.stderr
    assert proc.stderr.strip() == '{"error": "runtimeMissing"}', repr(proc.stderr)
    assert not os.path.exists(sentinel), "no script code may run without numpy"
    _assert_no_output(out)


@case
def test_runner_syntax_error_in_meta_script_exits_6():
    # Normally the parent runs --check first; if a broken source still reaches
    # execute mode, it must not look like a script crash (exit 2).
    proc, _root, out = _execute("x = 1\nif True\n", ["out"])
    assert proc.returncode == 6, proc.stderr
    payload = _stderr_json(proc)
    assert payload["error"] == "syntax", payload
    assert payload["line"] == 2, payload
    _assert_no_output(out)


@case
def test_runner_bad_arguments_exit_64():
    proc = _run_runner([])
    assert proc.returncode == 64, proc.stderr
    assert "--in" in proc.stderr and "--out" in proc.stderr and "--meta" in proc.stderr
    assert "runner:" in proc.stderr


# ── --check mode ──────────────────────────────────────────────────────


@case
def test_check_syntax_error_reports_source_line():
    source = "x = 1\ny = 2\nif True\n"
    path = os.path.join(_case_dir(), "broken.py")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(source)
    proc = _run_runner(["--check", path])
    assert proc.returncode == 6, proc.stderr
    assert proc.stdout == "", "syntax errors go to stderr, not stdout"
    payload = _stderr_json(proc)
    assert payload["error"] == "syntax", payload
    assert payload["line"] == 3, payload
    assert payload["col"] > 0, payload
    assert ":" in payload["msg"], payload


@case
def test_check_never_executes_the_script():
    target = os.path.join(TMP_ROOT, "check-must-not-create.txt")
    if os.path.exists(target):
        os.remove(target)
    source = f"open({json.dumps(target)}, 'w').write('escaped')\n"
    proc, payload, _path = _check(source)
    assert proc.returncode == 0, proc.stderr
    assert payload is not None and "open()" in payload["lint"]["impure"], payload
    assert not os.path.exists(target), "--check executed the script"


@case
def test_check_clean_script_has_no_impure_entries():
    source = (
        "import numpy as np\n"
        "def stats(x):\n"
        "    return float(np.nanmean(x))\n"
        "out = stats(A)\n"
    )
    proc, payload, _path = _check(source)
    assert proc.returncode == 0, proc.stderr
    assert payload == {"lint": {"impure": []}}, payload


@case
def test_check_flags_impure_imports_and_calls():
    source = (
        "import socket\n"
        "import subprocess as sp\n"
        "from urllib.request import urlopen\n"
        "import requests\n"
        "import os\n"
        "import random\n"
        "x = open('/dev/null')\n"
        "os.system('true')\n"
        "random.random()\n"
    )
    proc, payload, _path = _check(source)
    assert proc.returncode == 0, proc.stderr
    impure = payload["lint"]["impure"]
    for expected in (
        "import socket",
        "import subprocess",
        "import urllib.request",
        "import requests",
        "open()",
        "os.system()",
        "random.* without seed()",
    ):
        assert expected in impure, (expected, impure)


@case
def test_check_seeded_random_is_clean():
    source = "import random\nrandom.seed(0)\nrandom.random()\n"
    proc, payload, _path = _check(source)
    assert proc.returncode == 0, proc.stderr
    assert payload["lint"]["impure"] == [], payload

    qualified = "from random import seed, random\nseed(1)\nx = random()\n"
    proc, payload, _path = _check(qualified)
    assert proc.returncode == 0, proc.stderr
    assert payload["lint"]["impure"] == [], payload


# ── pandas output ─────────────────────────────────────────────────────
#
# The vendored pylib ships numpy only, so the DataFrame branch is covered with
# a pandas-shaped mock (below) and, when a real pandas happens to be importable,
# end to end through runner.py as well.


class _FakeDtype:
    def __init__(self, kind, itemsize):
        self.kind = kind
        self.itemsize = itemsize

    def __repr__(self):
        return f"dtype({self.kind}{self.itemsize})"


class _FakeRangeIndex:
    def __init__(self, start, stop, step=1):
        self.start = start
        self.stop = stop
        self.step = step

    def _values(self):
        return list(range(self.start, self.stop, self.step))

    def __len__(self):
        return len(self._values())

    def __getitem__(self, key):
        return self._values()[key]

    def __iter__(self):
        return iter(self._values())


class _FakeLabels:
    def __init__(self, labels):
        self._labels = list(labels)

    def __len__(self):
        return len(self._labels)

    def __getitem__(self, key):
        return self._labels[key]

    def __iter__(self):
        return iter(self._labels)


class _FakeSeries:
    def __init__(self, values, dtype):
        self.values = np.asarray(values)
        self.dtype = dtype

    def dropna(self):
        return self

    def __len__(self):
        return len(self.values)

    def max(self):
        return self.values.max()

    def min(self):
        return self.values.min()


class _FakeILoc:
    def __init__(self, frame):
        self._frame = frame

    def __getitem__(self, key):
        rows, position = key
        assert rows == slice(None, None, None), key
        column = self._frame.columns[position]
        return _FakeSeries(self._frame.data[column], self._frame.dtypes[position])


class _FakeDataFrame:
    """The small slice of the pandas API that runner._coerce_dataframe uses."""

    def __init__(self, data, index=None):
        labels = list(data)
        self.columns = _FakeLabels(labels)
        self.data = {label: np.asarray(values) for label, values in data.items()}
        count = len(next(iter(self.data.values()))) if self.data else 0
        self.index = _FakeRangeIndex(0, count) if index is None else index
        self.dtypes = [
            _FakeDtype(self.data[label].dtype.kind, self.data[label].dtype.itemsize)
            for label in labels
        ]
        self.iloc = _FakeILoc(self)

    def __len__(self):
        return len(self.index)

    def to_numpy(self, dtype=None, na_value=None):
        if not self.columns:
            return np.zeros((len(self), 0), dtype=dtype)
        return np.column_stack(
            [self.data[label].astype(dtype) for label in self.columns]
        )


def _fake_pandas():
    return types.SimpleNamespace(
        DataFrame=_FakeDataFrame, RangeIndex=_FakeRangeIndex
    )


@case
def test_dataframe_mock_accepts_float_and_small_int_columns():
    fake = _fake_pandas()
    frame = _FakeDataFrame(
        {"alpha": [1.0, 2.0], "beta": np.array([3, 4], dtype=np.int64)}
    )
    arr, labels = runner._coerce_dataframe(np, fake, frame, "out")
    assert labels == ["alpha", "beta"], labels
    assert arr.dtype == np.float64 and arr.shape == (2, 2), (arr.dtype, arr.shape)
    assert np.array_equal(arr, np.array([[1.0, 3.0], [2.0, 4.0]]))


@case
def test_dataframe_mock_custom_index_is_rejected_with_hint():
    fake = _fake_pandas()
    frame = _FakeDataFrame({"a": [1.0, 2.0]}, index=[10, 11])
    try:
        runner._coerce_dataframe(np, fake, frame, "out")
    except runner._InvalidOutput as exc:
        assert "reset_index(drop=True)" in exc.reason, exc.reason
        assert exc.actual.startswith("pandas.DataFrame"), exc.actual
    else:
        raise AssertionError("a non-RangeIndex DataFrame must be rejected")


@case
def test_dataframe_mock_rejects_bool_bigint_and_object_columns():
    fake = _fake_pandas()
    cases = (
        ({"a": np.array([True, False])}, "bool"),
        ({"a": np.array([2 ** 53 + 1], dtype=np.int64)}, "2**53"),
        ({"a": np.array(["x", "y"], dtype=object)}, "not losslessly convertible"),
    )
    for data, fragment in cases:
        try:
            runner._coerce_dataframe(np, fake, _FakeDataFrame(data), "out")
        except runner._InvalidOutput as exc:
            assert fragment in exc.reason, (fragment, exc.reason)
        else:
            raise AssertionError(f"column must be rejected: {fragment}")


if _pandas is not None:

    @case
    def test_runner_dataframe_columns_and_values():
        script = (
            "import pandas as pd\n"
            "out = pd.DataFrame({'alpha': [1.0, 2.0], 'beta': [3, 4]})\n"
        )
        proc, _root, out = _execute(script, ["out"])
        assert proc.returncode == 0, proc.stderr
        arr, names, _total = dcm2.read_frame(out)
        assert names == ["alpha", "beta"], names
        assert np.array_equal(arr, np.array([[1.0, 3.0], [2.0, 4.0]]))

    @case
    def test_runner_dataframe_custom_index_is_rejected():
        script = (
            "import pandas as pd\n"
            "out = pd.DataFrame({'a': [1.0, 2.0]}, index=[10, 11])\n"
        )
        proc, _root, out = _execute(script, ["out"])
        assert proc.returncode == 3, proc.stderr
        payload = _stderr_json(proc)
        assert payload["error"] == "invalidOutput", payload
        assert "reset_index(drop=True)" in payload["reason"], payload
        _assert_no_output(out)


# ── runner ────────────────────────────────────────────────────────────


def main():
    if _pandas is None:
        print(
            "note: pandas is not importable; the DataFrame branch is covered by "
            "the pandas-shaped mock, not by an end-to-end run"
        )
    total = len(CASES)
    failed = []
    for func in CASES:
        try:
            func()
        except BaseException:
            failed.append(func.__name__)
            print(f"FAIL {func.__name__}")
            traceback.print_exc()
        else:
            print(f"ok   {func.__name__}")
    try:
        shutil.rmtree(WORK, ignore_errors=True)
        if os.path.isdir(TMP_ROOT) and not os.listdir(TMP_ROOT):
            os.rmdir(TMP_ROOT)
    except OSError:
        traceback.print_exc()

    if failed:
        print(f"FAIL {len(failed)}/{total}: " + ", ".join(failed))
        return 1
    print(f"PASS {total}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())