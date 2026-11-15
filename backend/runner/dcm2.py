#!/usr/bin/env python3
"""DCM2 binary matrix frame I/O (standard library + numpy only).

Frame layout, all fields little-endian, header is 24 bytes::

    magic      u32  = 0x44434D32 ("DCM2")
    rows       u32    rows in this frame
    cols       u32    columns in this frame
    namesLen   u32    byte length of the names JSON payload
    totalRows  u32    rows of the whole matrix
    totalCols  u32    columns of the whole matrix
    data       f64[rows*cols]   column-major
    names      namesLen bytes   UTF-8 JSON array of names

The frame length is always ``24 + rows*cols*8 + namesLen``. NaN travels
unchanged. ``read_frame`` returns a C-order float64 array (a copy), the names
list and the ``(totalRows, totalCols)`` pair; ``write_frame`` serializes the
inverse. A malformed frame raises :class:`Dcm2Error` with the reason and the
byte/field it came from.
"""

from __future__ import annotations

import json
import struct

import numpy as np

MAGIC = 0x44434D32  # "DCM2"
HEADER_LEN = 24
_HEADER = struct.Struct("<6I")
_U32_MAX = 0xFFFFFFFF


class Dcm2Error(ValueError):
    """Raised when a DCM2 frame is malformed or cannot be represented."""


def read_frame(path):
    """Read a DCM2 frame.

    Returns ``(arr, names, total)`` where ``arr`` is a C-order float64 ndarray,
    ``names`` is a list of str and ``total`` is ``(totalRows, totalCols)``.
    """
    with open(path, "rb") as fh:
        buf = fh.read()

    size = len(buf)
    if size < HEADER_LEN:
        raise Dcm2Error(
            f"{path}: frame is {size} bytes, shorter than the {HEADER_LEN}-byte header"
        )

    magic, rows, cols, names_len, total_rows, total_cols = _HEADER.unpack_from(buf, 0)
    if magic != MAGIC:
        raise Dcm2Error(
            f"{path}: bad magic 0x{magic:08X} (expected 0x{MAGIC:08X} 'DCM2')"
        )

    data_len = rows * cols * 8  # Python ints: cannot wrap for u32 fields
    expected = HEADER_LEN + data_len + names_len
    if size != expected:
        raise Dcm2Error(
            f"{path}: length mismatch: header says {rows}x{cols} f64 + "
            f"{names_len} name bytes = {expected} bytes, file is {size} bytes"
        )

    flat = np.frombuffer(buf, dtype="<f8", count=rows * cols, offset=HEADER_LEN)
    # Column-major on disk -> C-order in memory (the copy is writable and aligned
    # with what write_frame/ascontiguousarray expects).
    arr = flat.reshape((rows, cols), order="F").copy()

    raw_names = buf[HEADER_LEN + data_len:]
    names = _decode_names(path, raw_names, names_len)
    return arr, names, (int(total_rows), int(total_cols))


def write_frame(path, arr, names, *, total=None):
    """Write a DCM2 frame.

    ``arr`` is 1-D (one column) or 2-D real numeric data; it is stored as float64
    column-major. ``total`` defaults to the frame shape, which is what a full
    matrix uses; pass ``(totalRows, totalCols)`` for a window frame.
    """
    data, rows, cols = _as_matrix(path, arr)
    labels = _validate_names(path, names)

    if total is None:
        total_rows, total_cols = rows, cols
    else:
        if not isinstance(total, (tuple, list)) or len(total) != 2:
            raise Dcm2Error(f"{path}: total must be (totalRows, totalCols), got {total!r}")
        total_rows, total_cols = int(total[0]), int(total[1])
        for field, value in (("totalRows", total_rows), ("totalCols", total_cols)):
            if not 0 <= value <= _U32_MAX:
                raise Dcm2Error(f"{path}: {field}={value} does not fit in u32")

    names_bytes = json.dumps(labels, ensure_ascii=False).encode("utf-8")
    header = _HEADER.pack(MAGIC, rows, cols, len(names_bytes), total_rows, total_cols)
    body = data.tobytes(order="F")  # column-major data block

    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(body)
        fh.write(names_bytes)


def _decode_names(path, raw, names_len):
    if names_len == 0:
        return []
    try:
        names = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise Dcm2Error(f"{path}: names payload is not valid UTF-8 JSON ({exc})") from exc
    if not isinstance(names, list):
        raise Dcm2Error(
            f"{path}: names payload must be a JSON array, got {type(names).__name__}"
        )
    out = []
    for index, name in enumerate(names):
        if not isinstance(name, str):
            raise Dcm2Error(
                f"{path}: names[{index}] is {type(name).__name__}, expected str"
            )
        out.append(name)
    return out


def _validate_names(path, names):
    if not isinstance(names, (list, tuple)):
        raise Dcm2Error(
            f"{path}: names must be a list of str, got {type(names).__name__}"
        )
    labels = []
    for index, name in enumerate(names):
        if not isinstance(name, str):
            raise Dcm2Error(
                f"{path}: names[{index}] is {type(name).__name__}, expected str"
            )
        labels.append(name)
    return labels


def _as_matrix(path, arr):
    matrix = np.asarray(arr)
    kind = matrix.dtype.kind
    if kind not in "biuf":
        raise Dcm2Error(
            f"{path}: dtype {matrix.dtype} cannot be stored as an f64 frame "
            f"(only real numeric dtypes)"
        )
    if kind == "f" and matrix.dtype.itemsize > 8:
        raise Dcm2Error(
            f"{path}: dtype {matrix.dtype} is wider than float64 and would lose "
            f"precision when stored"
        )
    if matrix.ndim == 0:
        matrix = matrix.reshape(1, 1)
    elif matrix.ndim == 1:
        matrix = matrix.reshape(-1, 1)
    elif matrix.ndim != 2:
        raise Dcm2Error(
            f"{path}: frame data must be 1-D or 2-D, got ndim={matrix.ndim}"
        )

    rows, cols = int(matrix.shape[0]), int(matrix.shape[1])
    for field, value in (("rows", rows), ("cols", cols)):
        if value > _U32_MAX:
            raise Dcm2Error(f"{path}: {field}={value} does not fit in u32")
    data = np.ascontiguousarray(matrix, dtype=np.float64)
    return data, rows, cols