# 更新日志

[English](CHANGELOG.md) | 中文

本项目的所有重要变更都记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 未发布

## [0.1.1] - 2026-11-03

### 新增
- 后端可在同源提供前端产物（`--web-root`，默认在二进制旁边自动探测），发行包变成「解压即可跑」：
  打开 `http://127.0.0.1:37811/` 就是界面，不需要 Node、不需要 dev server、没有跨域问题
- `--no-open`（或 `DC_NO_OPEN=1`）关闭自动开浏览器；stdout 不是 TTY 时自动不开，所以 CI 与 ctest 不会弹窗
- 新增 `Asserts` 构建档（`-O2 -g`，不定义 `NDEBUG`）：接近正式版速度且 Eigen 断言全开，作为发行页的推荐下载
- 新增测试 `static_paths`：路径穿越、反斜杠、NUL 字节、扩展名白名单、SPA 回退
- 后端多平台构建（Linux、macOS、Windows），每个平台都跑测试，见
  `.github/workflows/build-release.yml`
- 自动构建与发布工作流：推送 `v*` tag 时发布各平台产物，发布说明从本文件提取
- 发行页逐项说明每个资产（`standard` / `perf` / `debug`），
  并在压缩包旁边提供 `README.txt` 与 `SHA256SUMS.txt`

### 变更
- 发行资产改名为 `standard` / `perf` / `debug`：推荐下载档带断言，`perf` 是性能基准档，
  `debug` 只在打 tag 时构建
- 发行版二进制改为静态携带 C++ 运行时（Linux `-static-libstdc++ -static-libgcc`，Windows `/MT`），
  用户安装时无需额外运行时
- 文档：移除已退役的「B 方案」代号，统一改为「后端持有计算」的直接表述
  （只动注释、文档与测试标题）
- CI：Pages 部署统一到 `static.yml`，删除重复的 `pages.yml`

### 修复
- `LICENSE`：第三方清单仍列着 2026-10-15 随 Qt UI 代码树移除的 Qt 6 / QCustomPlot / QXlsx /
  fast_float，现改为实际随项目分发的依赖

### 弃用

### 移除

### 安全

### 发行资产：三档意味着什么

每个包都是「后端二进制 + `web/` 目录」：解压、运行，界面就在 `http://127.0.0.1:37811/` 同源打开，
不需要另装任何东西。

| 资产 | 构建 | 速度 | 断言 | 什么时候选 |
|---|---|---|---|---|
| `dc_backend-<os>-standard.zip` | `-O2 -g`，不定义 `NDEBUG` | 约为 `perf` 的 90% | **开** | 默认选它：算错时会在违约点直接停下，而不是把错数字当结果报出来 |
| `dc_backend-<os>-perf.zip` | `-O3 -DNDEBUG` | 100% | 关 | 做基准测试，或就差最后那 ~10% 性能 |
| `dc_backend-<os>-debug.zip` | `-O0 -g` | 10–50% | 开 | 在调试器里复现缺陷；仅 tag 构建 |

与 0.1.0 相比，二进制现在还静态携带 C++ 运行时、并且自己提供界面——0.1.0 发布的是一个只有 API 的可执行文件。

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

[未发布]: https://github.com/DozenLow/DataCardForge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/DozenLow/DataCardForge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DozenLow/DataCardForge/releases/tag/v0.1.0
