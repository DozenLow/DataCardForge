#!/usr/bin/env python3
"""Fail unless every given Windows PE image is a CONSOLE application.

Why this is a gate and not a comment: the shipped exe has to show a window when it is
double-clicked, because that window is where the listening address appears and it is the
only proof a user gets that anything started. A GUI-subsystem image (WIN32_EXECUTABLE /
-mwindows) starts with *no console at all*: printf writes into a dead handle and
`isatty(stdout)` is false, so the browser launch was silently skipped as well. That is
exactly the report this gate keeps from shipping again: "clicking the exe opens neither a
browser nor a terminal".

Backend/src/main.cpp also allocates a console when one is missing, so a launcher that hides
it cannot break the status output either — but the subsystem is the cheap first-line
guarantee and it is decided at link time, which is why it is checked on the built artifact.

Usage:  scripts/check-pe-subsystem.py <file.exe> [<file.exe> ...]
"""

import struct
import sys

CONSOLE = 3
SUBSYSTEM_NAMES = {1: "native", 2: "GUI", 3: "console", 5: "OS/2", 7: "POSIX", 9: "EFI"}

# Offset of Subsystem inside IMAGE_OPTIONAL_HEADER32/64: both layouts agree up to this field,
# and PE32+ (0x20b) only differs after it.
SUBSYSTEM_OFFSET = 68


def subsystem_of(path: str) -> int:
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise ValueError(f"{path}: not a DOS/PE image (missing MZ header)")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe : pe + 4] != b"PE\0\0":
        raise ValueError(f"{path}: not a PE image (missing PE signature at 0x{pe:x})")
    return struct.unpack_from("<H", data, pe + 24 + SUBSYSTEM_OFFSET)[0]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    failed = 0
    for path in argv[1:]:
        try:
            subsystem = subsystem_of(path)
        except (OSError, ValueError) as exc:
            print(f"::error::{exc}")
            failed = 1
            continue
        name = SUBSYSTEM_NAMES.get(subsystem, f"unknown({subsystem})")
        if subsystem == CONSOLE:
            print(f"ok: {path} is a console image (subsystem {subsystem})")
        else:
            print(
                f"::error::{path} is a {name} image (subsystem {subsystem}), expected a console "
                "image (subsystem 3): double-clicking it would open no window and no browser"
            )
            failed = 1
    return failed


if __name__ == "__main__":
    sys.exit(main(sys.argv))
