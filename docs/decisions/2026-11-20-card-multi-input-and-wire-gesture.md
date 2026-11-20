# 决策：卡片多输入 —— 端口是变量、来源是附件；右键拖接线、右键语义单一权威

- **日期**：2026-11-20
- **状态**：🔒 已定稿（分期实施 D0/M1/G1/M2/G2/G3；G4 延后另开板）
- **标签**：`#架构 #函数卡 #脚本卡 #端口 #连线 #手势 #右键`
- **结论**：一张函数卡（以 Python 脚本卡为核心）可以有 **N 个输入端口，各接不同上游**——这在
  数据模型/依赖图/后端/runner 四层**早已成立**，缺的只是前端手势与三个 store 动作。本决策
  ① 把「端口=变量、来源=附件」立为口径，分离**改名/改接/加口/删口**四操作；② 抽出通用的
  `applyCardInputs` 边重同步（零特例）；③ 以**标题栏右键拖**为接线手势，落点语义定死；
  ④ 右键单击与右键拖由**同一 pointer 序列在 pointerup 按位移裁决**；⑤ **原生右键菜单全屏蔽**，
  编辑菜单经 `EditingSurface` 适配器重写。契约零改动（portId 稳定身份、K 由声明固定、DCM2 帧、
  一对卡一条线均不变）。
- **上游契约**：[端口语义 v1](../architecture/port-semantics-v1.md)（portId 稳定身份、K 冻结、
  ABSENT 显式缺席）、[Python 脚本卡](./2026-11-15-python-script-card.md)（名字绑定注入、声明式输出、
  零特例门禁）、[函数卡的三个契约](./2026-10-27-card-contracts.md)（参数归签名、cell 端口语义）、
  [连线端口锚点](./2026-11-17-port-anchored-connections.md)、[连线从属原则](./2026-08-07-connection-subordination.md)
  （连线不拦截鼠标）、[端口级连线](./2026-10-28-port-level-connections.md)（一对卡一条线、边带 portId）

## 动机：不是新能力，是被临时规则绕过的一条路

多输入的四层支撑早已就位（见 §三）。唯一缺口是前端：出生只能单源（`addScriptCard` 收数组但
UI 只传单卡），补口只会克隆首源（`addScriptPort` 把新口绑到 `inputs[0].target`，注释自称
「选新来源是画布手势」——而函数卡根本没有任何给端口选来源的画布手势）。这条「先复制首源、
改接以后再说」的临时规则就是缺口本身。本决策补上动作与手势，不新增契约。

## 一、多输入 = 一卡 N 口、各接不同上游（只取读法 A）

| 读法 | 语义 | 裁决 |
|---|---|---|
| **A. 一卡 N 个输入端口，各接不同上游** | `in:0←表X`、`in:1←表Y`，脚本拿到 `A`、`B` | ✅ 本决策 |
| B. 一个端口接多条边 | 一个变量收到一串矩阵 | ❌ 帧→名字绑定的单元是「一口一矩阵」；要 list 就声明 N 口，脚本里自己 `[A, B]` |
| C. 端口个数由数据/运行时决定 | 「每个文件各来一个变量」 | ❌ 违反「K 永不由数据决定」；脚本卡的放宽是「K 由**声明**固定」，不是由发现固定 |

## 二、端口是变量，来源是附件（四操作分离）

> `portId`（`in:N`）与注入名（`A`）属于**端口**；`target` 是端口**此刻读的那张表**。
> 端口是脚本里的一个变量声明，来源只是它的绑定。

| 操作 | 动 `inputs[]` | 动 `params` | 动依赖边 | 动脚本 | 现状 |
|---|---|---|---|---|---|
| **改名** `A→x` | 无 | `portNames[i]` | 不动（portId 不变） | 标识符替换 + 预览「将替换 N 处」 | ✅ 已实现 |
| **改接** `A→另一张表` | 只换 `target` | **不动** | 旧边摘口、新边加口 | **不动**（A 还是 A） | ❌ 本决策补 |
| **加口** | append | `portNames` +1 | 加边 | 不动 | 🟡 克隆首源→改为选来源 |
| **删口** | remove | `portNames` −1 | 摘口/删边 | 留 `NameError`（带行号、显式） | ❌ 本决策补 |

**关键推论**：改接不改 portId、不改脚本、不改 K，所以它**不是新契约，只是一次数据变更**——
走已铺好的路：flush → 标 dirty → PATCH → 已武装的自动运行同频跟上。改接**不需要信任机制**
（只换读哪张表，不新增文件/目录访问面，脚本卡 §九 待办不受影响）。删口与输出删口规则不同：
输出的读者是别的卡（有读者就拒），输入的读者是脚本作者自己（允许删，运行时显式 `NameError`）。

## 三、现状：四层已通三层（证据，新 HEAD `2b3036d` 复核）

| 层 | 多来源支持 | 证据 |
|---|---|---|
| 数据模型 `inputs: PortConnection[]` | 每口独立 `{cardId, matrixId}` | `web/src/ui/types.ts` `PortConnection` |
| 依赖图 | 一对卡一条边、端口进集合 | `web/src/core/DependencyGraph.ts` `addDependency` |
| store 出生 | `addScriptCard([first, second])` 已能建两口两边 | `web/tests/ScriptCardStore.test.ts` 双源出生用例 |
| 线上绑定 | 每口一个 `PortBinding{portId,varName,sourceMatrixId}` | `web/src/ui/bindings.ts` `portBindingsFor` |
| 后端收集 | 每条 binding 独立解析矩阵、`PortSlice` 按口切片 | `backend/src/nodes.cpp` `gatherInputs` |
| 帧与注入 | 每口一个 DCM2 帧 + `ports.json`，逐口注入 `A/names_a/shape_a` | `backend/src/nodes.cpp` `runScriptCard`、`backend/runner/runner.py` |
| 改接在线 | `PATCH /api/nodes/{id}` 接受 `inputs` | `backend/src/http_server.cpp` |
| **前端手势** | ❌ 出生单源 + 补口克隆首源 | 本决策补 |

## 四、store 动作层（M1，通用层零特例）

- 抽 `applyCardInputs(cardId, nextInputs)`：把图表分支里的 `beforeOwners`/`afterOwners`
  多来源边重同步（`setChartConfig` 内）**泛化为通用函数**。图表列编辑与脚本卡端口操作都走它——
  零特例门禁从构造上满足（通用基础设施不得出现 script 卡特判）。
- 三个脚本动作：`addScriptInput(cardId, target)`（追加端口 + `nextScriptVarName`）、
  `rebindScriptInput(cardId, portId, target)`（只换 target）、`removeScriptInput(cardId, portId)`
  （摘口 + 摘名字）。`addScriptPort` 的「克隆首源」**下线**（留着会让「B 和 A 是同一批数字」像 bug）。
- 事务：先算候选 inputs → 逐个 `addDependency` → 任一成环**整笔回滚**（沿用 `addScriptCard`
  的回滚写法），不落半改状态；拒绝用现有 `status.cycle` toast。
- 改接是**离散动作**：先 `flushOperations()` 再标 dirty + `syncFunctionCard`；不得伪装成
  `upstreamChanged`（自动运行自激事故的教训）。
- **修一个静默坑**：`pushFunctionCard` 在任一端口拿不到 server id 时 `return`，而重试路径
  `syncUnboundReadersOfMatrix` 只捞 `node === null` 的卡。已有节点的卡改接到「刚导入、还没注册」
  的表会**永远停在旧绑定**且不报错。重试谓词从「没有节点」放宽到「读了这张矩阵且绑定不完整」。

## 五、卡内来源选择器（M2）与 ColumnDock 的界线

`ColumnDock.tsx` 明写「卡内面板不枚举工作区——没有边指向的矩阵
不是表现选择，而是新连接」。这条规矩管的是**表现选择**（图上画哪几列）。脚本卡的端口是
**绑定声明**（脚本里写 `B` 就必须有一张表叫 B）。两者不是同一件事，界线在此立死：

> **表现选择**（图表列 dock）：只列已连接来源，新连接走来源侧显式手势。
> **绑定声明**（脚本卡左栏）：端口先于边存在，左栏是输入的唯一编辑面，可枚举工作区可发布矩阵。

- 端口行 `← 来源` 变控件，点开 `Popup`（门户到 body，卡片是 transformed 容器）按
  `publishedMatrices` 分组：数据卡=当前显示文件，函数卡=每个已声明输出（含 unit-convert 卡，
  零特例自动覆盖）。**自己与下游（会成环）置灰**并给理由；已被别口占用的标「已绑定为 A」；
  输出槽还没算过的标「尚未计算」。
- `+ 端口` 打开同一弹层：选中即追加 `in:N` + 名字；**取消则什么都不留**。0 口时不再 disabled。
- 行尾 `✕` 删口：复用 `countScriptOccurrences` 提示「脚本里还有 N 处引用」，只提示不拦截。
- 端口行加 `data-port-id`（供 G3 命中测试；现在只有 ref 注册，没有该属性）。
- 视觉语言复用图表统一后的 `SidePanel`/`Popup`（`53af5d9`），保持一致。
- 多文件卡的非当前文件选不到（`publishedMatrices` 只发当前显示文件；「切文件是数据变更」是
  冻结契约，要换先切文件）。同表多口允许（两个变量读同一批数字，无害），选择器标注即可。

## 六、右键拖接线手势（G3）

抓手 P0 = **标题栏**：react-rnd 的拖拽把手、`allowAnyClick` 默认 false（右键不挪卡）、
**没有任何右键菜单**——唯一干净位。表头/输出行/结果头各有自绘菜单，留待 G4。

**落点矩阵**（松手前必须显示方向与动作）：

| 落点 | 动作 | 松手前显示 |
|---|---|---|
| B 的**脚本端口行**（`in:N`） | **替换**该端口来源 | `替换端口 A（原 b.csv → 新 c.csv）` |
| B 的**卡体**（非端口行） | **新增**端口，名字取下一个空闲字母 | `新增端口 B ← c.csv` |
| B 是图表 / 内置签名函数卡（含 unit-convert） | 拒绝 | `此卡片不接受新输入` |
| A 自己 / A 的下游 | 松手前就红、松手拒绝 | 复用 `status.cycle` toast |
| 空白画布 | 取消，零副作用 | 草稿线变虚线 |
| B 已绑同一矩阵 | no-op | `已经是 B 的输入 A` |

- **A 的哪张矩阵**：数据卡=当前显示文件（唯一确定）；函数卡 K>1 **不许猜 `out:0`**
  （端口锚点决策原文「绝不猜一个输出」）——落点处弹一次矩阵选择，只有一项时零点击直接提交。
- **方向**：卡对卡无天然方向，草稿线**必须带箭头**，落点文案写死方向 `c.csv → B.输入`。
- **与文件拖放区分**：左键拖文件到数据卡=替换数据（现有 `dropTarget` 高亮）；右键拖卡到
  数据卡=拒绝（数据卡不接受输入）。两套高亮必须长得不一样。
- 命中测试用**纯函数 `resolveDrop(point, cards, ports)` 按卡矩形解**（client→plane 换算在外层
  薄薄一层），不依赖 `elementFromPoint`（jsdom 无布局，会假阳性）；端口行靠 `data-port-id`。
  `resolveDrop` 必须区分**图表端口行（chartPortId，拒接）与脚本端口行（in:N，可替换）**。
- 手势内核（`wireGesture` 状态 + `resolveDrop` + ConnectionLayer 的 `draftWire`）与触发器分离：
  今天挂标题栏右键，将来端口圆点做出来只换触发器，内核不动。草稿线留在 `pointer-events: none`
  的背景层，不新增层、不碰「连线不拦截鼠标」锁定项。

## 七、pointer 仲裁：右键单击与右键拖是同一序列的两个出口

浏览器只给 `pointerdown(button=2) → pointermove → pointerup` 加一个**时机因平台而异**的
`contextmenu`（某些 Linux/Chromium 按下就发，Win/mac 松手才发）。两个动作必须由仲裁器派生：

1. `pointerdown` btn=2 命中武装区 → `setPointerCapture` + 进 candidate 态（**不弹任何东西**）。
2. 位移 < 4px → 仍 candidate。
3. 位移 ≥ 4px → wiring（草稿线 + 落点高亮），放弃菜单意图。
4. `pointerup` 且从未超阈值 → **右键单击语义**（P0 标题栏=无动作；将来标题栏有菜单则在此打开）。
5. `pointerup` 在 wiring 中 → 提交落点 / 取消。
6. `Escape` / `pointercancel` / 失去捕获 / 窗口失焦 → 丢弃意图，**永不靠计时器补发**。

**分界在 pointerup，不在 contextmenu**——所以不依赖平台时机，jsdom 可测真逻辑。
`setPointerCapture` 不影响 window 捕获阶段观察（事件路径永远从 window 开始）；捕获期间事件
回落标题栏，松手落在别人表头不会顺手弹出别人的菜单。**不用长按计时器**（标题栏无竞争动作，
时间阈值只增延迟与测试脆弱性）；`pointerdown` 不要 `preventDefault`（会连带压掉
`onMouseDown={onActivate}` 置顶），只对 `contextmenu` 调 `preventDefault`。

## 八、原生右键菜单全屏蔽 + 编辑菜单重写（G1/G2）

原生菜单**无法挂起**（没有 API 能延后弹出它），但可以永久关掉。用户裁决：原生菜单对本项目
几乎无实际意义，**全部屏蔽，需要的功能重写**。

- **G1（S1）**：`window.addEventListener('contextmenu', e => e.preventDefault(), {capture:true})`。
  **只 `preventDefault`、不 `stopPropagation`**——四处自绘菜单（表头/结果头/输出行/裸画布）
  全是 React `onContextMenu`，事件照常冒泡，行为零回归，只是原生菜单没了。**编辑面暂时豁免**
  （`closest('input,textarea,[contenteditable]')` 放行，输入框/CodeMirror 还能用浏览器粘贴菜单）。
- **G2（S2）**：`EditingSurface` 适配器 + 自绘编辑菜单（复制/剪切/粘贴/全选），完成后**删豁免**，
  屏蔽扩到全应用。顺序反了脚本编辑器会有一段时间粘贴不了。
- 键盘唤起（Shift+F10 / 菜单键）不拦：无前置 pointerdown 就不武装，键盘用户保持原样。

`EditingSurface` 接口（菜单不认 CodeMirror）：

```
EditingSurface = { copy(), cut(), paste(text), selectAll(), canCopy, canPaste }
```

- 默认实现：`input`/`textarea`（`selectionStart/End` + `setRangeText` + 派发 `input`，
  或 `execCommand('insertText')` 让 React 受控输入正常收到变更）。
- CodeMirror 适配：`view.state.sliceDoc(range)` / `view.dispatch(view.state.replaceSelection(text))`。
- 注册进 `WeakMap<HTMLElement, EditingSurface>`，仲裁器从指针位置往上找最近编辑面。
- 粘贴只能靠 `navigator.clipboard.readText()`：需用户手势 + 权限；localhost 是安全上下文，
  权限被拒时**条目置灰并提示 Ctrl+V**，绝不静默失败。撤销/重做不进菜单（各编辑器 Ctrl+Z 够用）；
  拼写/翻译/检查元素/保存页面不重写（脚本编辑器本就关 spellcheck）。
- 涉及面：CodeMirror 脚本编辑器、公式表达式输入框、端口/输出改名 `NameField`、可编辑表格单元格。

## 九、零特例门禁与单位 v1 零交集

- 通用基础设施（依赖图、关闭保护、`rebuildDependencies`、bindings、migrate、cardMetrics、
  connectionGeometry、`applyCardInputs`）**不得出现 script 卡特判**；分支只在组件选择层。
- **与单位 v1 零交集**：单位是列的派生元数据、不进 DCM2、换算产出新表（见
  [单位感知阶梯](./2026-11-19-units-awareness-p3-and-formula-output.md)）。改接只是数据变更，
  目标矩阵的单位警告归单位 lane；脚本卡不走表达式引擎，无单位警告交互。本 lane **禁碰 units 代码**。

## 十、分期与任务板

| ID | 内容 | 写域（独占） | 依赖 |
|---|---|---|---|
| D0 | 本决策 + 任务书 + STATE | docs/、STATE.md | — |
| M1 | `applyCardInputs` + 三动作 + 下线克隆首源 + 修重试谓词 | workspaceStore.ts、bindings.ts、store 测试、卡片夹具 | D0 |
| G1 | 原生屏蔽 S1（编辑面豁免） | main.tsx 或新模块 + 测试 | D0 |
| M2 | 左栏来源选择器 + `data-port-id` | ScriptCard.tsx、新 SourcePicker.tsx、DOM 测试 | M1 |
| G2 | EditingSurface + 编辑菜单 S2（删豁免） | 新 editingSurface.ts/EditingMenu.tsx、ScriptCard.tsx(仅注册适配器)、VirtualTable.tsx、FormulaCard.tsx、测试 | G1 |
| G3 | pointer 仲裁 + 右键拖接线 | 新 wireGesture.ts、CardShell.tsx、ConnectionLayer.tsx、cardMetrics.ts、测试 | M1+G1+M2 |
| G4 | **延后另开板**：四菜单改 pointerup 派发、输出行起手拖线 | — | G3 验证后 |

并行对：M1∥G1（store vs 全局，零交集）；G2∥G3（编辑面 vs 壳/连线/手势，G3 只读 M2 的
`data-port-id`，不写 ScriptCard）。其余串行。执行委派云端 flash、单一写域，lead 亲跑闸门亲读 diff。

## 十一、不做清单与触发条件

**本轮不做**：`cell` 单列端口（脚本自己能切列；触发=宽表帧 IO 成瓶颈）；端口重排（会让名字与
来源重新配对，纯脚枪）；持久化未绑定端口（线上表达不了：`validatePythonParams` 要求
`portNames.length == bindings.size`）；G4；units 任何代码；后端/协议/runner/契约改动。

**会改变这些决定的信号**：
- 用户普遍要从**输出行**起拖（精确携带输出身份）→ 提前做 G4 的菜单让位机制。
- 需要「一个端口收一串矩阵」（读法 B）→ 动 runner 注入契约，另开决策。
- 拖拽建线需要撤销栈 → 与「无撤销栈」缺口合并裁决（断线=改数据，需撤回路）。
- 标题栏右键将来要承载卡片菜单 → 按 §七 仲裁在 pointerup 打开，与拖线共存。

## 门禁（新功能一律登记 vitest；本轮零后端改动，ctest 不新增、复跑不回归）

- store：双源出生已有，补「第三口从另一张表加」；改接后旧边摘口/新边加口、`params` 与脚本
  逐字节不变；成环整笔回滚（卡片/inputs/edges 三处不动）；改接到未注册矩阵后不推送、注册完成
  确实补推；删口后其余口 id/名字不变、`in:N` 不复用活跃洞；0 口卡 `portNames=[]` 合法。
- DOM：来源 chip 开选择器、成环候选置灰、`+端口` 取消不留端口、`✕` 删口引用计数提示。
- 手势：`resolveDrop` 落点矩阵纯函数用例（端口行替换/卡体新增/图表与内置签名拒接/成环拒接/
  空白取消/同矩阵 no-op）；仲裁状态机（4px 阈值、Esc、单击/拖线分流、键盘入口）。
- 编辑面：适配器复制/剪切/全选、粘贴权限被拒置灰；四处自绘菜单零回归；`contextmenu` 被
  `defaultPrevented`（jsdom 测不到「原生不弹」，测此代理）。
- 夹具：`web/tests/fixtures/cards/` 加多源一例，保证线两侧一致。
- 收工全量：vitest（基线 1218/20）+ typecheck + build + docs-check + state-check；ctest 复跑；
  部署同步 build==HEAD。

## 关联

- 代码：`web/src/ui/workspaceStore.ts`（动作/重同步）、`web/src/ui/components/ScriptCard.tsx`
  （左栏）、`web/src/ui/components/CardShell.tsx`（抓手）、`web/src/ui/ConnectionLayer.tsx`
  （草稿线）、`web/src/main.tsx`（原生屏蔽）。
- 影响面警示：`CardShell` 为九种卡型共用，是本轮最大回归面；G3 动它须配 pointer 序列用例。
- 相关决策：[Python 脚本卡](./2026-11-15-python-script-card.md)、[端口锚点](./2026-11-17-port-anchored-connections.md)、
  [端口级连线](./2026-10-28-port-level-connections.md)、[连线从属原则](./2026-08-07-connection-subordination.md)、
  [单位感知阶梯](./2026-11-19-units-awareness-p3-and-formula-output.md)（零交集）。