# Contract gate for the Python suite registration (backend/CMakeLists.txt).
#
# Two things used to be true and silent:
#   1. tests/run_py_suite.cmake ignored DC_PYRUNTIME, so a runner whose interpreter lives
#      outside the checkout printed SKIP while the C++ tests that honour the override ran.
#   2. CTest counted that SKIP as a PASS, so "not applicable" and "verified" looked identical.
#
# Both are observable from outside the build: point DC_PYRUNTIME at a path that has no
# interpreter. The override must win (SKIP mentions DC_PYRUNTIME, and the vendored runtime in
# the checkout is NOT used), and CTest must report the test as Skipped rather than Passed.
# Then point it at the vendored runtime: the suites must actually run and Pass, which proves
# the override is what selects the interpreter.
#
# Usage: cmake -DBUILD_DIR=<build tree> -DCTEST_COMMAND=<ctest> \
#              -DVENDORED_RUNTIME=<repo>/third_party/pyruntime \
#              -P backend/tests/py_suite_contract.cmake

foreach(var BUILD_DIR CTEST_COMMAND VENDORED_RUNTIME)
  if(NOT DEFINED ${var})
    message(FATAL_ERROR "py_suite_contract: pass -D${var}=<value>")
  endif()
endforeach()

set(suite_regex "^py_(fixtures|runner)$")
set(bogus_runtime "${BUILD_DIR}/py_suite_contract-no-such-runtime")

function(run_ctest runtime out_var)
  set(ENV{DC_PYRUNTIME} "${runtime}")
  execute_process(
    # -V: the skip message is on the test's own stdout, which CTest only shows verbosely.
    COMMAND "${CTEST_COMMAND}" --test-dir "${BUILD_DIR}" -R "${suite_regex}" -V
    OUTPUT_VARIABLE out ERROR_VARIABLE err RESULT_VARIABLE rc)
  set("${out_var}" "${out}${err}" PARENT_SCOPE)
  set("${out_var}_rc" "${rc}" PARENT_SCOPE)
endfunction()

# 1) A missing override must skip, and must not fall back to the checkout's copy.
run_ctest("${bogus_runtime}" skip_out)
if(NOT skip_out_rc EQUAL 0)
  message(FATAL_ERROR "py_suite_contract: ctest exited ${skip_out_rc} on the skip path:\n${skip_out}")
endif()
if(NOT skip_out MATCHES "SKIP: .*DC_PYRUNTIME=")
  message(FATAL_ERROR
    "py_suite_contract: a missing DC_PYRUNTIME did not reach the skip branch that reports the "
    "override — run_py_suite.cmake is ignoring DC_PYRUNTIME again:\n${skip_out}")
endif()
if(skip_out MATCHES "Passed")
  message(FATAL_ERROR
    "py_suite_contract: the skipped suite was reported as Passed, so 'not applicable' is "
    "indistinguishable from 'verified' — SKIP_REGULAR_EXPRESSION is missing:\n${skip_out}")
endif()
if(NOT skip_out MATCHES "Skipped")
  message(FATAL_ERROR
    "py_suite_contract: CTest did not mark the skipped suite as Skipped:\n${skip_out}")
endif()

# 2) With a real override the suites must run. Only meaningful when the runtime is present:
#    CI fetches it on a best-effort basis, and the checkout may legitimately not have it.
if(EXISTS "${VENDORED_RUNTIME}/bin/python3" OR EXISTS "${VENDORED_RUNTIME}/bin/python.exe")
  run_ctest("${VENDORED_RUNTIME}" run_out)
  if(NOT run_out_rc EQUAL 0)
    message(FATAL_ERROR
      "py_suite_contract: the suites failed when DC_PYRUNTIME pointed at the vendored "
      "runtime (exit ${run_out_rc}):\n${run_out}")
  endif()
  if(run_out MATCHES "Skipped")
    message(FATAL_ERROR
      "py_suite_contract: DC_PYRUNTIME=${VENDORED_RUNTIME} was ignored — the suite skipped "
      "even though an interpreter exists there:\n${run_out}")
  endif()
  if(NOT run_out MATCHES "Passed")
    message(FATAL_ERROR "py_suite_contract: the suites did not pass:\n${run_out}")
  endif()
else()
  message("NOTE: no vendored runtime at ${VENDORED_RUNTIME}; the override path was not exercised")
endif()

message(STATUS "py_suite_contract: DC_PYRUNTIME is honoured and SKIP is not reported as PASS")