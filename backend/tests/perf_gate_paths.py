#!/usr/bin/env python3
"""ctest regression for perf_gate's default budget/baseline PATH resolution (opt-in).

Without DC_RUN_BENCH=1 this exits 101 so ctest records "Not Run" — same tier as
perf_gate itself. With it, these checks run from a throwaway NESTED working directory
(the depth of backend/build/<subdir>, where the old relative probe missed backend/bench
and the gate failed as "missing budgets" although the files ship with the repo):

  1. opt-in skip still works (no DC_RUN_BENCH -> exit 101);
  2. default paths resolve: dc_bench reaches its budget/baseline verdict (exit 0 or 1 —
     which one is the machine's speed, NOT the path), never the exit-2 "读不到预算/基线";
  3. fail closed on a genuinely missing budgets OR baseline file: exit 2, the message
     names the ABSOLUTE path tried (a relative --budgets/--baseline input must be
     actively absolutized, not echoed back) and the flag that supplies a pre-approved
     input, and never suggests re-taking a baseline with the code under verification.

The tracked baseline.json / budgets.json must come out byte-identical: this test never
passes --update-baseline or --json, and asserts that invariant instead of trusting it.
No budgets or baselines are created, no threshold is touched, nothing is scheduled.
"""
import argparse
import os
import pathlib
import subprocess
import sys
import tempfile

SKIP = 101


def run_bench(cpp_bin: str, cwd: str, env: dict, extra: list) -> subprocess.CompletedProcess:
    return subprocess.run(
        [cpp_bin, "--case", "elem.add", *extra],
        cwd=cwd, env=env, capture_output=True, text=True, timeout=120,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cpp-bin", required=True, help="dc_bench path")
    ap.add_argument("--bench-dir", required=True, help="source backend/bench directory")
    args = ap.parse_args()

    if os.environ.get("DC_RUN_BENCH") != "1":
        print("SKIP perf_gate_paths: set DC_RUN_BENCH=1 to enable (opt-in, keeps CI fast)")
        return SKIP

    bench_dir = pathlib.Path(args.bench_dir).resolve()
    tracked = {name: (bench_dir / name).read_bytes() for name in ("baseline.json", "budgets.json")}
    base_env = {**os.environ, "DC_RUN_BENCH": "1"}

    with tempfile.TemporaryDirectory(prefix="perf-gate-paths.") as tmp:
        # Mimic the nested independent-build depth: <tmp>/build/<subdir>. Canonicalize
        # so the expected absolute path below equals the child's getcwd()-based one.
        nested = pathlib.Path(tmp) / "build" / "subdir"
        nested.mkdir(parents=True)
        cwd = str(nested.resolve())

        # 1. The opt-in skip is unchanged, whatever the CWD.
        skip_env = {k: v for k, v in base_env.items() if k != "DC_RUN_BENCH"}
        proc = run_bench(args.cpp_bin, cwd, skip_env, [])
        if proc.returncode != SKIP:
            print(f"FAIL: without DC_RUN_BENCH expected exit {SKIP}, got {proc.returncode}\n{proc.stderr}")
            return 1

        # 2. Default paths resolve from the nested CWD: the gate must reach its verdict.
        proc = run_bench(args.cpp_bin, cwd, base_env, [])
        if proc.returncode not in (0, 1) or "读不到预算" in proc.stderr or "读不到基线" in proc.stderr:
            print(f"FAIL: default budgets/baseline not found from {cwd} "
                  f"(exit {proc.returncode})\n{proc.stderr}")
            return 1
        print(f"ok: default paths resolved from nested CWD (verdict exit {proc.returncode})")

        # 3. Fail closed on a genuinely missing file, say WHERE it looked (absolute),
        #    and point at the flag supplying a pre-approved input — never at re-taking
        #    a baseline with the code under verification.
        real_baseline = str(bench_dir / "baseline.json")
        real_budgets = str(bench_dir / "budgets.json")

        def expect_missing(flag: str, given: str, expected_abs: str, other: list) -> bool:
            proc = run_bench(args.cpp_bin, cwd, base_env, [flag, given, *other])
            if (proc.returncode != 2 or expected_abs not in proc.stderr
                    or flag not in proc.stderr or "--update-baseline" in proc.stderr):
                print(f"FAIL: {flag} {given} must exit 2, name {expected_abs} and {flag}, "
                      f"and not suggest --update-baseline (exit {proc.returncode})\n{proc.stderr}")
                return False
            return True

        # Explicit absolute input: the message names that same absolute path.
        missing_abs = str(pathlib.Path(tmp) / "missing-budgets.json")
        if not expect_missing("--budgets", missing_abs, missing_abs, ["--baseline", real_baseline]):
            return 1
        print("ok: missing budgets fail closed with the absolute path in the message")

        # Relative input from the nested CWD: the gate must ACTIVELY absolutize it —
        # a relative path in, the real absolute path out — for budgets and baseline alike.
        for flag, other in (("--budgets", ["--baseline", real_baseline]),
                            ("--baseline", ["--budgets", real_budgets])):
            rel = f"missing-{flag[2:]}.json"
            expected = os.path.join(cwd, rel)
            if not expect_missing(flag, rel, expected, other):
                return 1
            print(f"ok: relative {flag} path absolutized to {expected}, fail closed")

    for name, before in tracked.items():
        if (bench_dir / name).read_bytes() != before:
            print(f"FAIL: {name} was modified by the gate run")
            return 1
    print("ok: tracked baseline/budgets unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
