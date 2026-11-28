# DataCardForge 性能基准

这不是新 CI 时间门禁，不读写 `dc_bench` 的 baseline 或预算，不接触常驻服务。所有 HTTP/浏览器样本访问各自新开的 `127.0.0.1` 后端，使用独立临时工作目录。运行前腾出内存和磁盘并尽量让机器空闲；不要同时运行其他测试、基准或构建。

## 从仓库根目录运行（Linux）

```sh
cmake -S backend -B work/perf-build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build work/perf-build
(cd web && npm ci && npm run build -- --outDir ../work/perf-web)
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/perf-playwright"
web/node_modules/.bin/playwright install chromium --only-shell

python3 scripts/perf/run.py --backend work/perf-build/dc_backend \
  --engine work/perf-build/dc_bench_scale --web-root work/perf-web \
  --out work/perf-smoke --profile smoke
python3 scripts/perf/report.py work/perf-smoke
```

预检能启动 Chromium；若发行版缺运行库，先按 Playwright 文档安装所需库。`--profile matrix` 运行所有规模；`--suite api boundary wave browser engine capacity` 可选子集。矩阵默认预热 3 次，常规点测 30 次、探索点测 5 次；探索点包括大于 200 万单元格、最大并发点、缺测和稳态探针。冷启动指新进程，没有清 OS 文件缓存。各套件可顺序分批运行，再用 `report.py RUN1 --include RUN2 ... --out NEW_DIR` 合并不同套件；对比版本应在同一主机交错采样，不能用不同机器的两次报告推导版本差异。

采集器有已确认缺陷时，可用 `--profile matrix --suite browser --browser-shape 200000x20 --browser-case import` 复跑指定尺寸与场景（保持预热和实测次数），然后在合并命令中加 `--replace-points RERUN --replacement-reason '原因'`。报告替换整个点而非挑选结果，保留 `superseded.csv` 与复跑清单；真实 HTTP 413 或超时应留在当前结果里。复测清单另记录采集脚本的 SHA-256。

## 数据、计时及校验口径

| 套件 | 负载与指标 | 易混淆的地方 |
|---|---|---|
| `browser` | 生产前端；真实选文件后，从 `change` 到首个正确且已布局的 DOM 单元格；另测注册、末行渲染、首次及改式后预览、显示更多、首次图表、滚轮缩放帧间隔 | 首格不是合成器绘制时间，可能先于注册响应或被弹窗遮挡。滚动由程序设置真实视口 `scrollTop`，只测表格响应。明确收到 413 后仍测本地表格及绘图，不继续远程公式；如果出现传播阻断弹窗，首次绘图包含点击确认（`modal_ack=1`），不会解除后端阻断。初始公式预览 100 行；本地显示缓存上限 200,000 行，不等于后端截断。图表分别记来源点数和应用抽稀后送给 ECharts 的点数，不用 SVG 路径命令数代替。 |
| `api` / `boundary` | 同一确定性表走 JSON、DCM2；注册、首 100 行窗、全列公式、显式 summary 到可验结果；最接近 32 MiB 的两侧及越界后的恢复 | 大于限制只发送声明的 `Content-Length` 并读取 413，实际请求体 0 字节；不把 413 算作 OOM 或时延样本。HTTP 耗时包含本机传输。 |
| `wave` | 单次 PATCH 更新共同源；固定行列，宽度 1→16、独立深度 1→16；公式 lane 8 / 1；首尾 done、ACK、卡/秒、末端可读结果 | 事件批次可能同时间被观测，不是每张卡的引擎计时；三段重叠。只测公式链，不外推到脚本子进程。 |
| `engine` | Release C++ 单进程；逐元素、均值+标准差、0.9 分位数、65 行滑窗、方阵乘法和求解 | 不包含输入生成/预热/校验、网络和 UI。工作量不同，不该汇总成一个分数。 |
| `capacity` | 可选 2 / 4 GiB cgroup v2，后端每次留存更多合法 DCM2 表，记录 `memory.peak`、5 秒稳态、`oom`、`oom_kill`、退出和恢复 | 缺委派权限标 `blocked`；全栈受限 OOM 尚无实现；浏览器无约束的稳态 RSS 不能替代 cgroup。 |

CSV 头为 `c0,c1,…`；0-based 的值是 `((r*(2*c+1)+17*c+3)%1009-504)/8`；缺测点满足 `(r+13*c)%97==13`，CSV 用 `NA`、JSON 用 `"NaN"`、DCM2 用 IEEE NaN。记录 fixture 大小和 SHA-256。首尾/代表点与小窗全量检查，公式必须读取可验证的新结果；引擎不以被测运算返回值作 oracle。`samples.csv` 每行一个阶段，包含 `i`、`warmup` 与 `status`；不要按行数计算运行次数。无样本或未到达用空值，不是 0。仅 `ok` 的耗时计入统计；成功不足 30 次不报跨尝试 p95。浏览器树 RSS 为 50 ms 采样和，可能重复计算共享页；后端 VmHWM 是进程真实高水位。日志约定：`backend.log` / `runner.log` 用来检查崩溃及失败详情，`manifest.json` 记录环境、构建指纹、模式、浏览器和文件。

## 近 OOM：仅在明确委派的内存组内

仅在你有一个**专门委派、可创建子组、开启 memory controller** 的 cgroup v2 父目录时传 `--suite capacity --cgroup-parent /sys/fs/cgroup/…`。每次新建子组，设置并回读 `memory.max`（2/4 GiB）、`memory.swap.max=0` 和 `memory.oom.group=1`，启动器留在组外。默认到约 94% 时停止加压；确实要探越界，再显式加 `--allow-cgroup-oom`，只限制和杀掉实验后端。若无权限，保持 `blocked`；不要用宿主机耗尽、`ulimit` 或普通进程退出冒充 OOM 证据。此路径须在有委派的环境实测之后才可用来对比容量。

## 读报告

直接打开同目录的 `report.html`，不需要联网。图表可切换 p50、p95、最小和最大值，以及阶段、横轴或量纲；不要把重叠阶段的百分位堆叠。缩放耗时指单次操作的帧间隔 p95，再跨尝试汇总，不是总缩放耗时。失败表可查 413、超时、错误和未测项；没有启动容量测试时，尝试数为 0。

`datacardforge.csv` 可直接在 DataCardForge 中打开：它只含密集 20 列输入的行数及部分性能指标（毫秒和成功次数），用 `rows` 作 X、任选一个 `_p50_ms` 或 `_p95_ms` 列作 Y；`NA` 表示无数据，不是 0。`summary.csv` 是含状态和维度的汇总表；`samples.csv` 是逐次逐阶段的原始证据。
