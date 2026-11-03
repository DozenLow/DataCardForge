# 更新日志

[English](CHANGELOG.md) | 中文

本项目的所有重要变更都记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

### 新增
- 后端多平台构建（Linux、macOS、Windows），每个平台都跑测试，见
  `.github/workflows/build-release.yml`
- 自动构建与发布工作流：推送 `v*` tag 时发布各平台产物，发布说明从本文件提取

### 变更
- 文档：移除已退役的「B 方案」代号，统一改为「后端持有计算」的直接表述
  （只动注释、文档与测试标题）
- CI：Pages 部署统一到 `static.yml`，删除重复的 `pages.yml`

### 修复
- `LICENSE`：第三方清单仍列着 2026-10-15 随 Qt UI 代码树移除的 Qt 6 / QCustomPlot / QXlsx /
  fast_float，现改为实际随项目分发的依赖

### 弃用

### 移除

### 安全

## [0.1.0] - 2026-10-31

### 新增
- C++ 后端初版实现
- 基于 CMake 的构建系统，支持 Ninja
- 核心库：json、matrix_store、matrix_value、expression、signature、summary、nodes
- 基于 CTest 的测试套件
- 与 Web 前端的集成

### 变更
- 改进构建配置与依赖管理

### 修复
- 通过嵌入 git SHA 保证构建可复现

[未发布]: https://github.com/teglaven/DataCardForge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/teglaven/DataCardForge/releases/tag/v0.1.0
