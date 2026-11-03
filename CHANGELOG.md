# Changelog

[English](CHANGELOG.md) | [中文](CHANGELOG.zh-CN.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
