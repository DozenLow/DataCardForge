# Changelog

[English](CHANGELOG.md) | [中文](CHANGELOG.zh-CN.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Release pages now explain every asset (`standard` / `perf` / `debug`),
  and ship `README.txt` + `SHA256SUMS.txt` next to the archives

### Changed
- Release assets are named `standard` / `perf` / `debug`: the recommended download carries
  assertions, `perf` is the benchmark tier, and `debug` is only built for tags
- Release binaries carry their C++ runtime statically (Linux `-static-libstdc++ -static-libgcc`,
  Windows `/MT`), so installing the packages requires no extra runtime
- Documentation: the retired "B-plan" codename was replaced by the plain
  "backend-owned compute" wording (comments, docs and test titles only)
- CI: Pages deployment consolidated on `static.yml`; the duplicate `pages.yml` was removed

### Fixed
- `LICENSE`: third-party section still listed the Qt-era stack (Qt 6, QCustomPlot,
  QXlsx, fast_float) removed on 2026-10-15; it now lists the shipped dependencies

### Deprecated

### Removed

### Security

### Release assets — what the three tiers mean

Every archive is the backend binary **plus a `web/` directory**: unzip it, run it, and the UI opens
at `http://127.0.0.1:37811/` from the same origin. Nothing else has to be installed.

| Archive | Build | Speed | Assertions | Pick it when |
|---|---|---|---|---|
| `dc_backend-<os>-standard.zip` | `-O2 -g`, `NDEBUG` undefined | ~90% of `perf` | **on** | the default: a wrong result stops at the violated contract instead of being reported as a number |
| `dc_backend-<os>-perf.zip` | `-O3 -DNDEBUG` | 100% | off | benchmarks, or when the last ~10% matters |
| `dc_backend-<os>-debug.zip` | `-O0 -g` | 10–50% | on | reproducing a defect under a debugger; built for tags only |

Compared with 0.1.0 the binaries now also carry their C++ runtime statically and serve the UI
themselves — 0.1.0 shipped a bare API-only executable.

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
