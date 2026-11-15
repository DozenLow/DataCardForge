# 黄金夹具（byte-level golden fixtures）— lead 定义，禁止重新生成

每个用例目录 = runner 的 --in 目录（ports.json + 输入帧 + meta.json）+ expected/（期望输出文件的逐字节副本）。

- 期望帧由 lead 按 DCM2 规范（docs/architecture/backend-protocol-v1.md「载荷编码」）用
  struct/array 独立构造，并经 third_party runtime（cpython 3.13.18 + numpy 2.5.4）实跑复核，
  不出自 backend/runner/ 的任何代码——oracle 独立性是差分夹具的前提。
- 帧与 manifest 一律逐字节比对（manifest 的 indent=2 + 尾换行是 runner 既定格式）。
- 输入帧的 names 不传递到输出：输出 names 规则是 DataFrame 用列名、否则 Pos.N（决策文档 §三、runner 规格 d）。
- 改动这里 = 改契约，需要 lead 重新手算并复核；flash 任务对 fixtures/ 只读。

用例：01-identity（恒等）· 02-transpose（转置：列主序下数据字节不变、仅头互换）·
03-nan-filter（NaN 行过滤，NaN 位型原样进出）· 04-int-widen（int64≤2^53 无损升 float64，C 序→列主序重排）·
05-multi-output（多输出帧序号 out.1.dcm2 + manifest 字段与顺序）。
