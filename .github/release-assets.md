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

## 运行

```bash
# Windows: datacardforge.exe
./datacardforge                 # 起服务并自动打开浏览器
./datacardforge --no-open       # 只起服务
./datacardforge --port 4000     # 换端口
./datacardforge --web-root DIR  # 指到别处的前端产物
```

找不到 `web/` 时后端仍会启动，只提供 API，并在启动日志里说明（`ui: not found (API only)`）。

## 运行时依赖

| 平台 | 需要什么 |
|---|---|
| Linux | 仅 glibc ≥ 2.39（Ubuntu 24.04 / Debian 13 及以上）；libstdc++ 与 libgcc 已静态链接进二进制 |
| macOS | 系统自带 libc++，无需额外安装 |
| Windows | C++ 运行库已**整体链接进 exe**（`libstdc++` / `libgcc` / `winpthread` 都不需要外部 DLL），只依赖系统自带 DLL，**不需要**装 VC++ Redistributable 或任何 MinGW 组件 |
| 全部 | Eigen 是 header-only，已编译进二进制，不需要单独安装 |

> **如果旧包弹出「无法定位程序输入点 …`do_unshift`… 于动态链接库 `dc_backend.exe` 上」**：
> 那是因为旧包的 exe 仍然动态依赖 MinGW 的 `libstdc++-6.dll`，而系统从 `PATH` 里抓到了一个
> 口味或版本不匹配的副本（mingw-w64 的 UCRT 版与 MSVCRT 版 libstdc++ 连 `mbstate_t` 的符号名都不同，
> 所以版本号一样也可能不兼容）。当前包已把运行时全部静态链接，不会再出现；若你手工解压过旧包，
> 请把同目录残留的 `libstdc++-6.dll`、`libgcc_s_seh-1.dll`、`libwinpthread-1.dll` 删掉。

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

## Running

```bash
# Windows: datacardforge.exe
./datacardforge                 # start the service and open the browser
./datacardforge --no-open       # start the service only
./datacardforge --port 4000     # use another port
./datacardforge --web-root DIR  # point at a front end built elsewhere
```

When `web/` is missing the backend still starts, serving the API only, and says so in its startup log
(`ui: not found (API only)`).

## Runtime requirements

| Platform | What you need |
|---|---|
| Linux | Only glibc ≥ 2.39 (Ubuntu 24.04 / Debian 13 or newer); libstdc++ and libgcc are linked statically into the binary |
| macOS | The system provides libc++; nothing to install |
| Windows | The C++ runtime is linked **into the exe** (no `libstdc++` / `libgcc` / `winpthread` DLL is needed), so all it uses are Windows system DLLs — no VC++ Redistributable and no MinGW components are required |
| All | Eigen is header-only and compiled in — nothing to install separately |

> **If an older archive pops up "the procedure entry point …`do_unshift`… could not be located in `dc_backend.exe`"**:
> that archive still imported MinGW's `libstdc++-6.dll`, and Windows resolved an unrelated copy from `PATH`
> whose flavour or version did not match (mingw-w64's UCRT and MSVCRT libstdc++ builds do not even spell
> `mbstate_t` the same way, so an identical version number can still be incompatible). The runtime is now
> linked entirely into the exe, so it cannot recur; if you extracted an old archive by hand, delete the
> leftover `libstdc++-6.dll`, `libgcc_s_seh-1.dll` and `libwinpthread-1.dll` beside it.

## Verify the download

```bash
sha256sum -c SHA256SUMS.txt     # run inside the directory that holds SHA256SUMS.txt
```

## Security boundary

No authentication, bound to `127.0.0.1` only, no HTTPS; static hosting serves allow-listed extensions
only and refuses path traversal (an out-of-root probe returns 404 rather than falling back to
`index.html`). See <https://github.com/DozenLow/DataCardForge/blob/main/SECURITY.md>.

</details>

