# CI 测试执行清单

这里按套件记录谁来跑、何时跑。不手抄用例名或数量：实际用例以 Vitest JSON 和 CTest JUnit 为准，在 Actions 对应作业的 artifacts 下载。

| 测试或检查 | 作业 / 报告 | 何时执行、跳过规则 |
|---|---|---|
| Vitest 默认用例 | `typecheck-and-test` / `vitest-unit` | 每个 PR 和推送 `main`；两组真实后端用例在这一步预期跳过，另有作业实际执行。类型检查和生产构建不是测试。 |
| `backendIntegration` 与 `xlayerGoldenFrames` 的真实后端用例 | `e2e-smoke` / `live-backend-integration` | 同上；必须分别有实际通过的用例，缺失、空组或跳过都失败。两文件里的离线用例不计为集成。 |
| Chromium smoke | `e2e-smoke` / 作业日志 | 同上；使用同一真实后端与生产预览。 |
| CTest 默认用例 | `backend-test` / `backend-ctest` | 同上；`python_node`、`script_check`、`xlayer_fixture_node`、`py_runner`、`py_fixtures` 必须执行并通过；缺 runtime 或跑不了 NumPy 会提前失败。测试输出 `SKIP:` 即使退出码是 0 也不算通过。 |
| `diff_fuzz`、`nodes_stress`、`http_stress`、`perf_gate`、`perf_gate_paths` | 尚未接入按需 CI；仍可本地运行 | 不设定时触发。需要时在具备依赖的开发环境运行：`DC_RUN_FUZZ=1`、`DC_RUN_STRESS=1` 或 `DC_RUN_BENCH=1` 配合 `ctest -R` 选中对应套件。常规 CTest 中预期跳过；fuzz/stress/perf_gate_paths 在 CMake 未找到系统 Python 3 时不注册，不能把未注册当成通过。 |
| Windows / macOS | `windows-compile`、`macos-compile` / 作业日志 | 每个 PR 和推送 `main`；目前仅编译，不计为该平台测试通过。 |

先看作业日志判断是测试失败还是环境没准备好，再查报告确认是通过、失败、预期未运行，还是必跑项漏跑。报告缺失不代表通过。CI 规则见 [工作流](../.github/workflows/ci.yml)。

## 提交前按需长测

在仓库根执行，`$BUILD` 指向 `backend/` 下已构建的独立 Release 构建目录。先用 `ctest --test-dir "$BUILD" -N` 确认注册，再串行运行；`http_stress` 使用 37911，需先确认该端口空闲。相关测试使用临时实例，不要指向常驻后端。

```bash
DC_RUN_FUZZ=1 DC_RUN_STRESS=1 \
  ctest --test-dir "$BUILD" -j1 --output-on-failure --no-tests=error \
    -R '^(diff_fuzz|nodes_stress|http_stress)$'
```

性能门禁不自带有效的本机基线和预算。`DC_RUN_BENCH=1 ctest -R '^perf_gate$'` 使用默认路径；缺预算文件会失败，不是性能超限，也不算通过。默认路径在编译期锚定源码 `backend/bench`，嵌套构建目录（`backend/build/<子目录>`）作为 CWD 也能解析；`DC_RUN_BENCH=1 ctest -R '^perf_gate_paths$'` 回归这一解析、缺文件时按绝对路径报错的 fail closed 行为，以及基线/预算文件不被改动。有事先认可的基线和预算时可显式传入绝对路径：

```bash
DC_RUN_BENCH=1 "$BUILD/dc_bench" --baseline "$BASELINE" --budgets "$BUDGETS" --json "$REPORT"
```

不要用待验代码新采的基线给这一次放行。参见 [性能门禁决策](decisions/2026-10-29-perf-gate.md#L115-L133) 的历史参考；机器标识不同就不要把比值视为严格回归门禁。压力测试通过只说明已覆盖的并发请求通过，不代表跑过近 OOM 或真实代理上传边界。

## 已覆盖的边界

- **文件导入：** [DOM 回归](../web/tests/AppImports.dom.test.tsx)检查画布混投保留有效文件、卡内混投整批拒绝、相同大小和修改时间不串数据；等待选择文件或解析时切槽，以及旧请求晚于新请求完成，都不能覆盖其他数据。
- **工作区恢复：** [Store 回归](../web/tests/workspaceStore.test.ts)检查直接从 A 切到 B 时复用的本地 ID 使用 B 的后端矩阵，旧批次停止上传；[文件回归](../web/tests/workspaceFile.test.ts)检查畸形卡片在文件读取或直接加载时均被拒绝，旧工作区和在途上传不受影响。
- **HTTP 合同：** [真实后端集成](../web/tests/backendIntegration.test.ts)检查 Summary 筛选的大小写、去重、源表列顺序及未知列的原始诊断名；矩阵 DELETE 检查成功、缺失、仍有所有者和仍被引用，核对状态码与响应体。
- **图卡数据缓存：** [文件回归](../web/tests/workspaceChartFile.test.ts)走真实 serializeWorkspace → File → readWorkspace → loadSnapshot 往返，检查图卡缓存的非有限值（NaN 与 ±Inf）、分类字典按原码、X/分组列及其端口；旧文件的 null 读成缺测而非 0。

仍需单独验证 Windows / macOS 的实际运行。
