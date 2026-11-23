# 冻结草案：高等数学与统计函数（advanced-math.v1）

- **日期**：2026-11-23（同日 review 修复轮后修订）
- **状态**：🧪 已实现、实验态、默认关闭（`DC_ADVANCED_MATH=1` 才广告）；本文件口径即对外冻结
- **标签**：`#公式卡 #统计 #能力位 #预算 #oracle`
- **冻结规则**：实现前逐项能力卡和 oracle 通过后方可加入；通过后本文件中口径即对外冻结。

## 一、能力与可见性

新增 capability `advanced-math.v1`。未经 `/api/hello` 广告且后端未持有该 capability 时：不注册签名、不展示函数、Help 不列、公式解析不接受。

默认关闭。能力只控制可见性与入口，不改变 `builtin:expression-columns` 的签名、端口、列契约和一对 K 的宽表结果形状。v1 高级函数只支持列模式；直接矩阵模式调用必须返回 `unsupportedFunctionMode`，不得回落为空矩阵（三角函数同此规则）。

求和、连乘、积分、求导、组合、排列、三角、统计、回归、条件统计和 IRR 均由 C++ 引擎计算；前端不计算数值、不缓存近似答案。前端唯一的高级能力表面是 capability-gated 的 Help 列表与 MathML 预览（见 §十）。

## 二、跨函数口径

| 项目 | 冻定口径 |
|---|---|
| 空集 / 有限值 | 只保留有限双精度值；NaN 与 ±Infinity 不参与统计或配对 |
| 成对删除 | `CORREL`、协方差、回归只删除任一自变量或因变量非有限的成对观测 |
| 百分位 | R-7：`(n-1)q`、线性插值，`INC`；`EXC` 用 `(n+1)k` 秩且要求秩落在 `[1,n]`；k 必须整列恒定（逐行 k 返回 `domainError`） |
| 方差 / 标准差 | Excel 名称：`.S` 为样本，`.P` 为总体 |
| 退化列 | `CORREL`/`RSQ` 在任一列恒定时返回 NaN（RSQ 冻为相关系数平方）；`SLOPE`/`INTERCEPT` 在 x 恒定时返回 NaN。注意：既有 `builtin:linear-regression` 签名保留其历史 r2=0 约定，不改（冻结契约），两者口径差异在此明示 |
| IRR | `NPV(r)=Σ CF_k/(1+r)^k`，周期相等，从第零期开始；二分法在 `[-0.99,100]` 搜索，最多 128 次迭代；收敛判据为**绝对**残差 `1e-12`（终检 `1e-10`）；两端同号（含多根情形）返回 `convergenceError`，不伪造数字；二分法不需要导数检查 |
| 字符串 | 字符串字面量**只**是 COUNTIF/SUMIF 的 criteria 数据；出现在任何其他位置（含算术）返回 `domainError`，绝不编译成 NaN 值 |
| 数值边界 | 浮点溢出、非法整数域、发散积分、不可收敛求根、折点求导分别映射结构化错误，不转换为 Infinity 后继续传播 |

## 三、离散数学能力卡

| 能力 | 语义与边界 | 哪时不可信 | 独立 oracle |
|---|---|---|---|
| `SUM(expr, i, start, end)` | 对整数 `i ∈ [start,end]` 求和；升序、步长 1；**允许负整数端点**（`SUM(i,i,-3,3)=0`）；端点幅值 cap ±1000000；支持绑定变量与列表达式；绑定变量在 body 内**遮蔽同名列**（词法 id 区分嵌套同名） | 非整数 bounds、逆序区间、超项数预算、累加溢出 | 多项式闭式、对称区间闭式；回归夹具 |
| `SUM(column)` | 保留 v1 整列聚合语义；2/3 参数在 **parse 期**以 `badArgCount` 拒绝（带 token 位置） | — | v1 既有夹具 |
| `PRODUCT(expr, i, start, end)` | 连乘；逆序区间返回结构化错误，不按“空积=1”解释 | 非整数 bounds、逆序、超预算、乘积溢出/下溢 | 阶乘闭式；回归夹具 |
| `COMBIN(n,k)` | 整数且 `0<=k<=n`；乘法次数 ≤1024；long double 累乘累除 | 非整数、负数、k>n、超乘法预算、超数值域 | 闭式值（含 C(1e6,4) 精确整数对照）；Pascal/对称性待补任意精度表 |
| `PERMUT(n,k)` | 整数且 `0<=k<=n`；乘法次数 ≤1024 | 同上 | 闭式值；溢出边界用例 |

离散预算上限：区间项数最多 1000000；组合/排列最多 1024 次乘法。返回 `budgetExceeded` 时不发布任何结果。

## 四、积分与求导能力卡

| 能力 | 语义与边界 | 哪时不可信 | 独立 oracle |
|---|---|---|---|
| `INTEGRAL(expr, x, a, b)` | **自适应 Simpson**：Richardson delta ≤ 15·eps 即接受，eps = `1e-10·max(1,|S|)`（绝对+相对）；端点每行只求值一次；零宽区间 = 0；a>b 返回 `domainError`；节点 ≤100000、递归深度 ≤32，超限 `budgetExceeded`；非有限采样 `domainError` | 奇异点、无穷区间、不连续、预算内达不到目标精度（此时拒绝而非给数） | x²、窄高斯 `EXP(-1e8x²)`（闭式 √(π/1e8)，相对误差 <1e-5）、SIN  over [0,π]、零宽、奇异端点拒绝 |
| `DERIV(expr, x, x0)` | **只接受 3 参数**（order 参数未开放）；中心差分 h 逐半 + Richardson 级联 ≤12 级、每行 ≤29 次采样；级联不穩定返回 `convergenceError`；**折点闸**：单侧差商 gap 在 h 与 h/2 处应减半，不减半（ABS/MIN/MAX/IF/FLOOR/CEIL/ROUND/SIGN 的角点）返回 `notDifferentiable` | 非有限点、函数噪声放大、超预算、角点 | x²@3、x³@1e6（相对 <1e-8）、x³@0、ABS@0 拒绝、ABS@-2 = -1、SIN@0 = 1 |

预算：积分节点 100000 / 深度 32；求导级联 12 / 每行采样 29；顶层累计元素求值 1000000（含行数与嵌套）。绑定变量走线程局部词法栈：body 只编译一次，每次迭代一列求值服务所有行（禁止回到 clone+重编译 的 O(rows²·terms) 方案）。

## 五、Excel统计能力卡

| 能力 | 语义与边界 | 哪时不可信 | 独立 oracle |
|---|---|---|---|
| `VAR.S` / `VAR.P` | `SS/(n-1)` / `SS/n`；n<2（S）/ n=0（P）返回 NaN；只用有限值；long double 两遍中心化 | 极端尺度下的浮点误差 | 闭式 5/3、1.25；n 边界用例 |
| `STDEV.S` / `STDEV.P` | 对应方差平方根；n 边界同 VAR | 同上 | 闭式 √(5/3) |
| `PERCENTILE.INC(range,k)` | R-7；k 有限且 `0<=k<=1`，越界 `domainError`；k 须整列恒定 | 空集、重复值、插值边界浮点差异 | 闭式 1.75（n=4,k=.25） |
| `PERCENTILE.EXC(range,k)` | `(n+1)k` 秩须在 `[1,n]`；k ∈ (0,1)；越界 `domainError` | 空集、n 边界、秩精度 | 闭式 1.25 |
| `CORREL` / `COVARIANCE.S` / `COVARIANCE.P` | 成对删除；CORREL 至少两对且两列非常数（否则 NaN）；协方差 n 边界 n<2 / n=0 | 短列、常数列、尺度差异 | 闭式 1、2、4/3；常数列 NaN 用例 |
| `SLOPE(known_y,known_x)` / `INTERCEPT` / `RSQ` | 参数顺序同 Excel；y=a+b·x；x 恒定或少于两对 → NaN；**RSQ = 相关系数平方，常数列 → NaN** | 常数 X、短数据、非有限配对 | 闭式 2、0、1；退化列拒绝用例 |

## 六、条件统计能力卡

| 能力 | 语义与边界 | 哪时不可信 | 独立 oracle |
|---|---|---|---|
| `COUNTIF(range,criteria)` | 数值范围；criteria 为数值字面量（**保持完整 double 精度，不做字符串往返**）或比较字符串 `=,<> ,!=,>,>=,<,<=`；不支持通配/文本/正则（`unsupportedCriteria`） | 非数值 criteria、通配、非有限值 | 闭式计数；**精度回归：0.123456789 与 1e-9 的等值计数** |
| `SUMIF(range,criteria[,sum_range])` | 三参数按成对索引求和；省略时求 range 本身；长度不等 `shapeMismatch`；只加有限值 | 长度不等、非有限、通配 | 闭式 7、70；精度回归 |

## 七、IRR能力卡

`IRR(cashflows)` 接收一列有限现金流；要求至少一正一负；二分法 `[-0.99,100]`、≤128 次迭代、绝对残差 `1e-12`（终检 `1e-10`）；两端同号或残差非有限 → `convergenceError`；超迭代 → `budgetExceeded`；无符号变化/空列 → `domainError`。多根且两端同号时**拒绝**（与 Excel 给解的行为不同，Help 需说明）。

独立 oracle：两项现金流闭式 0.1；符号缺失拒绝；三项解析多项式与 LibreOffice 黄金解待补。

## 八、硬预算汇总

| 类别 | 默认上限 | 超限错误 |
|---|---|---|
| 求和 / 连乘单次项数 | 1000000（端点幅值 ±1000000） | `budgetExceeded` |
| 顶层表达式累计元素求值 | 1000000（含输出行数与嵌套调用） | `budgetExceeded` |
| 组合 / 排列乘法 | 1024 | `budgetExceeded` |
| 定积分节点 / 深度 | 100000 / 32 | `budgetExceeded` |
| 求导级联 / 每行采样 | 12 / 29 | `budgetExceeded` |
| IRR 迭代 | 128 | `budgetExceeded` |

## 九、三角函数（capability 内）

`SIN COS TAN ASIN ACOS ATAN`（均 1 参数，逐元素）。ASIN/ACOS 域外 → NaN（引擎 NaN 约定）。**不进 v1 函数表**：TS 参照引擎与 diff_fuzz 语料保持不动；矩阵模式 `unsupportedFunctionMode`。Help 仅在 capability 广告时列出。

## 十、前端预览契约（MathML Core）

预览只覆盖五种有界语法形状（SUM/PRODUCT/INTEGRAL/DERIV/COMBIN），其余原文回退；不解析 body、不算数值。 markup 限 MathML Core：body 用 `mtext`（Chromium 忽略 mrow 内裸文本）、二项式用 `mfrac linethickness="0"` + 显式 `mo` 括号（不用 mfenced/mtable）、绑定变量进运算符下极限（`∑_{i=1}^{4}`，不排成等式）。所有用户文本经 XML 转义；预览组件 memoised。回归：Core-only 断言 + 转义断言 + 逗号 body 回退 + headless Chromium 渲染实证。

## 十一、未进入主线的能力

- `XIRR`：不存在日期列一等公民契约，暂不实现。
- 任意阶求导：首版只接受 3 参数 DERIV。
- 无限积分与带奇异点积分：不承诺（奇异采样拒绝）。
- 通配符 COUNTIF / SUMIF：不承诺。
- 符号式积分或求导：不做；只做数值结果。
- 逐行 k 的百分位、逐行 bounds：不承诺（`domainError`）。
- LibreOffice 固定版本黄金导出与任意精度组合表：仍是待补 oracle（当前为闭式 + 回归夹具）。
- 新函数未通过能力卡和 oracle 前，不进入表达式帮助、README 或发行说明。
