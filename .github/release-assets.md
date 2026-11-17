<!--
Bilingual release notes. Both halves are collapsed by default so the release page stays short;
GitHub renders <details> in release bodies, and the same file is copied into each archive as
README.txt (where the tags read as plain text, which is harmless).
Keep the two halves in sync when editing.
-->

<details>
<summary>中文</summary>

## 发行资产说明

每个包都是「后端二进制 + `web/` 前端产物」，解压即可用，不需要 Node、不需要另外装运行时。

| 文件 | 构建 | 用途 |
|---|---|---|
| `datacardforge-<os>-standard.zip` | `-O2 -g`，**不定义 `NDEBUG`** → Eigen 断言开启 | **请默认下载这个**。速度接近正式版，但一旦违反契约（矩阵维度不匹配、越界访问）会**当场停下并指出位置**，而不是默默算出一个错数字 |
| `datacardforge-<os>-fullperformance.zip` | `-O3 -DNDEBUG` | **全性能档（性能上限展示）**：测试与性能门禁测量的就是这一档；断言关闭，出错时可能只表现为结果不对 |
| `datacardforge-<os>-debug.zip` | `-O0 -g`，断言开启 | **复现专用**：单步调试友好；慢 2–10 倍，不要用它跑真实数据或计性能。只在打 tag 时构建 |

`<os>` 为 `linux` / `macos` / `windows`。

为什么把 `standard` 放在推荐位：这个项目还早，用户不会为了一个 bug 去克隆源码编译。`-O0` 的 Debug 虽然错误信息最全，但慢一个数量级，会被读成「这软件就是慢」；而**断言是由 `NDEBUG` 控制的，与优化级别无关**，所以 `-O2` 不定义 `NDEBUG` 就能同时拿到「接近正式版的速度」和「出错就停」。

## 包内结构

```
datacardforge          # Windows 上是 datacardforge.exe
web/
  index.html
  assets/…
README.txt            # 本文件
```

后端会自动在**可执行文件同级**找 `web/`，找到就同源托管界面 —— 打开 `http://127.0.0.1:37811/` 直接是界面，没有跨域、没有 dev server。

启动参数、各平台运行时依赖与安全边界见仓库 README（[中文](https://github.com/DozenLow/DataCardForge/blob/main/README.zh-CN.md#构建与运行) ·
[English](https://github.com/DozenLow/DataCardForge/blob/main/README.md#building--running)）。

## 校验下载

```bash
sha256sum -c SHA256SUMS.txt     # 在 SHA256SUMS.txt 所在目录执行
```

</details>

<details>
<summary>English</summary>

## What each asset is

Every archive is the backend binary **plus the built `web/` front end**. Unzip and run — no Node, no
extra runtime to install.

| Asset | Build | Use it for |
|---|---|---|
| `datacardforge-<os>-standard.zip` | `-O2 -g`, `NDEBUG` **left undefined** → Eigen assertions on | **Download this one by default.** Near release speed, but the moment a contract is violated (matrix dimension mismatch, out-of-bounds access) it **stops on the spot and points at the location**, instead of quietly computing a wrong number |
| `datacardforge-<os>-fullperformance.zip` | `-O3 -DNDEBUG` | **The full-performance tier** — the ceiling on display: this is the tier the tests and the perf gate measure. Assertions are off, so a defect may only surface as a wrong result |
| `datacardforge-<os>-debug.zip` | `-O0 -g`, assertions on | **For reproduction only**: friendly to a step debugger; 2–10× slower, so do not run real data or take timings with it. Built for tags only |

`<os>` is `linux` / `macos` / `windows`.

Why `standard` sits in the recommended slot: the project is still early, and a user will not clone the
source and build it just to report a bug. `-O0` Debug carries the fullest error information, but it is an
order of magnitude slower and reads as "this software is just slow". Assertions are gated by `NDEBUG`,
not by the optimisation level, so `-O2` without `NDEBUG` gives "near release speed" and "stops on the
first violation" at the same time.

## What is inside

```
datacardforge          # datacardforge.exe on Windows
web/
  index.html
  assets/…
README.txt            # this file
```

The backend looks for `web/` **next to the executable** and, when it finds it, serves the UI from the
same origin — `http://127.0.0.1:37811/` opens the interface directly, with no cross-origin setup and no
dev server.

Launch flags, per-platform runtime requirements and the security boundary live in the repository
README: [English](https://github.com/DozenLow/DataCardForge/blob/main/README.md#building--running) ·
[中文](https://github.com/DozenLow/DataCardForge/blob/main/README.zh-CN.md#构建与运行).

## Verify the download

```bash
sha256sum -c SHA256SUMS.txt     # run inside the directory that holds SHA256SUMS.txt
```

</details>

