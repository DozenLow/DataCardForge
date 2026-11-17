# Run one Python-layer suite under the vendored runtime.
#
# Registered from backend/CMakeLists.txt so every platform shows the suite in `ctest`:
#   runtime present -> run it, and the interpreter's exit code is the verdict
#   runtime absent  -> print SKIP and exit 0 (the same contract the C++ Python tests
#                      implement: "not applicable" and "verified" must not look the same)
#
# Plain `cmake -P` instead of `bash -c` on purpose: a POSIX shell is not part of the test
# surface. On a Windows runner `bash` can resolve to the WSL launcher, which exits non-zero
# with "Windows Subsystem for Linux has no installed distributions" — a failure that says
# nothing about the runner.
#
# The interpreter is resolved by the same rule as resolvePythonRuntime()
# (backend/src/nodes.cpp): <runtime>/bin/python3, or <runtime>/bin/python.exe on Windows.
#
# Usage: cmake -DSUITE=test_runner.py -P backend/tests/run_py_suite.cmake

if(NOT DEFINED SUITE OR SUITE STREQUAL "")
  message(FATAL_ERROR "run_py_suite: pass -DSUITE=<file under backend/tests/py>")
endif()

get_filename_component(repo_root "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)

if(WIN32)
  set(python "${repo_root}/third_party/pyruntime/bin/python.exe")
  set(path_sep ";")
else()
  set(python "${repo_root}/third_party/pyruntime/bin/python3")
  set(path_sep ":")
endif()

if(NOT EXISTS "${python}")
  message("SKIP: ${SUITE} (no ${python}; run scripts/fetch-python-runtime.sh)")
  return()
endif()

# Set PYTHONPATH in this process so the child inherits it as a single value: passing it on
# the command line would make `;` a list separator on Windows rather than part of the path.
set(ENV{PYTHONPATH} "${repo_root}/third_party/pylib${path_sep}${repo_root}/backend/runner")

execute_process(
  COMMAND "${python}" "${repo_root}/backend/tests/py/${SUITE}"
  WORKING_DIRECTORY "${repo_root}"
  RESULT_VARIABLE suite_exit)

if(NOT suite_exit EQUAL 0)
  message(FATAL_ERROR "${SUITE} failed (exit ${suite_exit})")
endif()
