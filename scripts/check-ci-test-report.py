#!/usr/bin/env python3
"""Fail if a required CI suite is missing, skipped, or not passing."""

import argparse
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET


PYTHON_TESTS = (
    "python_node", "script_check", "xlayer_fixture_node", "py_runner", "py_fixtures",
)
LIVE_SUITES = {
    "backendIntegration.test.ts": "live backend integration",
    "xlayerGoldenFrames.test.ts": "golden fixtures through the real client",
}


def check_ctest(report):
    errors = []
    rows = ET.parse(report).findall(".//testcase")
    for name in PYTHON_TESTS:
        matches = [row for row in rows if row.get("name") == name]
        if len(matches) != 1:
            errors.append(f"{name}: expected one CTest result, got {len(matches)}")
            continue
        row = matches[0]
        output = row.findtext("system-out", "")
        # Some of the C++ tests still print SKIP and return 0. CTest reports those as passed.
        if row.find("skipped") is not None or re.search(r"^\s*SKIP:", output, re.MULTILINE):
            errors.append(f"{name}: required test was skipped")
        elif row.get("status") != "run" or row.find("failure") is not None or row.find("error") is not None:
            errors.append(f"{name}: required test did not pass")
        else:
            print(f"{name}: executed and passed")
    return errors


def check_vitest(report):
    errors = []
    results = json.loads(report.read_text(encoding="utf-8"))["testResults"]
    for filename, suite in LIVE_SUITES.items():
        files = [result for result in results if Path(result["name"]).name == filename]
        if len(files) != 1:
            errors.append(f"{filename}: expected one Vitest file result, got {len(files)}")
            continue
        # Both files also contain offline tests. A passing offline test cannot satisfy this gate.
        tests = [test for test in files[0]["assertionResults"] if suite in test["ancestorTitles"]]
        if not tests:
            errors.append(f"{filename}: no tests reported under {suite!r}")
            continue
        not_passed = [test for test in tests if test["status"] != "passed"]
        for test in not_passed:
            errors.append(f"{filename}: {test['fullName']} ({test['status']})")
        if not not_passed:
            print(f"{filename}: {len(tests)} live tests executed and passed")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runner", choices=("ctest", "vitest"))
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    try:
        errors = (check_ctest if args.runner == "ctest" else check_vitest)(args.report)
    except (OSError, ValueError, ET.ParseError, KeyError, TypeError) as error:
        errors = [f"cannot read {args.runner} report {args.report}: {error}"]
    for error in errors:
        print(f"Required CI tests: {error}", file=sys.stderr)
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
