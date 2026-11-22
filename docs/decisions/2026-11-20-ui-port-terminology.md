# 决策：UI 端口术语规范 —— row/col 严格留给矩阵，卡上列表项一律称端口

- **日期**：2026-11-20
- **状态**：🔒 已定稿（用户高优先级裁决；类名重构已落地）
- **标签**：`#术语 #端口 #命名 #重构 #线性代数`
- **结论**：本软件以线性代数为计算核心，**行(row)/列(col) 是矩阵维度的敏感专用术语**。
  卡片上的输入/输出列表项**禁止**用 row/col 命名——它们叫**端口(port)**：输入端口(`in:N`)、
  输出端口(`out:N`)。一个输出端口 = 一个声明输出 = **一整张矩阵**（不是矩阵的某一行或某一列）。
  类名重构同步落地：`script-card__row*`→`__port*` 等（见映射表）。矩阵数据的 row/col 与指代
  真实矩阵列的控件（col-chip、列选择器）**严格保留**。
- **上游契约**：[端口语义 v1](../architecture/port-semantics-v1.md)（portId/outputId 稳定身份）、
  [卡片多输入与右键拖接线](./2026-11-20-card-multi-input-and-wire-gesture.md)（4B「从输出端口起拖」）

## 一、为什么必须区分

「输出行」曾被用来指脚本卡右栏的输出列表项，引发「到底是 row 还是 col」的混淆。根源有二：
① 代码用 `__row` 类名称呼 UI 列表项，与矩阵「行」撞名；② 一个输出列表项代表的是**一整张矩阵**，
既不是数据行也不是数据列。在线代驱动的软件里，row/col 必须无歧义地只指矩阵维度。

## 二、术语规则（规范）

| 概念 | 术语 | 规则 |
|---|---|---|
| 矩阵数据维度 | **行 row / 列 col** | 严格保留，线代专用，只用于矩阵内部 |
| 卡的输入列表项 | **输入端口** input port (`in:N`) | 禁用 row/col；一个变量绑定 |
| 卡的输出列表项 | **输出端口** output port (`out:N`) | 禁用 row/col；一个声明输出 = 一整张矩阵 |
| 其他 UI 列表项 | entry / item / stat 等 | 禁用 row/col（表达式项=expr-entry，统计项=stat-item） |
| 矩阵列控件 | col-chip / 列选择器 `port-column` / `unit-confirm__columns` | **保留 col**：指代真实矩阵列，col 是正确语义域 |
| 4B 手势 | **从输出端口起拖** | 不再称「输出行」 |

**一句话**：row/col 只留给矩阵数据；卡上列表项一律 port/entry，绝不叫 row/col。

## 三、类名重构映射（已落地，前缀字面量替换，无碰撞）

| 旧前缀 | 新前缀 | 含义 |
|---|---|---|
| `script-card__row` | `script-card__port` | 脚本卡输入/输出端口（`__row-list/__row/__row--output/__row-head`） |
| `formula-card__row` | `formula-card__expr-entry` | 公式卡表达式编辑项（`__expr` 已是行内输入框，故容器用 entry） |
| `unit-convert__row` | `unit-convert__entry` | 换算卡每列条目（`__target` 已是行内控件） |
| `summary-panel__row` | `summary-panel__stat-item` | 摘要统计项（`__stat*` 已存在） |

## 四、严格保留（绝不改）

- `vtable__row / __row--odd / __rowhead`：矩阵**数据行**渲染，row 是正确语义。
- `formula-card__col-chip* / __cols / __port-column`、`unit-confirm__columns`：指代真实矩阵列的控件。
- 所有矩阵标识符：`rowCount / columnCount / column / rows / cols / columnIndex / data-column / target.column`。

## 五、门禁

- 四个旧前缀在 `web/src` + `web/tests` 残留 = 0；矩阵数据文件（VirtualTable/MatrixData/chartModel/chartOptions）零改动。
- vitest 全绿（测试随类名同步）、tsc、vite build、docs-check。
- 纯 cosmetic 重构：零行为、零契约改动。

## 关联

- 代码：`web/src/styles.css`、`ScriptCard.tsx`、`FormulaCard.tsx`、`UnitConvertCard.tsx`、`SummaryPanel.tsx` 及对应 DOM 测试。
- 相关决策：[卡片多输入与右键拖接线](./2026-11-20-card-multi-input-and-wire-gesture.md)（§十二 4B 改述为「从输出端口起拖」）、
  [端口语义 v1](../architecture/port-semantics-v1.md)。