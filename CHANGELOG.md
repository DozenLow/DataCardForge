# Changelog

[English](CHANGELOG.md) | [中文](CHANGELOG.zh-CN.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Multi-platform backend builds (Linux, macOS, Windows) with tests on every platform,
  via `.github/workflows/build-release.yml`
- Automated build-and-release workflow: pushing a `v*` tag publishes the platform
  artifacts with release notes extracted from this file

### Changed
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

[Unreleased]: https://github.com/DozenLow/DataCardForge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DozenLow/DataCardForge/releases/tag/v0.1.0
