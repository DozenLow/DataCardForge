# Changelog

[English](CHANGELOG.md) | [中文](CHANGELOG.zh-CN.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-04

### Added
- The table prints every number at its **shortest round-trip precision** instead of six
  significant digits. Six digits could not separate a column of measurements centred on
  1e6 — 3000 distinct rows rendered as 3000 copies of `1e+6` — so the table now shows what
  is stored. Columns are sized from a sample of their values, and every cell keeps
  a tooltip with the full text.
- Formula cards report **rounding jitter** for their output, three seconds after the
  definition stops changing. It is measured, not guessed: the backend re-runs the same node
  with its rows in another order — the exact answer cannot change, the rounding can — and
  reports the gap. It is a sample rather than a bound, so the card says *no jitter detected*
  and never *accurate*, and it stays silent whenever the backend declines to measure.

### Fixed
- The packaged exe opened neither a browser nor a terminal when double-clicked. It was one bug,
  not two: the launch was gated on `isatty(stdout)`, and a process that Windows did not start
  from a shell has **no console at all** — so the status lines went into a dead handle (the
  window never appeared) and the browser launch was skipped while the server itself was running
  fine. The backend now allocates a console window when it has none (re-binding
  stdin/stdout/stderr to it), prints the address into it and into the window title, and opens
  the browser through `ShellExecuteW` instead of `system("start …")` — no `cmd.exe` in the path,
  and a refusal is reported instead of ignored. The window now stays open for 15 s after a
  startup failure so the message can be read, a busy port names both the URL to open and a free
  port to try, and `--open` / `DC_OPEN=1` force the browser from a non-TTY context. The exe stays
  a console image, asserted on the exact bytes that go into the zip by
  `scripts/check-pe-subsystem.py`; the rule itself is covered by the `ui_launch` ctest gate
- Wires were still erased outside a single screenful: the connection mask never declared its own
  region, so `<mask>` fell back to its default `-10% / 120%` of the SVG viewport — which
  `maskUnits="userSpaceOnUse"` resolves in *plane* coordinates. The white backdrop rect inside it
  was cropped by that implicit box, and anything outside the box is masked to alpha 0, so the
  wire was erased rather than clipped: below 100% zoom (or after panning away from the plane
  origin) the dashed line stopped in mid-air while its target card was still on screen. The
  region is now stated explicitly (`MASK_EXTENT`) and matches the backdrop. Regression test:
  `ConnectionLayer.dom.test.tsx` → "states a mask region that covers the plane"

## [0.1.2] - 2026-11-03

### Fixed
- Connections were clipped by the connection layer's own SVG viewport: below 100% zoom the
  box covered only one screenful of *plane* units, so a wire leaving that area stopped in
  mid-air and distant card pairs looked unconnected. The layer now lets its content overflow;
  the canvas viewport is the only clip
- The Windows archives could not start on a stock Windows machine: the exe still imported
  MinGW's `libstdc++-6.dll` / `libgcc_s_seh-1.dll` / `libwinpthread-1.dll`, so Windows resolved a
  mismatched copy from `PATH` and died with "the procedure entry point ...`do_unshift`... could
  not be located in `dc_backend.exe`" (mingw-w64's UCRT and MSVCRT libstdc++ builds do not even
  spell `mbstate_t` the same way, so an identical version number is not interchangeable). The
  runtime is now linked into the exe with `-static`, and the Windows CI jobs fail the build if a
  MinGW DLL reappears in the import table

## [0.1.1] - 2026-11-03

### Added
- The backend can serve the built front end from the same loopback origin (`--web-root`, auto-detected
  next to the binary), so a release archive is now "unzip and run": the UI opens at
  `http://127.0.0.1:37811/` with no Node, no dev server and no cross-origin problem
- `--no-open` (or `DC_NO_OPEN=1`): suppresses the automatic browser launch; it is skipped by itself
  whenever stdout is not a TTY, so CI and ctest never pop a window
- `Asserts` build tier (`-O2 -g`, `NDEBUG` left undefined): near-Release speed with Eigen's
  assertions on — this is the tier shipped as the recommended download
- Test `static_paths`: traversal, backslashes, NUL bytes, extension allow-list, SPA fallback
- Multi-platform backend builds (Linux, macOS, Windows) with tests on every platform,
  via `.github/workflows/build-release.yml`
- Automated build-and-release workflow: pushing a `v*` tag publishes the platform
  artifacts with release notes extracted from this file
- Release pages now explain every asset (`standard` / `fullperformance` / `debug`),
  and ship `README.txt` + `SHA256SUMS.txt` next to the archives

### Changed
- Release assets are named `standard` / `fullperformance` / `debug` and ship as
  `datacardforge-<os>-<tier>.zip`: the recommended download carries assertions,
  `fullperformance` is the benchmark tier, and `debug` is only built for tags
- Linux and macOS release binaries carry their C++ runtime statically
  (`-static-libstdc++ -static-libgcc`), so installing the packages requires no extra runtime
- Documentation: the retired "B-plan" codename was replaced by the plain
  "backend-owned compute" wording (comments, docs and test titles only)
- CI: Pages deployment consolidated on `static.yml`; the duplicate `pages.yml` was removed

### Fixed
- `LICENSE`: third-party section still listed the Qt-era stack (Qt 6, QCustomPlot,
  QXlsx, fast_float) removed on 2026-10-15; it now lists the shipped dependencies

### Deprecated

### Removed

### Security

## [0.1.0] - 2026-10-31

### Added
- Initial C++ backend implementation
- CMake-based build system with Ninja support
- Core libraries: json, matrix_store, matrix_value, expression, signature, summary, nodes
- Test suite with CTest
- Integration with web frontend

### Changed
- Improved build configuration with proper dependency management

### Fixed
- Build reproducibility with git SHA embedding

[Unreleased]: https://github.com/DozenLow/DataCardForge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/DozenLow/DataCardForge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DozenLow/DataCardForge/releases/tag/v0.1.0
