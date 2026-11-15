#!/usr/bin/env python3
"""Clean-room runner for script cards.

Usage::

    python3 runner.py --in <dir> --out <frame> --meta <meta.json>   # execute
    python3 runner.py --check <script.py>                           # check only

The execute mode reads ``ports.json`` from ``--in`` (a list of
``{"port": "A", "frame": "A.dcm2"}`` in injection order), injects every input
frame into the script's globals as ``A`` / ``names_a`` / ``shape_a`` (suffix is
the lower-cased port name), runs the script exactly as written
(``compile(script, "<脚本卡>", "exec")`` -- no code is spliced around it, so
traceback line numbers match the source), then validates every name listed in
``meta.outputs`` and writes the accepted matrices as DCM2 frames.

Exit codes::

    0   success
    2   the script raised (stderr is the original traceback)
    3   an output is missing or invalid (stderr: one JSON line + one human line)
    4   never produced here -- the parent kills a timeout
    5   numpy could not be imported (stderr: {"error":"runtimeMissing"})
    6   the script does not compile (stderr: {"error":"syntax",...})
    64  bad arguments / unreadable meta, ports.json or input frame

Nothing is converted implicitly: only float64 data, integers within +-2**53,
Python bool/int/float scalars, numeric lists/tuples and losslessly convertible
pandas DataFrames with a ``RangeIndex`` are accepted.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import json
import os
import sys
import traceback

EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_SCRIPT_ERROR = 2
EXIT_OUTPUT = 3
EXIT_RUNTIME_MISSING = 5
EXIT_SYNTAX = 6
EXIT_USAGE = 64

CARD_FILENAME = "<脚本卡>"
MAX_SAFE_INT = 2 ** 53
MANIFEST_SUFFIX = ".manifest.json"


class _UsageError(Exception):
    """Bad invocation or unreadable parent-supplied input (exit 64)."""


class _MissingOutput(Exception):
    def __init__(self, name):
        super().__init__(name)
        self.name = name


class _InvalidOutput(Exception):
    def __init__(self, name, reason, actual):
        super().__init__(reason)
        self.name = name
        self.reason = reason
        self.actual = actual


# ── main ──────────────────────────────────────────────────────────────


def main(argv=None):
    try:
        args = _parse_args(sys.argv[1:] if argv is None else argv)
        if args.check is not None:
            return _check_mode(args.check)
        return _execute_mode(args)
    except _UsageError as exc:
        sys.stderr.write(f"runner: {exc}\n")
        return EXIT_USAGE


# ── execute mode ──────────────────────────────────────────────────────


def _execute_mode(args):
    numpy = _import_numpy()
    if numpy is None:
        _write_json({"error": "runtimeMissing"})
        return EXIT_RUNTIME_MISSING
    try:
        import dcm2
    except Exception:
        dcm2 = None
    if dcm2 is None:
        _write_json({"error": "runtimeMissing"})
        sys.stderr.write("runner: cannot import dcm2.py from the runner directory\n")
        return EXIT_RUNTIME_MISSING

    script, outputs = _load_meta(args.meta)

    # Compile before touching the input frames: a syntax error is the script's
    # fault and must not depend on whether an input frame happens to be readable.
    try:
        code = compile(script, CARD_FILENAME, "exec")
    except SyntaxError as exc:
        _write_json(
            {
                "error": "syntax",
                "line": int(exc.lineno or 0),
                "col": int(exc.offset or 0),
                "msg": str(exc.msg),
            }
        )
        return EXIT_SYNTAX
    except (ValueError, RecursionError) as exc:
        _write_json(
            {"error": "syntax", "line": 0, "col": 0, "msg": f"{type(exc).__name__}: {exc}"}
        )
        return EXIT_SYNTAX

    globs = _load_ports(numpy, dcm2, args.in_dir)

    try:
        exec(code, globs)
    except BaseException:
        traceback.print_exc(file=sys.stderr)
        return EXIT_SCRIPT_ERROR

    try:
        accepted = _collect_outputs(numpy, outputs, globs)
    except _MissingOutput as exc:
        _write_json({"error": "missingOutput", "output": exc.name})
        _human(
            f"output {exc.name!r} is not defined after the script ran "
            f"(assign it before the script ends)"
        )
        return EXIT_OUTPUT
    except _InvalidOutput as exc:
        _write_json(
            {
                "error": "invalidOutput",
                "output": exc.name,
                "reason": exc.reason,
                "actual": exc.actual,
            }
        )
        _human(f"output {exc.name!r} rejected: {exc.reason} (actual: {exc.actual})")
        return EXIT_OUTPUT

    try:
        _write_frames(dcm2, args.out, accepted)
    except OSError as exc:
        sys.stderr.write(f"runner: cannot write output frames: {exc}\n")
        return EXIT_INTERNAL
    return EXIT_OK


def _load_meta(path):
    meta = _read_json(path, "meta")
    if not isinstance(meta, dict):
        raise _UsageError("meta must be a JSON object")
    script = meta.get("script")
    if not isinstance(script, str):
        raise _UsageError("meta.script must be a string containing the card source")
    outputs = meta.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        raise _UsageError("meta.outputs must be a non-empty array of output names")
    names = []
    for index, name in enumerate(outputs):
        if not isinstance(name, str) or not name:
            raise _UsageError(f"meta.outputs[{index}] must be a non-empty string")
        if name in names:
            raise _UsageError(f"meta.outputs contains the duplicate name {name!r}")
        names.append(name)
    # meta.timeout_ms belongs to the parent: it kills us, we do not watch a clock.
    return script, names


def _load_ports(numpy, dcm2, in_dir):
    if not os.path.isdir(in_dir):
        raise _UsageError(f"--in {in_dir!r} is not a directory")
    ports_path = os.path.join(in_dir, "ports.json")
    entries = _read_json(ports_path, "ports.json")
    if not isinstance(entries, list):
        raise _UsageError(f"{ports_path}: expected a JSON array of port entries")

    globs = {"__name__": "__main__", "__builtins__": builtins}
    seen = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise _UsageError(f"{ports_path}: entry {index} is not an object")
        port = entry.get("port")
        frame = entry.get("frame")
        if not isinstance(port, str) or not port:
            raise _UsageError(f"{ports_path}: entry {index} has no port name")
        if not port.isidentifier():
            raise _UsageError(
                f"{ports_path}: port {port!r} is not a valid Python identifier "
                f"(scripts must be able to name it)"
            )
        if port in seen:
            raise _UsageError(f"{ports_path}: duplicate port name {port!r}")
        seen.add(port)
        if not isinstance(frame, str) or not frame:
            raise _UsageError(f"{ports_path}: port {port!r} has no frame file")
        frame_path = frame if os.path.isabs(frame) else os.path.join(in_dir, frame)
        try:
            arr, names, _total = dcm2.read_frame(frame_path)
        except (OSError, ValueError) as exc:
            raise _UsageError(f"cannot read input frame for port {port!r}: {exc}")

        suffix = port.lower()
        globs[port] = arr
        globs[f"names_{suffix}"] = names
        globs[f"shape_{suffix}"] = (int(arr.shape[0]), int(arr.shape[1]))
    return globs


# ── output validation ─────────────────────────────────────────────────


def _collect_outputs(numpy, outputs, globs):
    accepted = []
    for name in outputs:
        if name not in globs:
            raise _MissingOutput(name)
        arr, labels = _coerce_value(numpy, globs[name], name)
        accepted.append((name, arr, labels))
    return accepted


def _coerce_value(numpy, value, name):
    if isinstance(value, numpy.ndarray):
        if _is_masked(numpy, value):
            raise _InvalidOutput(
                name,
                "masked cells have no frame representation; fill them with NaN first",
                _describe_value(value),
            )
        return _coerce_array(numpy, value, name, origin="numpy.ndarray")

    if isinstance(value, (list, tuple)):
        try:
            arr = numpy.asarray(value)
        except (TypeError, ValueError, OverflowError) as exc:
            raise _InvalidOutput(
                name,
                f"list/tuple is not a rectangular numeric array ({exc})",
                type(value).__name__,
            )
        return _coerce_array(numpy, arr, name, origin=type(value).__name__)

    if isinstance(value, (bool, int, float)):
        try:
            scalar = float(value)
        except (OverflowError, ValueError) as exc:
            raise _InvalidOutput(
                name,
                f"{type(value).__name__} scalar is out of float64 range ({exc})",
                type(value).__name__,
            )
        # float() rounds an int past +-2**53 silently; the ndarray and list
        # paths reject the same value, so a scalar must not take a different
        # route. bool subclasses int but has an exact image (True -> 1.0) and
        # is exempt. The gate sits after the conversion above so ints beyond
        # float64's range keep reporting that OverflowError instead.
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and abs(value) > MAX_SAFE_INT
        ):
            raise _InvalidOutput(
                name,
                f"integer scalar {value} is outside +-2**53 and cannot be "
                f"widened to float64 without losing precision",
                type(value).__name__,
            )
        arr = numpy.array([[scalar]], dtype=numpy.float64)
        return arr, None

    pandas = _import_pandas()
    if pandas is not None and isinstance(value, pandas.DataFrame):
        return _coerce_dataframe(numpy, pandas, value, name)

    raise _InvalidOutput(
        name,
        "unsupported output type: expected a numeric ndarray, list/tuple, "
        "bool/int/float scalar or pandas DataFrame",
        _describe_value(value),
    )


def _coerce_array(numpy, arr, name, origin):
    if arr.ndim > 2:
        raise _InvalidOutput(
            name,
            f"ndim {arr.ndim} exceeds 2; a card output is a 1-D or 2-D matrix",
            _describe_array(arr, origin),
        )
    if arr.ndim == 0:
        arr = arr.reshape(1, 1)
    elif arr.ndim == 1:
        arr = arr.reshape(-1, 1)

    kind = arr.dtype.kind
    if kind == "f":
        if arr.dtype.itemsize > 8:
            raise _InvalidOutput(
                name,
                f"dtype {arr.dtype} is wider than float64 and would lose precision",
                _describe_array(arr, origin),
            )
        if arr.dtype.itemsize == 8:
            return arr, None
        raise _InvalidOutput(
            name,
            f"dtype {arr.dtype} is not float64; no silent astype -- return float64 "
            f"arrays (float32 does not qualify)",
            _describe_array(arr, origin),
        )

    if kind in ("i", "u"):
        if arr.size:
            maximum = int(arr.max())
            minimum = int(arr.min())
            if maximum > MAX_SAFE_INT or minimum < -MAX_SAFE_INT:
                raise _InvalidOutput(
                    name,
                    f"integer values outside +-2**53 (min {minimum}, max {maximum}) "
                    f"cannot be widened to float64 without losing precision",
                    _describe_array(arr, origin),
                )
        return arr.astype(numpy.float64), None

    raise _InvalidOutput(
        name,
        f"dtype {arr.dtype} is not supported (only float64 and integers within "
        f"+-2**53 pass; bool/complex/object/str/datetime do not)",
        _describe_array(arr, origin),
    )


def _coerce_dataframe(numpy, pandas, frame, name):
    actual = _describe_dataframe(frame)
    count = len(frame)
    index = frame.index
    if not (
        isinstance(index, pandas.RangeIndex)
        and int(index.start) == 0
        and int(index.step) == 1
        and int(index.stop) == count
    ):
        head = list(index[:3])
        raise _InvalidOutput(
            name,
            f"DataFrame index is {type(index).__name__} {head!r}, not "
            f"RangeIndex(0..{count - 1}); call .reset_index(drop=True) before returning",
            actual,
        )

    for position, dtype in enumerate(frame.dtypes):
        label = frame.columns[position]
        kind = getattr(dtype, "kind", None)
        itemsize = int(getattr(dtype, "itemsize", 0) or 0)
        if kind in ("i", "u"):
            series = frame.iloc[:, position]
            try:
                values = series.dropna()
                if len(values):
                    maximum = int(values.max())
                    minimum = int(values.min())
                    if maximum > MAX_SAFE_INT or minimum < -MAX_SAFE_INT:
                        raise _InvalidOutput(
                            name,
                            f"column {label!r} holds integers outside +-2**53 "
                            f"(min {minimum}, max {maximum}); not lossless to float64",
                            actual,
                        )
            except (TypeError, ValueError, OverflowError) as exc:
                raise _InvalidOutput(
                    name,
                    f"column {label!r} could not be verified as losslessly "
                    f"convertible to float64 ({exc})",
                    actual,
                )
        elif kind == "f":
            if itemsize > 8:
                raise _InvalidOutput(
                    name,
                    f"column {label!r} has dtype {dtype}, wider than float64",
                    actual,
                )
        elif kind == "b":
            raise _InvalidOutput(
                name,
                f"column {label!r} is bool; boolean columns are not float64 data -- "
                f"convert with .astype('float64') explicitly",
                actual,
            )
        else:
            raise _InvalidOutput(
                name,
                f"column {label!r} has dtype {dtype}, which is not losslessly "
                f"convertible to float64; convert numeric columns with "
                f".astype('float64') first",
                actual,
            )

    try:
        # Optional extension dtypes (nullable Int64/boolean) carry pd.NA; the
        # protocol's missing marker is NaN, so map NA -> NaN instead of failing.
        # pandas >= 2.0 knows na_value; on an older pandas the TypeError below
        # turns into a clear rejection instead of a frame full of garbage.
        arr = frame.to_numpy(dtype=numpy.float64, na_value=numpy.nan)
    except (TypeError, ValueError) as exc:
        raise _InvalidOutput(
            name,
            f"DataFrame could not be converted to a float64 block ({exc}); fill "
            f"missing values and convert explicitly",
            actual,
        )
    labels = [str(column) for column in frame.columns]
    matrix, _default = _coerce_array(
        numpy, numpy.asarray(arr), name, origin="pandas.DataFrame"
    )
    return matrix, labels


def _write_frames(dcm2, out_path, accepted):
    base = os.path.splitext(out_path)[0]
    manifest = []
    for position, (name, arr, labels) in enumerate(accepted):
        frame_path = out_path if position == 0 else f"{base}.{position}.dcm2"
        rows, cols = int(arr.shape[0]), int(arr.shape[1])
        if labels is None:
            labels = [f"Pos.{column + 1}" for column in range(cols)]
        _ensure_parent(frame_path)
        dcm2.write_frame(frame_path, arr, labels)
        manifest.append(
            {
                "name": name,
                "frame": os.path.basename(frame_path),
                "rows": rows,
                "cols": cols,
            }
        )

    manifest_path = base + MANIFEST_SUFFIX
    _ensure_parent(manifest_path)
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _ensure_parent(path):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


# ── check mode ────────────────────────────────────────────────────────


def _check_mode(script_path):
    try:
        with open(script_path, "rb") as fh:
            source = fh.read()
    except OSError as exc:
        raise _UsageError(f"cannot read script {script_path!r}: {exc}")

    try:
        tree = compile(source, script_path, "exec", ast.PyCF_ONLY_AST)
    except SyntaxError as exc:
        _write_json(
            {
                "error": "syntax",
                "line": int(exc.lineno or 0),
                "col": int(exc.offset or 0),
                "msg": str(exc.msg),
            }
        )
        return EXIT_SYNTAX
    except (ValueError, RecursionError) as exc:
        _write_json(
            {"error": "syntax", "line": 0, "col": 0, "msg": f"{type(exc).__name__}: {exc}"}
        )
        return EXIT_SYNTAX

    # Static scan only: the script is never executed and never imported.
    print(json.dumps({"lint": {"impure": _scan_impure(tree)}}, ensure_ascii=False))
    return EXIT_OK


_IMPURE_MODULES = ("socket", "requests", "urllib", "subprocess")


def _scan_impure(tree):
    impure = []
    seen = set()

    def add(item):
        if item not in seen:
            seen.add(item)
            impure.append(item)

    random_module_names = set()
    random_imported = False
    random_star = False
    os_module_names = set()
    os_star = False
    os_system_names = set()
    random_seed_names = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in _IMPURE_MODULES:
                    add(f"import {alias.name}")
                if root == "os":
                    if alias.asname:
                        if alias.name == "os":
                            os_module_names.add(alias.asname)
                    else:
                        os_module_names.add("os")
                elif root == "random":
                    random_imported = True
                    if alias.asname:
                        random_module_names.add(alias.asname)
                    else:
                        random_module_names.add(root)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                continue  # relative import: a local module, not the stdlib
            module = node.module or ""
            root = module.split(".")[0]
            if root in _IMPURE_MODULES:
                add(f"import {module}")
            elif root == "os":
                for alias in node.names:
                    bound = alias.asname or alias.name
                    if alias.name == "*":
                        os_star = True
                    elif alias.name == "system":
                        os_system_names.add(bound)
            elif root == "random":
                random_imported = True
                for alias in node.names:
                    bound = alias.asname or alias.name
                    if alias.name == "*":
                        random_star = True
                    elif alias.name == "seed":
                        random_seed_names.add(bound)

    seeded = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            owner = func.value.id
            if owner in os_module_names and func.attr == "system":
                add("os.system()")
            if owner in random_module_names and func.attr == "seed":
                seeded = True
        elif isinstance(func, ast.Name):
            if func.id == "open":
                add("open()")
            if func.id in os_system_names or (os_star and func.id == "system"):
                add("os.system()")
            if func.id in random_seed_names or (random_star and func.id == "seed"):
                seeded = True

    if random_imported and not seeded:
        add("random.* without seed()")
    return impure


# ── helpers ───────────────────────────────────────────────────────────


def _parse_args(argv):
    parser = _Parser(
        prog="runner.py",
        description="Clean-room runner for script cards (DCM2 in, DCM2 out).",
    )
    parser.add_argument(
        "--in", dest="in_dir", metavar="DIR", help="directory with ports.json and input frames"
    )
    parser.add_argument("--out", dest="out", metavar="FRAME", help="first output DCM2 frame")
    parser.add_argument("--meta", dest="meta", metavar="JSON", help="meta.json with script/outputs")
    parser.add_argument(
        "--check", dest="check", metavar="SCRIPT", help="only compile and lint the script"
    )
    args = parser.parse_args(argv)

    if args.check is not None:
        if args.in_dir is not None or args.out is not None or args.meta is not None:
            raise _UsageError("--check cannot be combined with --in/--out/--meta")
        return args

    missing = []
    for flag, value in (("--in", args.in_dir), ("--out", args.out), ("--meta", args.meta)):
        if value is None or value == "":
            missing.append(flag)
    if missing:
        raise _UsageError("missing required argument(s): " + ", ".join(missing))
    return args


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise _UsageError(message)


def _import_numpy():
    try:
        import numpy
    except Exception:
        return None
    return numpy


_pandas_cache = None


def _import_pandas():
    global _pandas_cache
    if _pandas_cache is None:
        try:
            import pandas
        except Exception:
            pandas = False
        _pandas_cache = pandas
    return None if _pandas_cache is False else _pandas_cache


def _is_masked(numpy, value):
    masked = getattr(numpy, "ma", None)
    if masked is None or not isinstance(value, masked.MaskedArray):
        return False
    try:
        return bool(masked.is_masked(value))
    except Exception:
        return True


def _describe_value(value):
    kind = type(value)
    if kind.__module__ == "builtins":
        return kind.__name__
    return f"{kind.__module__}.{kind.__qualname__}"


def _describe_array(arr, origin):
    shape = tuple(int(size) for size in arr.shape)
    return f"{origin}[dtype={arr.dtype}, shape={shape}]"


def _describe_dataframe(frame):
    columns = [str(column) for column in frame.columns[:6]]
    extra = "" if len(frame.columns) <= 6 else f", ... {len(frame.columns)} columns"
    return (
        f"pandas.DataFrame[index={type(frame.index).__name__}, "
        f"columns={columns}{extra}]"
    )


def _read_json(path, what):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise _UsageError(f"cannot read {what} {path!r}: {exc}")
    except ValueError as exc:
        raise _UsageError(f"{what} {path!r} is not valid JSON: {exc}")


def _write_json(payload):
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _human(message):
    sys.stderr.write(f"runner: {message}\n")


if __name__ == "__main__":
    sys.exit(main())