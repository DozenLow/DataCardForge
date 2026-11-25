# 绘图卡第一阶段施工报告

- 日期：2026-11-25
- 快照分支：`lane-stage1-11251432`
- 范围：临时看数据；只做绘图、图面派生量和诊断，不做判定、审计、可重放脚本或出版规范
- 提交：`4b8c526` → `5c7a7a0`，每层独立提交

## 交付与验收

| 层 | 实现 | 验收落点 |
|---|---|---|
| 1. X / 连线 / 抽稀 | 任意 X 列；折线连成线；min/max 桶保包络抽稀；显示「绘制 / 总数」；拟合读取全量 | `charts.test.ts`：4 万点单点尖峰仍在，回归 `n=40000` |
| 2. 标注 | 水平/垂直参考线、接受区间、限值点标红、数值/名称点标签；均为 ECharts SVG primitive | `ChartAnnotations.dom.test.tsx`：导出无 `<image>` |
| 3. 拼版 | 单图卡 1/2 列面板；共享刻度与共享范围分开；A/B/C/D 标签；单 SVG | `ChartAnnotations.dom.test.tsx`：2×2 同列像素对齐、一个 SVG |
| 4. 对数轴 | X/Y 分别开关；双对数；2…9 次刻度；≤0 各轴分别计数 | `charts.test.ts`：log-log 与非正值计数 |
| 5. 小 n 原始点 | 箱线/小提琴/误差棒/柱图 `n<15` 确定性抖动原始点；可自动/常开/关闭 | `charts.test.ts`：`n=6` 六点全在且不经平滑 |
| 6. 二维场 | heatmap 增加 `field` 子模式；数值 X/Y/Z、colorbar 单位、锁定 clim、完整网格等值线 | `charts.test.ts` + SVG DOM 用例 |
| 7. 因子映射 | 文本 group 解析成稳定代码+标签词典；颜色/形状/分面/热图注释条与图例；factor 有独立端口 | loader、snapshot、chart、SVG、store 用例 |
| 8. 拟合诊断 | 后端隐藏分析节点；残差 vs 拟合、残差顺序、QQ；±2σ；可与拟合曲线 2×2 拼图 | C++ `chart_analysis` + Vitest/SVG 用例 |

## 图面算法

- 线性、过原点、WLS（`1/x`、`1/x²`）。
- 均值 95% 置信带与个体 95% 预测带分开。
- 4PL、指数、幂律均使用初值/边界；非法或不收敛返回 `fitFailed`。
- LOD/LOQ 按 `3.3σ/S`、`10σ/S`；只输出派生量，不给结论。
- 零相位低通按 Hz/阶数；采样率从均匀 X 推导或显式输入，非均匀 X 报错。
- 线性去趋势；原始曲线可叠加。
- 平滑/滤波只改变显示曲线；箱线、KDE、误差棒、相关性、拟合始终读取原始数据。

## 契约处理

- 新数值计算不进前端：使用普通隐藏节点与 `POST /api/nodes/{id}/compute`。
- 新签名 id：`builtin:chart-analysis`、`builtin:chart-filter`。
- 端口、`params.columnContract`、DCM2 24 字节头、`/compute` 同步语义、既有签名 id 未改。
- 分类标签不进入 DCM2；只发送既有 `double` 代码，标签留在浏览器元数据。

## 验收

- `npm run typecheck`：通过。
- `npx vitest run`：`1401 passed / 20 skipped`。
- C++ 完整构建：通过。
- `ctest --test-dir build --output-on-failure`：`28 passed / 4 opt-in skipped`。
- 新增 ctest：`chart_analysis`、`chart_filter`。

## 本阶段未做

- SPC、控制图、Cp/Cpk、判异、回收率/校准结论。
- 审计、血缘、可重放脚本、撤销栈、函数卡或表达式引擎。
- EPS/TIFF/CMYK/字体嵌入等出版规范。
- 后端调度器改造、自动计算引擎、矩阵/函数卡范式。
