#!/usr/bin/env python3
"""Exercise the CI report checker as a command, including its nonzero exit status."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET


CHECKER = Path(__file__).with_name("check-ci-test-report.py")
PYTHON_NAMES = ("python_node", "script_check", "xlayer_fixture_node", "py_runner", "py_fixtures")


def vitest_file(name, suite, status="passed"):
    return {"name": f"tests/{name}", "assertionResults": [
        {"ancestorTitles": ["offline"], "status": "passed", "fullName": "offline test"},
        {"ancestorTitles": [suite], "status": status, "fullName": "live case"},
    ]}


class ReportGate(unittest.TestCase):
    def run_checker(self, runner, contents, error=None):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "report"
            report.write_text(contents, encoding="utf-8")
            result = subprocess.run([sys.executable, CHECKER, runner, report], capture_output=True, text=True)
        self.assertEqual(result.returncode, int(error is not None), result.stdout + result.stderr)
        if error is not None:
            self.assertIn(error, result.stderr)

    def test_ctest_pass_and_expected_opt_in_skip(self):
        root = self.ctest_report()
        ET.SubElement(ET.SubElement(root, "testcase", name="perf_gate", status="notrun"), "skipped")
        self.run_checker("ctest", ET.tostring(root, encoding="unicode"))

    def test_ctest_missing_and_both_skip_forms(self):
        for kind in ("absent", "skipped", "silent skip", "failure"):
            with self.subTest(kind=kind):
                root = self.ctest_report()
                first = root[0]
                if kind == "absent":
                    root.remove(first)
                elif kind == "silent skip":
                    ET.SubElement(first, "system-out").text = "setup complete\nSKIP: no vendored runtime"
                else:
                    ET.SubElement(first, kind)
                self.run_checker("ctest", ET.tostring(root, encoding="unicode"), "python_node:")

    @staticmethod
    def ctest_report():
        root = ET.Element("testsuite")
        for name in PYTHON_NAMES:
            ET.SubElement(root, "testcase", name=name, status="run")
        return root

    def test_vitest_live_pass(self):
        self.run_checker("vitest", json.dumps({"testResults": self.vitest_report()}))

    def test_vitest_missing_empty_and_skipped_even_with_passing_offline_cases(self):
        for kind in ("missing", "empty", "skipped", "failed"):
            with self.subTest(kind=kind):
                files = self.vitest_report()
                if kind == "missing":
                    files.pop()
                elif kind == "empty":
                    files[-1]["assertionResults"].pop()
                else:
                    files[-1]["assertionResults"][-1]["status"] = kind
                self.run_checker("vitest", json.dumps({"testResults": files}), "xlayerGoldenFrames.test.ts:")

    @staticmethod
    def vitest_report():
        return [
            vitest_file("backendIntegration.test.ts", "live backend integration"),
            vitest_file("xlayerGoldenFrames.test.ts", "golden fixtures through the real client"),
        ]


if __name__ == "__main__":
    unittest.main()
