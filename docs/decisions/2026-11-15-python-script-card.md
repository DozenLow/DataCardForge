# 决策：Python 脚本卡——卡是函数、注入是名字绑定、输出先声明

- **日期**：2026-11-15
- **状态**：🔒 已定稿（阶段 1 实施中，分期与触发条件见文末）
- **标签**：`#架构 #函数卡 #脚本卡 #runner #安全 #契约`
- **结论**：新增 `builtin:python` 签名——用户脚本在净室子进程里执行，端口矩阵以
  **名字绑定**注入（`A`、`names_a`、`shape_a`…），输出**先在右面板声明**再按名取值；
  出入口全部走 DCM2 帧，stdout 永远不是数据通道。对「K 冻结」契约做**显式修正**：
  K 由卡片声明固定（仍永不由数据决定）。runner **不是沙箱**，安全边界是 Origin 门 +
  进程隔离 + 钉死供应链，不是代码审查。
- **上游契约**：[端口语义规格 v1](../architecture/port-semantics-v1.md)（portId 稳定身份、
  K 冻结、结构化错误）、[后端协议 v1](../architecture/backend-protocol-v1.md)（DCM2 帧、
  一次 send、错误体形状）、[函数卡的三个契约](./2026-10-27-card-contracts.md)（参数归签名）、
  [卡片数据结构 v2](./2026-10-26-card-schema-v2.md)（一卡一节点）

## 动机：算法完备性的成本曲线

内置签名每多一个算法，成本是线性的：C++ 实现 + 签名注册 + 测试 + UI 接线。科研用户的
长尾算法（滤波、插值、自定义统计）永远追不完。脚本卡是逃生舱：一个签名承载任意用户
算法，边际成本 O(1)。它不取代内置签名——确定性、性能、可复用的正路仍是内置；脚本卡
接住的是「内置没有、用户等不及」的那一类。

## 一、卡是函数

脚本只读**端口注入的变量**。文件、网络、时钟、未播种随机不是输入：脚本若去读它们，
runner 拦不住（见「安全边界」），但语义上它们不是卡这个函数的一部分——同一输入 + 同一
脚本 ⇒ 同一输出是差分夹具与缓存有效性的前提。破坏它的脚本由 lint 盖「不可复现」章
（只标注、不拦截），后果归用户，工具的义务是让他看见。

## 二、注入 = 名字绑定

- 每个输入端口按 varName 注入三个名字：`A` = float64 二维 C 序 ndarray、
  `names_a` = 列名 list、`shape_a` = (rows, cols)。小写后缀 = 端口名小写。
- **不拼接任何代码行**：runner 执行 `compile(script, "<脚本卡>", "exec")`，脚本前后
  没有包装代码，traceback 行号与用户在编辑器里所见逐行一致（错误面板的行号可点击回跳）。
- numpy 不预注入；`import numpy` 是脚本自己的事。
- 命名规则：跨面板同名拒、同面板重名拒、保留名（`names_*` / `shape_*` / `meta`）拒、
  大小写易混（`A`/`a`）警告不拦。
- 改名 = 脚本内**标识符替换**（lezer 语法树判定，只动 identifier 节点，字符串/注释里的
  同名词不算）+ 实时预览「将替换 N 处」。输入端口改名同步 varName 与 `params.portNames`，
  **portId 永不变**（冻结契约）；输出改名只动 `params.outputs` 与边的显示标签——边绑
  outputId，不许断。

## 三、声明式输出：对「K 冻结」的显式修正

[port-semantics-v1](../architecture/port-semantics-v1.md) 锁定「K 由签名固定，永不由数据
决定」。脚本卡的 K 无法在签名层固定——它由用户在卡片右面板声明。修正条款：

> `builtin:python` 的签名 inputs/outputs 是**空模板**；真实端口与输出由 `params`
> （`portNames` / `outputs`）声明。**K 仍永不由数据决定**——它在用户声明的那一刻固定，
> 运行数据只能填充它、不能增减它。「K 由签名固定」放宽为「K 由声明固定」，这是显式
> 修正，不是静默绕过。

- 声明的 K 个输出**全部可接线**：outputId 在声明时即存在，边绑 id、不绑位置或名字。
  这是第一个 K > 1 的签名——[card-contracts](./2026-10-27-card-contracts.md) 预言的
  「输出选择器」信号在此触发：节点侧输出 0 进 displayMatrix，其余存 `extraOutputs`。
- **补记（2026-11-16，实施收口）**：v1 只给输出 0 备读遍，等于「声明得了、接不上」。
  现在每个声明输出都有**自己的本地槽位**并按需读遍（运行后 preview，被图表点名后整列），
  `refreshDependentsOf` 不再把 `out:N` 的边改写回输出 0；图表 / 函数卡 / 脚本卡都能
  **从任一命名输出建卡**。契约未变（K 仍由声明固定、边仍绑 outputId），变的是它终于
  全部成立。超 `MAX_CACHE_ROWS` 的结果按「已到缓存上限」算读完——否则同一批上限行会被
  反复重拉。
- runner 按声明名从 globals 取值：**声明未赋值 → 错误**（missingOutput）；
  **赋值未声明 → 仅提示**，不产出。

## 四、出口校验

一切输出必须落成 float64 矩阵帧，规则表（拒绝 = exit 3 + 结构化错误，**绝不静默 astype**）：

| 值 | 处置 |
|---|---|
| float64 ndarray，ndim ≤ 2 | 通过（0 维 → 1×1；1 维 → 列向量） |
| 整型 ndarray，全部 \|v\| ≤ 2^53 | 无损升 float64（**唯一允许的转换**） |
| 整型 ndarray，存在 \|v\| > 2^53 | 拒（有损） |
| list / tuple | `np.asarray` 后按 ndarray 规则（出 object / `<U` 即拒） |
| bool / int / float 标量 | `float()` → 1×1 |
| DataFrame | 需 RangeIndex(0..n-1) 且所有列可无损转 float64；自定义 index 拒，信息含 `reset_index(drop=True)` 建议 |
| complex / object / str / datetime / ndim > 2 / None | 拒 |

拒绝时 stderr 一行 JSON（invalidOutput + reason + actual）加一行人读信息；错误体形状
沿用 `{"code": ...}` 协议，文案渲染在前端 i18n。

## 五、帧与进程边界

- 帧 = DCM2（协议唯一帧格式）：magic `0x44434D32`、24 字节头（rows/cols/namesLen/
  totalRows/totalCols，u32 小端）、data f64 列主序、names UTF-8 JSON、NaN 原样。
  runner 与 C++ 侧共用同一实现，不写第二份帧编码。
- **stdout 永远不是数据通道**：数据只走帧文件，stdout/stderr 只走诊断与 lint JSON。
- 退出码：0 ok / 2 脚本异常 / 3 输出非法（含声明未赋值）/ 4 超时（父进程杀）/
  5 numpy 或 runtime 缺失 / 6 语法错误（--check）。
- runner 子进程：环境清空（仅 PATH、PYTHONPATH）、cwd = 临时目录、超时杀**进程组**
  （setpgid + kill(-pgid)）、`/cancel` 复用同一杀灭路径。

## 六、两种运行

| | 净室运行 | 调试运行 |
|---|---|---|
| 进程 | 每次全新 | 会话（阶段 1 暂走净室路径） |
| 结果去向 | displayMatrix + DAG + 环境戳 | 只进调试面板与右面板预览 |
| DAG | 写、触发下游 | 不碰、不触发下游 |

v1 允许调试按钮先走净室路径，但结果**不写 displayMatrix**——「调试」的语义边界从第一
天就立住：调试永不产生下游可见的数据。

## 七、环境锁

工作区 JSON 顶层 `env: {python: "<版本戳>", packages: [{name, version, platform, sha256}]}`。
v1 唯一合法值 = 钉死供应链（cpython `3.13.18+20261110` + numpy `2.5.4`，SHA256 记录在
`scripts/fetch-python-runtime.sh`，同源常量表注明出处）。schema 阶段 1 就位；包管理与
转移三态能力阶段 3。

**转移三态**（阶段 3 承诺）：工作区戳对本机环境——**一致**（正常运行）/ **不一致**
（显式横幅 + 每张卡显示工作区戳；「以当前环境重算」只关闭横幅、允许手动运行，
绝不自动执行任何脚本）/ **缺失**（runtime 不在 → 卡片红态「未检测到 Python 运行时」，
提及 fetch 脚本；卡片仍可编辑，不崩、不静默降级）。

## 八、库分层与排除清单

| 层 | 库 | 承诺 |
|---|---|---|
| T0 | numpy | 随包（钉死供应链，离线可用） |
| T1 | scipy、pandas、scikit-learn、python-dateutil、tzdata | 一键装（阶段 3） |
| T2 | 其他纯 Python 包 | 不承诺 |

排除：matplotlib、文件 IO 库、网络库、DL 框架、numba、polars。理由：前三类与「卡是
函数」冲突（IO / 网络 / 出图破坏可复现与纯矩阵出口）；DL 框架与 numba 的体积和冷启动
成本与档位 0 进程模型冲突；polars 与 T0/T1 的数值栈重叠。

## 九、安全边界：不是沙箱

**脚本卡 runner 不是沙箱。**脚本以用户完整权限运行，能做用户能做的一切。防线拦的是
两类事故，不是恶意：浏览器里任意页面跨源读本地后端（Origin 门），以及脚本无意污染
宿主（进程隔离）。恶意代码不在威胁模型内——这是本机单用户工具，信任级别与用户自己
打开终端跑 python 相同。

- Origin 门：无 Origin → 不加任何 CORS 头（非浏览器客户端零变化）；127.0.0.1 /
  localhost（任意端口、http/https、大小写不敏感）→ 原样回显 + `Vary: Origin`；
  其余（含解析不了的）→ 403 `{"code":"forbiddenOrigin"}`；OPTIONS 预检 204/403。
- `/api/script/check` 只 `compile` 不 `exec`——这是安全边界，不是性能优化；端点实现里
  不得存在任何执行脚本内容的路径。
- 供应链钉死：解释器与 wheel 按 URL + SHA256 采购，校验不过删文件并**中止**（不自愈
  重下）；缓存文件被篡改同样中止。

## 十、零特例门禁

通用基础设施——依赖图、关闭保护、rebuildDependencies、bindings、migrate、cardMetrics、
connectionGeometry——**不得出现 script 卡特判**；分支只允许在组件选择层（渲染入口按
signatureId 分派）。门禁脚本 grep 违例并注册 ctest；脚本卡是第一个经受此门禁的卡型，
它若需要特判才能工作，说明通用层错了，修通用层。

## 十一、分期与触发条件

| 期 | 内容 | 升级触发条件 |
|---|---|---|
| 阶段 1（本轮） | 档位 0 进程模型：每次净室运行新起 python3 进程，DCM2 文件帧进出；env schema 就位；调试按钮走净室路径 | — |
| 档位 1 | 共享内存帧（port-semantics 的 L2 memfd 零拷贝路径，帧格式不变） | 进程 spawn / 帧序列化成为可测量瓶颈（运行墙钟时间显著大于脚本计算时间） |
| 会话内核 | 常驻调试会话进程（低延迟、可保留状态） | 调试运行对延迟或状态保持产生真实需求 |
| 阶段 2 | preset 解包 + 差分三角 | 另行开板 |
| 阶段 3 | 包管理、T1 库一键装、env 转移三态完整能力 | 另行开板 |

## 与会改变这些决定的信号

- 需要跨源直接调用 API（非同源部署）→ Origin 白名单与 Allow-Methods（现不含 PATCH）
  要重新决策。
- 用户脚本普遍要产出图而非矩阵 → 出口校验需要新的输出 kind，「卡是纯矩阵函数」作废。
- K 声明被证明易错（频繁忘声明）→ 考虑从 AST 自动提取赋值作声明候选（仍不由数据决定）。
- 档位 1 启动 → 帧文件 IO 退休，DCM2 变为共享内存布局描述。

## 关联

- 代码：`backend/runner/`（dcm2.py + runner.py）、`backend/src/http_server.cpp`（Origin 门）、
  `scripts/fetch-python-runtime.sh`（钉死供应链）
- 契约：[端口语义 v1](../architecture/port-semantics-v1.md)、
  [后端协议 v1](../architecture/backend-protocol-v1.md)、
  [函数卡的三个契约](./2026-10-27-card-contracts.md)、
  [连线端口锚点](./2026-11-17-port-anchored-connections.md)（端口仍是数据身份；脚本卡的输入/输出行现在也是连线锚点，三栏布局见该决策）
