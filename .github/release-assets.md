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
| `dc_backend-<os>-standard.zip` | `-O2 -g`，**不定义 `NDEBUG`** → Eigen 断言开启 | **请默认下载这个**。速度接近正式版，但一旦违反契约（矩阵维度不匹配、越界访问）会**当场停下并指出位置**，而不是默默算出一个错数字 |
| `dc_backend-<os>-perf.zip` | `-O3 -DNDEBUG` | **性能上限展示**：测试与性能门禁测量的就是这一档；断言关闭，出错时可能只表现为结果不对 |
| `dc_backend-<os>-debug.zip` | `-O0 -g`，断言开启 | **复现专用**：单步调试友好；慢 2–10 倍，不要用它跑真实数据或计性能。只在打 tag 时构建 |

`<os>` 为 `linux` / `macos` / `windows`。

为什么把 `standard` 放在推荐位：这个项目还早，用户不会为了一个 bug 去克隆源码编译。`-O0` 的 Debug 虽然错误信息最全，但慢一个数量级，会被读成「这软件就是慢」；而**断言是由 `NDEBUG` 控制的，与优化级别无关**，所以 `-O2` 不定义 `NDEBUG` 就能同时拿到「接近正式版的速度」和「出错就停」。

## 包内结构

```
dc_backend            # Windows 上是 dc_backend.exe
web/
  index.html
  assets/…
README.txt            # 本文件
```

后端会自动在**可执行文件同级**找 `web/`，找到就同源托管界面 —— 打开 `http://127.0.0.1:37811/` 直接是界面，没有跨域、没有 dev server。

## 运行

```bash
# Windows: dc_backend.exe
./dc_backend                 # 起服务并自动打开浏览器
./dc_backend --no-open       # 只起服务
./dc_backend --port 4000     # 换端口
./dc_backend --web-root DIR  # 指到别处的前端产物
```

找不到 `web/` 时后端仍会启动，只提供 API，并在启动日志里说明（`ui: not found (API only)`）。

## 运行时依赖

| 平台 | 需要什么 |
|---|---|
| Linux | 仅 glibc ≥ 2.39（Ubuntu 24.04 / Debian 13 及以上）；libstdc++ 与 libgcc 已静态链接进二进制 |
| macOS | 系统自带 libc++，无需额外安装 |
| Windows | MSVC 运行时已用 `/MT` 静态链接，**不需要**安装 VC++ Redistributable |
| 全部 | Eigen 是 header-only，已编译进二进制，不需要单独安装 |

## 校验下载

```bash
sha256sum -c SHA256SUMS.txt     # 在 SHA256SUMS.txt 所在目录执行
```

## 安全边界

无鉴权、只绑 `127.0.0.1`、无 HTTPS；静态托管只服务白名单扩展名，拒绝路径穿越（越界探测返回 404，不会回退成 `index.html`）。详见
<https://github.com/DozenLow/DataCardForge/blob/main/SECURITY.md>。

</details>

<details>
<summary>English</summary>

## What each asset is

Every archive is the backend binary **plus the built `web/` front end**. Unzip and run — no Node, no
extra runtime to install.

| Asset | Build | Use it for |
|---|---|---|
| `dc_backend-<os>-standard.zip` | `-O2 -g`, `NDEBUG` **left undefined** → Eigen assertions on | **Download this one by default.** Near release speed, but the moment a contract is violated (matrix dimension mismatch, out-of-bounds access) it **stops on the spot and points at the location**, instead of quietly computing a wrong number |
| `dc_backend-<os>-perf.zip` | `-O3 -DNDEBUG` | **The performance ceiling on display**: this is the tier the tests and the perf gate measure. Assertions are off, so a defect may only surface as a wrong result |
| `dc_backend-<os>-debug.zip` | `-O0 -g`, assertions on | **For reproduction only**: friendly to a step debugger; 2–10× slower, so do not run real data or take timings with it. Built for tags only |

`<os>` is `linux` / `macos` / `windows`.

Why `standard` sits in the recommended slot: the project is still early, and a user will not clone the
source and build it just to report a bug. `-O0` Debug carries the fullest error information, but it is an
order of magnitude slower and reads as "this software is just slow". Assertions are gated by `NDEBUG`,
not by the optimisation level, so `-O2` without `NDEBUG` gives "near release speed" and "stops on the
first violation" at the same time.

## What is inside

```
dc_backend            # dc_backend.exe on Windows
web/
  index.html
  assets/…
README.txt            # this file
```

The backend looks for `web/` **next to the executable** and, when it finds it, serves the UI from the
same origin — `http://127.0.0.1:37811/` opens the interface directly, with no cross-origin setup and no
dev server.

## Running

```bash
# Windows: dc_backend.exe
./dc_backend                 # start the service and open the browser
./dc_backend --no-open       # start the service only
./dc_backend --port 4000     # use another port
./dc_backend --web-root DIR  # point at a front end built elsewhere
```

When `web/` is missing the backend still starts, serving the API only, and says so in its startup log
(`ui: not found (API only)`).

## Runtime requirements

| Platform | What you need |
|---|---|
| Linux | Only glibc ≥ 2.39 (Ubuntu 24.04 / Debian 13 or newer); libstdc++ and libgcc are linked statically into the binary |
| macOS | The system provides libc++; nothing to install |
| Windows | The MSVC runtime is linked statically with `/MT`, so **no** VC++ Redistributable is required |
| All | Eigen is header-only and compiled in — nothing to install separately |

## Verify the download

```bash
sha256sum -c SHA256SUMS.txt     # run inside the directory that holds SHA256SUMS.txt
```

## Security boundary

No authentication, bound to `127.0.0.1` only, no HTTPS; static hosting serves allow-listed extensions
only and refuses path traversal (an out-of-root probe returns 404 rather than falling back to
`index.html`). See <https://github.com/DozenLow/DataCardForge/blob/main/SECURITY.md>.

</details>

