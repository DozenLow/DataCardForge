# 更新日志

[English](CHANGELOG.md) | 中文

本项目的所有重要变更都记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.5] - 2026-11-28

### 功能

- 图表分析新增分类因子、对数坐标、多面板图、带等高线的热图、原始点叠加、矢量标注和仅影响显示的筛选。
- 拟合结果会说明拒绝拟合的原因，并显示实际参与拟合的数据点。
- 导入时保留分类列，后续可继续用于分组和分面。
- `example/` 提供可复现的公开测试数据：512 行工业轴承振动小样本和 168 行波士顿地区地面气象小样本。

### 测试数据来源

- 工业样本：Riaz 等（2024），*Vibration dataset of main journal bearings in internal combustion
  engines under diverse climatic and varying operating conditions*，Mendeley Data v5，
  [DOI 10.17632/3fcrrdjjvk.5](https://doi.org/10.17632/3fcrrdjjvk.5)，许可为 CC BY 4.0。
  样本保留 1000 RPM、50% 湿度、15 摄氏度条件下的 256 条健康轴承记录和 256 条故障轴承记录。
- 科研样本：Kantor 等（2023），*Local Climatological Data (LCD), Version 2 (LCDv2)*，
  美国 NOAA 国家环境信息中心，[DOI 10.25921/96dw-mb77](https://doi.org/10.25921/96dw-mb77)。
  样本包含站点 `USW00014739` 在 2024-07-01 至 2024-07-07 的 168 条 FM-15 逐小时报告，
  遵循 NOAA 开放数据政策。完整来源、哈希、转换过程和使用边界见 `example/README.md`。

### 修复

- 导入器现将常见缺测记号（`nan`、`NA`、`N/A`、`ND`、`<LOD`、`<LOQ`、`-` 和空单元格）读为缺口，
  数字列里意外混入真文本时仍会拒绝。
- RGB PNG 可正确导出为 PDF；显示设置或数据源绑定改变时，图表会清理相应的派生结果。
- DCM2 拒绝截断的文件头，矩阵模式安全报告操作数形状，工作区替换失败时会回滚而不留下半成品状态。

## [0.1.4] - 2026-11-17

### 功能

- `feat(backend)`：所有响应都过一遍回环 `Origin` 检查——别的源上的页面读不到这个 API
- `feat(backend)`：`builtin:python` 卡片在净室子进程里求值，运行时是钉死的 Python 3.13 + numpy，
  背后有逐字节的黄金夹具
- `feat(web)`：Python 脚本卡——三栏卡体、声明栏、端口子卡片，每个声明输出都有自己的可接线槽位
- `feat(web)`：工作区环境戳，首次使用时锁定，并以横幅形式露出
- `feat`：脚本卡双层检查——只编译不执行的检查端点 +「不可复现」标记
- `feat(web)`：任意声明输出都能建图表卡和函数卡；列面板只列这张图真正能读的矩阵
- `feat(web)`：连线锚定在渲染出来的端口子卡片上；建卡统一走右键，图型收进二级菜单
- `feat(web)`：用户操作在全工作区只结算一次（200ms）再传播，不再是每张卡一个计时器
- `feat`：脚本执行按工作区文件信任门控——逐文件 sha256、逐脚本确认、绑定本机环境
- `feat(web)`：武装后的脚本卡像公式卡一样自动重算；被阻塞时只冻结传播，闸门自己解除
- `feat(web)`：公式卡改用脚本卡的三栏卡体
- `feat(web)!`：切数据卡的文件是**数据变更**——读它的函数卡与图卡跟随重算，重指向确认流下线
- `feat(web)`：图卡只列它读过的那几张卡，更多数据源走「添加到已有图表」
- `feat(web)`：运行中显示呼吸灯与已耗时条

### 修复

- `fix(web)`：同源代理的请求以回环身份到达后端，开发服务器不再被 Origin 检查挡掉
- `fix(web)`：列面板列出图表能读的每一个矩阵
- `fix(web)`：计算进行中落地的变更会在结束后补跑，不再丢失
- `fix(web)`：换文件对所有函数卡都提供，不再只给旧式输入；横幅里写明是哪个脚本变量
- `fix(web)`：结果落地之后才算 done，部分结果绝不拿去画图
- `fix(web)`：闸门重开时重放自动运行，过期的结果按 id 丢弃
- `fix(web)`：`resumeAutoRuns` 收回脚本卡那一节

## [0.1.3] - 2026-11-04

### 修复
- 发行版 exe 双击后既不弹浏览器也不弹终端。这不是两件事：启动逻辑把 `isatty(stdout)` 当成交互
  判据，而由资源管理器（不是 shell）启动的 Windows 进程**没有控制台**——状态行于是写进失效
  句柄（窗口自然不出现），浏览器启动也被静默跳过，而服务本身已经在运行。现在后端没有控制台时
  自己创建窗口并把 stdin/stdout/stderr 重新绑定过去，把地址同时写进窗口与控制台标题；浏览器改用
  `ShellExecuteW` 打开（不再经过 `cmd.exe start`，失败会明确报出来而不是吞掉）。启动失败时窗口
  会停留 15 秒以便读到原因；端口被占用会同时给出该打开的 URL 和可换的端口；`--open` /
  `DC_OPEN=1` 可在非 TTY 环境下强制打开。exe 明确保持控制台子系统，由
  `scripts/check-pe-subsystem.py` 对最终进 zip 的那份文件断言；规则本身有 `ui_launch` ctest 门
- 连线在「一屏」之外仍然被抹掉：连线的 mask 从来没有声明自己的区域，`<mask>` 便回落到默认的
  「视口 -10% / 120%」——而在 `maskUnits="userSpaceOnUse"` 下这是**平面坐标**里的一屏。里面那个
  铺满平面的白色矩形被这个隐式区域裁掉，区域之外一律按 alpha 0 处理，于是线不是被裁而是被**擦掉**：
  缩到 100% 以下、或把视图平移离开平面原点之后，虚线就在半空断掉，而目标卡片明明还在屏幕上。
  现在区域显式写死（`MASK_EXTENT`），与白色底衬完全一致。回归用例：
  `ConnectionLayer.dom.test.tsx` →「states a mask region that covers the plane」

## [0.1.2] - 2026-11-03

### 修复
- 连线被连线层自己的 SVG 视窗裁掉了：缩到 100% 以下时，这个视窗只覆盖「一屏」的平面坐标，
  于是一离开这片区域线就在半空截断、相距较远的卡片看起来没有连上。现在允许内容溢出，
  只由画布视口负责裁剪
- Windows 包在普通 Windows 机器上无法启动：exe 仍然动态依赖 MinGW 的 `libstdc++-6.dll` /
  `libgcc_s_seh-1.dll` / `libwinpthread-1.dll`，系统从 `PATH` 里抓到一个不匹配的副本后直接报
  「无法定位程序输入点 …`do_unshift`… 于动态链接库 `dc_backend.exe` 上」（mingw-w64 的 UCRT 版与
  MSVCRT 版 libstdc++ 连 `mbstate_t` 的符号名都不同，所以版本号相同也不能互换）。现在用 `-static`
  把运行时全部链接进 exe，并且 Windows CI 一旦发现导入表里又出现 MinGW DLL 就直接判失败

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
- 发行页逐项说明每个资产（`standard` / `fullperformance` / `debug`），
  并在压缩包旁边提供 `README.txt` 与 `SHA256SUMS.txt`

### 变更
- 发行资产改名为 `datacardforge-<os>-<档位>.zip`，档位为 `standard` / `fullperformance` / `debug`：
  推荐下载档带断言，`fullperformance` 是全性能基准档，`debug` 只在打 tag 时构建
- 发行版二进制改为静态携带 C++ 运行时（Linux 与 macOS 用 `-static-libstdc++ -static-libgcc`），
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
