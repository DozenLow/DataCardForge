cmake_minimum_required(VERSION 3.24)
project(dcb_backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# ── diagnostic build tier ──────────────────────────────────────────────
# "Asserts": optimized like Release but with NDEBUG left undefined, which is what turns
# Eigen's eigen_assert back on (it is decided per translation unit from NDEBUG). This is the
# tier shipped as the recommended download: near-Release speed, but it stops at the first
# violated contract instead of quietly computing a wrong number. -O2 rather than -O3 because
# the assertion branches make -O3 rarely worth the build time.
set(CMAKE_CXX_FLAGS_ASSERTS "-O2 -g -fno-omit-frame-pointer" CACHE STRING
    "Flags for the Asserts build type")
set(CMAKE_EXE_LINKER_FLAGS_ASSERTS "" CACHE STRING "Linker flags for the Asserts build type")

find_package(Eigen3 REQUIRED NO_MODULE)
find_package(Threads REQUIRED)

# ── Windows runtime: link everything into the exe ───────────────────────
# A MinGW-built exe imports libstdc++-6.dll, libgcc_s_seh-1.dll and libwinpthread-1.dll by
# default, and a stock Windows machine has none of them. The failure the 0.1.1 Windows zip
# produced is the nastier half of that: the exe *finds* some unrelated libstdc++-6.dll on PATH
# (shipped by another tool) and dies with "the procedure entry point ... could not be located
# in dc_backend.exe". Matching the version is not enough either — mingw-w64 ships two
# incompatible flavours of libstdc++ (UCRT and MSVCRT builds spell mbstate_t differently, so
# even the same GCC version exports different symbol names, which is what
# ...do_unshiftER9_Mbstatet... reveals). The only safe target is "imports nothing but Windows
# system DLLs". `-static` is used rather than just -static-libstdc++/-static-libgcc because it
# must cover winpthread too (std::thread). This mirrors what the Linux jobs pass to the linker.
# The rule below lives here rather than only in the workflow: it was passed from the workflow
# once as -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded, which is meaningless for MinGW, so the
# release notes claimed a self-contained binary while the shipped exe still needed DLLs.
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
if(UNIX AND NOT APPLE)
  # Same guarantee on Linux: libstdc++/libgcc into the binary (macOS ships libc++ itself).
  add_link_options(-static-libstdc++ -static-libgcc)
endif()

if(MINGW)
  add_link_options(-static -static-libgcc -static-libstdc++)
endif()

# ── build id ───────────────────────────────────────────────────────────
# `/api/hello` reports the commit the binary was built from, so the value has to be produced
# by the BUILD, not by the configure step: a configure-time `git rev-parse` freezes at the
# first `cmake -S`, and then a stale id makes a current binary look like an old one (that is
# how `build=c7f01b6` was read as "the new engine is not deployed"). A generated header keeps
# the value in the binary (no shelling out at runtime) and depends on the git refs, so a new
# commit re-generates it.
set(DC_SHA_HEADER ${CMAKE_BINARY_DIR}/generated/build_sha.h)
set(DC_SHA_SCRIPT ${CMAKE_SOURCE_DIR}/scripts/write-build-sha.sh)
set(DC_SHA_DEPS ${DC_SHA_SCRIPT})
foreach(dep
    ${CMAKE_SOURCE_DIR}/../.git/HEAD
    ${CMAKE_SOURCE_DIR}/../.git/refs/heads/main
    ${CMAKE_SOURCE_DIR}/../.git/packed-refs)
  if(EXISTS ${dep})
    list(APPEND DC_SHA_DEPS ${dep})
  endif()
endforeach()
add_custom_command(
  OUTPUT ${DC_SHA_HEADER}
  COMMAND sh ${DC_SHA_SCRIPT} ${CMAKE_SOURCE_DIR}/.. ${DC_SHA_HEADER}
  DEPENDS ${DC_SHA_DEPS}
  COMMENT "Baking build sha into generated/build_sha.h"
  VERBATIM)
add_custom_target(dc_build_sha DEPENDS ${DC_SHA_HEADER})

add_library(dc_core
  src/json.cpp
  src/matrix_store.cpp
  src/matrix_value.cpp
  src/expression.cpp
  src/signature.cpp
  src/summary.cpp
  src/nodes.cpp
)
target_include_directories(dc_core PUBLIC src)
target_link_libraries(dc_core PUBLIC Eigen3::Eigen)

# Static file serving lives beside the HTTP layer, not in the compute core: it is packaging
# glue, and keeping it separate means the path rules can be tested without a socket.
add_library(dc_static STATIC src/static_files.cpp)
target_include_directories(dc_static PUBLIC src)

add_executable(dc_backend src/http_server.cpp src/main.cpp ${DC_SHA_HEADER})
target_include_directories(dc_backend PRIVATE ${CMAKE_BINARY_DIR}/generated)
add_dependencies(dc_backend dc_build_sha)
target_link_libraries(dc_backend PRIVATE dc_core dc_static Threads::Threads)
if(WIN32)
  target_link_libraries(dc_backend PRIVATE ws2_32)
endif()

# Fixture runner: the same xlayer JSON that gates the TS reference (stage-0 contract).
add_executable(dc_fixture_run tests/fixture_runner.cpp)
target_link_libraries(dc_fixture_run PRIVATE dc_core)

enable_testing()
add_test(NAME xlayer_fixtures
  COMMAND dc_fixture_run ${CMAKE_SOURCE_DIR}/../web/tests/fixtures/xlayer/expression.v1.json)
add_test(NAME matrix_fixtures
  COMMAND dc_fixture_run ${CMAKE_SOURCE_DIR}/../web/tests/fixtures/xlayer/matrix.v1.json)

add_executable(dc_nodes_test tests/nodes_test.cpp)
target_link_libraries(dc_nodes_test PRIVATE dc_core)
add_test(NAME node_registry COMMAND dc_nodes_test)

# Path rules for the packaged UI: traversal, allow-listed extensions, SPA fallback.
add_executable(dc_static_test tests/static_path_test.cpp)
target_link_libraries(dc_static_test PRIVATE dc_static)
add_test(NAME static_paths COMMAND dc_static_test)

# Card-layer fixtures: the SAME JSON the TypeScript side parses
# (web/tests/cardFixtures.test.ts). TS judges how a card becomes port bindings; this judges
# what those bindings compute. Together they are the referee the v2 schema decision demands.
add_executable(dc_card_fixture_run tests/card_fixture_run.cpp)
target_link_libraries(dc_card_fixture_run PRIVATE dc_core)
add_test(NAME card_fixtures
  COMMAND dc_card_fixture_run ${CMAKE_SOURCE_DIR}/../web/tests/fixtures/cards/function-card.v2.json)

# Engine-layer perf gate (docs/decisions/2026-10-29-perf-gate.md): dc_bench calls
# ExprEngine::evaluate / evaluateMatrix directly — no HTTP, no server, no service restarts.
# Opt-in like diff_fuzz / nodes_stress: without DC_RUN_BENCH=1 the binary itself exits 101 and
# ctest records "Not Run" (SKIP_RETURN_CODE), so CI stays fast and deterministic. No Python
# needed: the gate is a self-contained C++17 binary linked against dc_core.
add_executable(dc_bench bench/bench_engine.cpp)
target_link_libraries(dc_bench PRIVATE dc_core)
add_test(NAME perf_gate COMMAND dc_bench)
set_tests_properties(perf_gate PROPERTIES SKIP_RETURN_CODE 101)

# Both opt-in gates below need a Python interpreter, and find_package must run BEFORE
# the add_test calls that expand ${Python3_EXECUTABLE} — otherwise the variable is empty,
# the command degenerates to the bare script path, and ctest fails with BAD_COMMAND
# ("permission denied"). Learned the hard way while wiring the fuzz gate.
find_package(Python3 COMPONENTS Interpreter QUIET)

# Differential fuzz: random expressions evaluated by BOTH engines (C++ here, the TS
# reference via web/scripts/diff_fuzz.mjs importing src/core/expression.ts itself), with
# numeric results AND structured errors (code/position/params) compared. Fixed fixtures
# cover hand-written cases; this keeps discovering new divergences. Opt-in like http_stress:
# without DC_RUN_FUZZ=1 the gate exits 101 and ctest records "Not Run" — CI stays fast and
# deterministic. Seeds are explicit (--seed); divergences print a minimal repro.
add_executable(dc_diff_run tests/diff_run.cpp)
target_link_libraries(dc_diff_run PRIVATE dc_core)
if(Python3_Interpreter_FOUND)
  add_test(NAME diff_fuzz
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/fuzz_gate.py
            --script ${CMAKE_SOURCE_DIR}/../web/scripts/diff_fuzz.mjs
            --cpp-bin $<TARGET_FILE:dc_diff_run> --iters 2000)
  set_tests_properties(diff_fuzz PROPERTIES SKIP_RETURN_CODE 101)
endif()

# Stress gate: hammer the HTTP server with malformed requests and assert the process
# survives (the 2026-10-18 audit found std::stoul terminating the whole process from a
# detached connection thread). Opt-in via DC_RUN_STRESS=1 so CI stays fast: without it
# the script exits 101 and ctest records "Not Run" instead of a silent pass. It always
# binds a throwaway port — never 37811, where the default service port lives.
if(Python3_Interpreter_FOUND)
  # Node-registry concurrency (2026-10-27): evaluation no longer holds the registry lock,
  # so concurrent create / params-rewrite / window-read / delete must not deadlock, crash,
  # or publish a result whose definition was replaced mid-computation. Same opt-in gate.
  add_test(NAME nodes_stress
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/stress/nodes_stress.py
            --binary $<TARGET_FILE:dc_backend> --threads 8 --rounds 25)
  set_tests_properties(nodes_stress PROPERTIES SKIP_RETURN_CODE 101)

  add_test(NAME http_stress
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/stress/stress_test.py
            --binary $<TARGET_FILE:dc_backend> --port 37911
            --rounds 2 --threads 20 --requests 5)
  set_tests_properties(http_stress PROPERTIES SKIP_RETURN_CODE 101)
endif()
