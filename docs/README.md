# docs/ — 设计记录（Obsidian vault）

[English](README.en.md) | 中文

本目录是项目的**设计记录**，记录"为什么"和"想过的路"。三个入口，各管一件事：

| 想知道 | 去哪 |
|---|---|
| **是什么、怎么用** | 仓库根 [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) |
| **现在在哪、下次开工先验什么** | 仓库根 `STATE.md`——唯一权威；文档与代码不同步时以它为准 |
| **为什么这样、放弃了什么** | 本目录 |

- **本目录最后校对**：2026-11-04（校对时的 HEAD 见 `STATE.md`）
- 权属、数据来源与 AI 使用说明：[`PROVENANCE.md`](../PROVENANCE.md)

> 打开方式（可选）：Obsidian → "Open folder as vault" → 选择本 `docs/` 目录。

## 怎么读

- **5 分钟**：[项目演进史](history.md) §1（一句话）+ §2（决策流向图）
- **半小时**：再加 §4「四个时代」，然后按需读下面决策记录里带 ← 的三篇
- **要动手改**：先读 [`history.md`](history.md) §5 四条螺旋线、§6 教训清单，再读 `architecture/` 的规范
- **想复现坑**：`log/` 按日期、`lessons/` 按主题、`audits/` 按一次完整审查

## 导航

- 🧭 **项目演进史**（`history.md`）— 把决策/日志/踩坑/审计按因果链串成一条历史，含四个时代、四条螺旋线、教训清单与文档不一致盘点
  - [项目演进史（DataCardForge）](history.md) · [EN](history.en.md) ← **先读这篇再进各分册**
- 📌 **决策记录**（`decisions/`）— 已经拍板、影响后续的方向性结论
  - [回归卡改名「关系枚举」：选列变成端口绑定，列头带上 X : Y](decisions/2026-10-31-relation-enum-card.md) ← **最新：卡片终于能选列，表格横向滚动对齐也修了**
  - [数据卡可以换文件：换数据自动跟随，切文件仍显式重指向](decisions/2026-10-31-file-replacement.md) ← **保存的工作区终于能当模板复用**
  - [结果预览：稠密矩阵的 DCM2 帧（24 字节头 + 整表形状）](decisions/2026-10-29-result-preview.md) ← 大结果不再整包下传
  - [连线锚点落在端口中心，而非卡片边中点](decisions/2026-10-29-connection-center-anchors.md) ← 连线指向终于和数据流向一致
  - [引擎层性能门禁：12 个用例、p50×3 预算、1.3× 回归护栏](decisions/2026-10-29-perf-gate.md) ← 把「变慢了」变成一个可执行的数字
  - [函数卡输出绑定的三处真缺陷：本地 id · 上传竞态 · 结果表为空的连带入口消失](decisions/2026-10-28-function-card-output-binding.md) ← 「No result yet」的根因
  - [表达式列引用语法：名称可写、能带限定、全角可用](decisions/2026-10-28-expression-reference-syntax.md) ← 公式卡对带表头文件恢复可用
  - [端口级连线：边带 portId、端点落端口](decisions/2026-10-28-port-level-connections.md) ← 连线恢复为完整的依赖可视化（同日）
  - [摘要（`builtin:summary`）v1：统计量目录、惰性求值、数字归后端](decisions/2026-10-27-summary-builtin.md) ← 第一个惰性签名 + 目录即行序
  - [函数卡的三个契约（列数 · 参数归属 · 单列端口）](decisions/2026-10-27-card-contracts.md) ← 函数卡实现期把三处含糊定死了
  - [卡片数据结构 v2（依赖升信封，函数卡=单节点 K 输出）](decisions/2026-10-26-card-schema-v2.md) ← **已实施**，函数卡的地基
  - [画布改为无边界平面（平移，不含缩放）](decisions/2026-10-21-infinite-canvas.md) ← **当前视图模型：工作流不再被一屏限制**
  - [后端持有数据与计算](decisions/2026-10-17-backend-owns-compute.md) ← 当前分层裁定：浏览器纯交互，修订 T1 基线
  - [兜底原则（最大余量）](decisions/2026-10-15-max-headroom-principle.md) ← **核心架构原则**（分层表已被 10-17 决策修订，契约仍有效）
  - [彻底移除 Qt 实现](decisions/2026-10-15-qt-implementation-removed.md) ← **当前仓库形态**
  - [前端选型定为 Web](decisions/2026-10-14-frontend-web-chosen.md) ← **当前前端方案**
  - [图表库保持 ECharts](decisions/2026-10-14-chart-library-audit.md) ← 统计图型与矢量导出审计
  - [后端先行，前端搁置](decisions/2026-08-07-backend-first-frontend-paused.md)（其中"前端暂停"部分已被上面取代；"后端先行"部分被 10-17 决策复活并扩展）
  - [连线从属原则](decisions/2026-08-07-connection-subordination.md)
- 📐 **规范**（`architecture/`）— 已定稿、实现必须服从的契约（改它 = 改代码前先改这里）
  - [后端协议 v1](architecture/backend-protocol-v1.md) · [EN](architecture/backend-protocol-v1.en.md) ← 后端计算的传输/资源/错误/夹具契约；阶段 1–2 已按此实现，端点与帧格式以本文为准
  - [端口语义 v1](architecture/port-semantics-v1.md) · [EN](architecture/port-semantics-v1.en.md) ← 端口的身份、绑定与跨层语义契约
- ⚖️ **架构权衡**（`architecture/`）— 历史对比文档，结论多数已被决策追记取代；仅当想理解"为什么不选另一头"时阅读
  - [前端选型：ImGui vs Web](architecture/frontend-imgui-vs-web.md) · [EN](architecture/frontend-imgui-vs-web.en.md)（✅ 已收敛 → 选 Web，见 10-14 决策；对比表仍可复用）
- 📊 **审计**（`audits/`）— 一次性对抗式审查的完整记录，含缺陷编号与复验结论
  - [2026-10-15 UI/图表缺陷审计](audits/2026-10-15-ui-chart-defect-audit.md) ← 首轮 34 项 + 第二轮 11 项，含逐条复验
- 🕳️ **踩坑记录**（`lessons/`）— 实测中遇到的坑与规避方法
  - [ImPlot v1.1 API 大改](lessons/implot-v1.1-api.md)
  - [ImGui Docking 下 PushStyleColor 的坑](lessons/imgui-docking-pushstylecolor.md)
- 🧾 **任务书**（`tasks/`）— 一次会话可完成的执行切片：前置条件、契约红线、验收命令
  - [摘要面板 P2（前端）](tasks/2026-10-29-summary-p2-panel.md) ← 待开工，被「结果预览 / 稠密帧」阻塞
- 🗃 **样本数据**（`sampleData/`）— 合成数据，供演示与手工验证；生成脚本可复现
  - [`1.txt`](sampleData/1.txt) · [`2.txt`](sampleData/2.txt) · [`generate_matrix.py`](sampleData/generate_matrix.py)
- 🖼 **图**（`diagrams/`）— 所有示意图的 SVG 与交互页，见下节[图](#图diagrams)
- 📅 **开发日志**（`log/`）— 按日期记录进展（**只到 2026-10-31**；之后看 `CHANGELOG.md` 与 `STATE.md`）
  - [2026-10-31](log/2026-10-31.md)（数据卡换文件落地：换数据自动跟随 · 409 顺序问题 · closeAllCards 释放后端）
  - [2026-10-28](log/2026-10-28.md)（用户报障两句 → 三个真缺陷：指针捕获吞 click · 带表头列没有可用的列名 · 公式区被结果表挤成 0）
  - [2026-10-27](log/2026-10-27.md)（函数卡从规格到能跑：v2 落地 · 重指向确认 · 列数契约 · 结果可绘图/可链式 · 回归签名反证通用性）
  - [2026-10-21](log/2026-10-21.md)（阶段 3：公式卡计算权威切到后端 · 差分 fuzz 门禁 · 画布改为无边界平面）
  - [2026-10-17](log/2026-10-17.md)（后端持有计算拍板 + 工具链核实 + 阶段 0：决策/协议/跨层夹具）
  - [2026-10-15](log/2026-10-15.md)（仓库治理 + 移除 Qt + 修复 A/B/D/E/F）
  - [2026-10-14](log/2026-10-14.md)（前端定为 Web + `web/` 实现落地）
  - [2026-08-07](log/2026-08-07.md)

## 图（`diagrams/`）

- [决策流向](diagrams/decision-flow.zh.svg) ← `history.md` §2
- [端口投影关系](diagrams/port-projection.zh.svg) ← `architecture/port-semantics-v1.md`
- [当前架构](diagrams/architecture.zh.svg) ← 根 README 的「架构」一节用同一张图
- 交互版：[`interactive.html`](diagrams/interactive.html)——点选阶段/组件看它当时的判断与出处，可切中英与主题。
  **它是阅读增件，不是权威内容**；`file://` 直接打开会退化成静态图（点选需要 http）。

新增图请照做：

1. **一律 SVG**，不再用 ASCII 字符画——它靠字符等宽对齐，换字体或窄屏就散架。
2. **中英成对**：`X.zh.svg` 是原版，`X.en.svg` 是译文；正文按语言各自引用。
3. **自描述**：带 `viewBox`、`<title>`、`<desc>`；颜色走 CSS 变量（`var(--x, #fallback)`）并在
   `@media (prefers-color-scheme: dark)` 里给深色值——这样 GitHub / Obsidian 用 `<img>` 引用也能自适应。
4. **纯 SVG**：不引外部字体与脚本，文字用 `<text>`（可选中、可检索），不用 `<foreignObject>`。
5. **正文给图注与出处**：图只承载结构，论证仍在正文；图不能替代决策记录。
6. **校验**：`python3 scripts/docs-check.py` 会检查导航覆盖、死链、字符画残留、图无孤儿、中英配对、SVG 合法性。

## 重要约定

1. **三个入口各有分工**：是什么 → 根 `README.zh-CN.md`；现在在哪 → `STATE.md`；为什么 → 本目录。冲突时按此顺序。
2. **先用户视角，再技术方案**：任何架构讨论都先从"用户怎么想"出发，技术分析居后（[决策背景](decisions/2026-08-07-backend-first-frontend-paused.md)）。
3. 所有决策记录应包含：背景 → 选项 → 结论 → 关联模块 → 未来影响。
4. **只写可公开的内容**：设计记录面向读者。`private/` 是本机私有目录（被 `.gitignore` 排除），**不随仓库发布**，也不要从公开文档链接它。
5. **行为规则的出处**：Qt 实现已于 2026-10-15 从工作区删除（见 [决策](decisions/2026-10-15-qt-implementation-removed.md)）。
   此前"文档须指明对应 `src/widgets/` 文件"的约定随之废止——现在连线几何、红蓝灰配色、关闭保护等规则的
   **唯一权威定义是 TypeScript 源码与其测试**。历史文档中残留的 C++ 文件名不再指向可打开的文件，
   只作为"这条规则从哪来"的出处标注保留。
6. **历史不改写**：决策与日志记的是"当时怎么想"。要更新结论，就在原处加注并指向新文档，别把旧判断改成新判断。

## 语言策略

- **规范文档双语**：`docs/README.md`、`architecture/` 三份、`history.md` 都提供英文版——中文是 `X.md`，
  英文是同目录的 `X.en.md`，两份内容一一对应，**以中文为原始版本**；两者冲突时以 `X.md` 为准，并请顺手修掉 `X.en.md`。
- **图双语**：`X.zh.svg` / `X.en.svg`；交互页 `interactive.html` 在一页内切换语言，不再单独出 `.en.html`。
- **历史记录只有中文**：`decisions/`、`log/`、`lessons/`、`audits/`、`tasks/` 记录的是"当时那天怎么想的"，
  回溯翻译不增值，因此不提供英文版；需要时按篇再译。
- **新增文档的要求**：新的规范类文档必须同时给出 `X.en.md`；新的决策/日志不需要；新的图必须给出 `.en.svg`。
- **根目录产品文档用另一套命名**：英文 `README.md` / `CONTRIBUTING.md` / `SECURITY.md` / `CHANGELOG.md`，
  中文 `README.zh-CN.md` 等（后缀是 `.zh-CN.md`，与这里的 `.en.md` 方向相反）。
