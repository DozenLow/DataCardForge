# 任务书：卡片多输入 + 右键拖接线（D0/M1/G1/M2/G2/G3；G4 延后）

- **日期**：2026-11-20
- **状态**：🚧 待开工（D0 决策已落盘；按本任务书执行，聊天内容只作口头说明）
- **上游决策**：[卡片多输入与右键拖接线](../decisions/2026-11-20-card-multi-input-and-wire-gesture.md)（🔒 已定稿，口径以它为准）
- **一句话**：补上「一卡 N 口各接不同上游」的三个 store 动作与左栏选择器，再以标题栏右键拖
  接线、全屏蔽原生右键菜单并重写编辑菜单。契约零改动。

## 〇、前置条件（不满足就别开工）

1. `git status --short` 为空（D0 收口后 HEAD 见 STATE.md）。
2. 基线全绿（数字以 STATE.md 为准，当前 vitest 1218/20、ctest 23+4）：
   `cd web && npx vitest run`；`ctest --test-dir backend/build --output-on-failure`。
3. **禁碰**：units 任何代码（`web/src/core/units.ts`、workspaceStore 的 units 段落
   ~L1522/L2619/L5450、`backend/src/units.*`）、DCM2 帧、表达式语义、签名 id、冻结契约。
4. 并行 lane 互斥写域见各任务；**禁止两个 lane 同改一个文件**（本仓库曾因此 22+20 次编辑冲突）。
5. 执行委派云端 flash（每任务全新会话、自包含提示词、单一写域）；lead 亲跑闸门、亲读 diff、
   英文 commit。**暂不 push**——全 lane 完成后由 lead 统一推送（用户指令）。

## 行锚（当前 HEAD，供提示词定位；动手前再 grep 复核）

- `addScriptPort`（克隆首源，待下线）：`workspaceStore.ts` ~L6050
- 重试谓词缺陷：`if (!bindings) return;` ~L2187；`card.node !== null` ~L2264/L2274
- 图表多来源重同步（待泛化）：`beforeOwners`/`afterOwners` ~L3765–3782
- `publishedMatrices`：~L2009；`chartInputsFromConfig`：~L3307
- ScriptCard `+端口` 0 口禁用：`ScriptCard.tsx` ~L1443；输出端口右键 ~L1492
- CardShell 抓手：`dragHandleClassName="card__titlebar"` ~L99（无 allowAnyClick、标题栏无菜单）

## M1 · store 动作层（写域：workspaceStore.ts、bindings.ts、web/tests/ScriptCardStore.test.ts、web/tests/fixtures/cards/）

契约红线：portId 稳定身份；改接不改 portId/脚本/K；成环整笔回滚；零特例（`applyCardInputs`
通用，图表与脚本卡共用）；改接是离散动作先 flush。

交付：
1. 抽 `applyCardInputs(cardId, nextInputs)`：泛化图表 `beforeOwners`/`afterOwners` 边重同步；
   图表列编辑改走它（行为不变）。
2. `addScriptInput` / `rebindScriptInput` / `removeScriptInput`；下线 `addScriptPort` 克隆首源。
3. 修重试谓词：已有节点但绑定不完整的卡，矩阵注册完成后要补推（不再只捞 `node===null`）。

验收：`npx vitest run ScriptCardStore`（含新增用例）全绿 + 全量 vitest 不回归。
新增用例：第三口异源加；改接后旧边摘口/新边加口且 params/脚本逐字节不变；成环整笔回滚；
改接未注册矩阵→注册后补推；删口后其余 id/名字不变、不复用活跃洞；0 口 `portNames=[]` 合法。

## G1 · 原生右键屏蔽 S1（写域：web/src/main.tsx 或新 suppressNativeMenu.ts、web/tests/ 新用例）

契约红线：window 捕获阶段**只 preventDefault、不 stopPropagation**（四处自绘菜单零回归）；
编辑面豁免（`closest('input,textarea,[contenteditable]')`）；键盘 contextmenu 不拦。

验收：新用例断言武装区 `contextmenu` 被 `defaultPrevented`、编辑面豁免放行、自绘菜单仍触发；
全量 vitest 不回归。

## M2 · 左栏来源选择器（写域：ScriptCard.tsx、新 SourcePicker.tsx、web/tests/ DOM 用例）

依赖 M1。契约红线：绑定声明可枚举工作区（区别于图表表现选择）；成环候选置灰；取消不留端口；
0 口不再禁用；端口加 `data-port-id`；视觉复用 SidePanel/Popup。

验收：DOM 用例（来源 chip 开弹层、成环置灰、+端口取消不留口、✕ 删口引用计数提示）+ 全量不回归。

## G2 · EditingSurface + 编辑菜单 S2（写域：新 editingSurface.ts/EditingMenu.tsx、ScriptCard.tsx 仅注册 CM 适配器、VirtualTable.tsx、FormulaCard.tsx、web/tests/）

依赖 G1。契约红线：菜单不认 CodeMirror（经适配器）；粘贴权限被拒置灰提示 Ctrl+V，绝不静默；
完成后删 G1 编辑面豁免。

验收：适配器复制/剪切/全选、粘贴拒权置灰；四处自绘菜单零回归；全量不回归。

## G3 · pointer 仲裁 + 右键拖接线（写域：新 wireGesture.ts、CardShell.tsx、ConnectionLayer.tsx、cardMetrics.ts、web/tests/）

依赖 M1+G1+M2。契约红线：分界在 pointerup 按 4px 位移裁决（不靠 contextmenu 时机、不用长按
计时器）；pointerdown 不 preventDefault；落点矩阵按决策 §六；`resolveDrop` 纯函数按卡矩形解
（不依赖 elementFromPoint）；区分图表端口（拒接）与脚本端口（可替换）；草稿线留背景层
`pointer-events:none`、带箭头；多输出不许猜 out:0；提交调 M1 三动作。**CardShell 九卡型共用，
最大回归面**——配 pointer 序列用例。

验收：`resolveDrop` 落点矩阵用例 + 仲裁状态机用例（阈值/Esc/单击拖线分流/键盘入口）+ 全量不回归。

## G4 · 延后另开板（本轮不做）

四菜单改 pointerup 派发、输出端口起手拖线。依赖 G3 验证后。
**重启时优先重议 4B 方案**（强制输出端口起拖、免落点矩阵选择；用户 2026-11-20 指定提醒，见决策 §十二）。

## 收口闸门（lead 亲跑）

`npx vitest run` 全绿（基线 1218/20）+ typecheck + vite build + docs-check + state-check；
`ctest` 复跑不回归（零后端改动）；部署同步 build==HEAD。英文 commit，一件事一次提交，
正文末尾 `RESUME:`。**全 lane 完成后统一 push**（用户指令），push 后盯 CI（尤其 windows/macos
编译单位后端——单位线 17 提交此前未推，CI 从未编译过）。