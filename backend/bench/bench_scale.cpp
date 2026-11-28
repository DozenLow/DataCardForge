// dc_bench_scale — 引擎规模基准：同一份输入从 rows/cols 小到大，量「引擎本身随规模怎么走」。
//
// 与 dc_bench 的分工：dc_bench 是带预算和基线的**回归门禁**（perf_gate，容易因机器不同假红）；
// 这里不读 budgets.json、不写 baseline.json、不设阈值，只把每次采样的耗时按 JSONL 打到
// stdout，由外面（root 的编排）决定怎么汇总、怎么对比。这个程序**不写任何文件**。
//
// 用法：
//   ./dc_bench_scale --rows 4096 --cols 8 --case elem --samples 5 --warmup 1
//   ./dc_bench_scale --rows 512  --cols 512 --case matmul --samples 5 --warmup 1
//   ./dc_bench_scale --rows 512  --cols 512 --case solve  --samples 5 --warmup 1
//
// 每个 case 一行一次采样，stdout 只有 JSONL（一行一个）：
//   {"i":1,"elapsed_ms":12.345678,"status":"ok"}
//   {"i":2,"elapsed_ms":0.500000,"status":"wrong_result","detail":"..."}
//   {"i":3,"elapsed_ms":0.000000,"status":"error","detail":"..."}
// i 从 1 开始；warmup 的采样不打印。耗时只包住「求值」这一段：输入创建在循环外，校验在
// 计时结束后，两者都不进 elapsed_ms。stderr 另打一行人类可读的参数与规模，方便对日志。
//
// 规模口径：
//   elem      rows × cols 个元素，表达式引用全部列（逐列一次）；耗时 ~ rows·cols
//   reduce    rows 个值的 MEAN 与 STD（列 a）；耗时 ~ rows
//   quantile  rows 个值的 QUANTILE(a, 0.9)（列 a，内部会排序）；耗时 ~ rows·log rows
//   window    rows 个值的 MOV(a, 65)（列 a，窗口固定 65）；耗时 ~ rows
//   matmul    A(rows×cols) * B(cols×cols)；耗时 ~ rows·cols²（方阵时是 N³）
//   solve     A(rows×rows) 的 SOLVE(A, b)；耗时 ~ rows³，必须 rows==cols
// 方阵家族由调用方把 rows 和 cols 设成相等（本程序只对 solve 检查这一点，matmul 允许长方）。
//
// 正确性：每个采样都独立校验，不信任引擎。elem/reduce/quantile/window 用 long double 按
// 定义重算代表点（首、中、尾）；matmul 抽三处点积重算；solve 用 b = A·x_known 反推的解析解，
// 再查代表行的相对残差与 x 误差——只要引擎给出「看起来合理但错」的数，这里就会是
// wrong_result。校验失败不会中止采样：外层拿到的是逐次结论。
//
// 退出码：0 = 每个采样都 ok；1 = 有 wrong_result；2 = 参数/输入/求值错误（未打印有效结论）。

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <random>
#include <string>
#include <vector>

#include "expression.h"
#include "matrix_value.h"

namespace {

using Clock = std::chrono::steady_clock;

// 让编译器没法把整段求值当死代码删掉（求值本身是外部符号，留着更明确）。
volatile double g_sink = 0.0;

constexpr int kDefaultCols = 16;
constexpr int kDefaultSamples = 5;
constexpr int kDefaultWarmup = 1;
constexpr int kWindowSize = 65;      // MOV 的固定窗口（奇数，和 bench_engine 的风格一致）
constexpr double kQuantile = 0.9;    // QUANTILE 的分位点
constexpr int64_t kMaxCells = 100000000;  // 单次分配的 行×列 上限，防止手滑的 --rows 拖垮机器
constexpr uint32_t kSeed = 20251126u;

// 校验容差：数据是 [-1,1] 的随机数，规模一大，双精度顺序求和与 long double 参考值之间
// 会有 1e-12 量级的分歧，所以用「绝对下限 + 相对量级」而不是逐位相等。真错的结果不会躲在
// 这个量级后面。
constexpr double kCellRelTol = 1e-8;   // 逐元素 / 聚合 / 窗口 / 分位
constexpr double kMatmulRelTol = 1e-9;
constexpr double kSolveResidualTol = 1e-9;  // 相对残差
constexpr double kSolveXRelTol = 1e-8;      // 与已知解析解的偏差

enum class Family { Elem, Reduce, Quantile, Window, Matmul, Solve };

struct CaseSpec {
  Family family;
};

const std::map<std::string, CaseSpec>& cases() {
  static const std::map<std::string, CaseSpec> k = {
      {"elem", {Family::Elem}},
      {"reduce", {Family::Reduce}},
      {"quantile", {Family::Quantile}},
      {"window", {Family::Window}},
      {"matmul", {Family::Matmul}},
      {"solve", {Family::Solve}},
  };
  return k;
}

struct Prepared {
  Family family = Family::Elem;
  bool matrix = false;
  std::vector<std::string> exprs;

  // 列模式输入：colNames 与 cols 一一对应，每列 length 个值。
  std::vector<std::string> colNames;
  std::vector<std::vector<double>> columns;
  size_t length = 0;

  // 矩阵模式输入：varNames 与 mats 一一对应。
  std::vector<std::string> varNames;
  std::vector<dc::MatVal> mats;
  int64_t rows = 0;
  int64_t cols = 0;

  // 各家族的校验参考量。
  std::vector<double> coeffs;  // elem：每列在表达式里的系数
  std::vector<double> xKnown;  // solve：构造 b 时用的解析解
};

// ── 确定性数据 ────────────────────────────────────────────────────────
// 53 位均匀数：比 uniform_real_distribution 少一层对象开销，规模上亿时创建快一截；
// 固定种子保证同一组参数每次的输入逐位相同。
class Rng {
 public:
  double uniform(double lo, double hi) {
    const double u = static_cast<double>(gen_() >> 11) * (1.0 / 9007199254740992.0);
    return lo + (hi - lo) * u;
  }

 private:
  std::mt19937_64 gen_{kSeed};  // uniform() consumes 53 bits of each 64-bit draw.
};

std::string jsonEscape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') {
      o.push_back('\\');
      o.push_back(c);
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned char>(c));
      o += buf;
    } else {
      o.push_back(c);
    }
  }
  return o;
}

void emitRow(int i, double elapsedMs, const char* status, const std::string& detail) {
  char ms[64];
  // 6 位小数 = 纳秒分辨率；规模基准的读数从 1e-3 ms 到 1e4 ms，这个精度够用也不会太啰嗦。
  std::snprintf(ms, sizeof ms, "%.6f", elapsedMs);
  std::string line = "{\"i\":" + std::to_string(i) + ",\"elapsed_ms\":" + ms +
                     ",\"status\":\"" + status + "\"";
  if (!detail.empty()) line += ",\"detail\":\"" + jsonEscape(detail) + "\"";
  line += "}\n";
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fflush(stdout);
}

// ── 逐家族准备输入（创建不计时）────────────────────────────────────────

void buildRandomColumn(Rng* rng, size_t n, std::vector<double>* out) {
  out->resize(n);
  for (double& x : *out) x = rng->uniform(-1.0, 1.0);
}

bool prepareCell(const CaseSpec& spec, int64_t rows, int64_t cols, Prepared* p, std::string* err) {
  Rng rng;
  const size_t n = static_cast<size_t>(rows);
  p->length = n;

  if (spec.family == Family::Elem) {
    const size_t nc = static_cast<size_t>(cols);
    p->coeffs.assign(nc, 1.0);
    p->colNames.reserve(nc);
    p->columns.reserve(nc);
    for (size_t j = 0; j < nc; ++j) {
      p->colNames.push_back("v" + std::to_string(j));
      std::vector<double> col;
      buildRandomColumn(&rng, n, &col);
      p->columns.push_back(std::move(col));
    }
    // 表达式引用每一列，系数交替正负（v0 固定 +1）：既让 cols 真正进入工作量，也让重算
    // 的参考公式足够简单，不依赖任何共享实现。
    std::string expr = p->colNames[0];
    for (size_t j = 1; j < nc; ++j) {
      const bool negative = (j % 2) == 1;
      p->coeffs[j] = negative ? -static_cast<double>(j + 1) : static_cast<double>(j + 1);
      expr += negative ? " - " : " + ";
      expr += std::to_string(j + 1) + "*" + p->colNames[j];
    }
    p->exprs = {expr};
    return true;
  }

  // reduce / quantile / window 都是单列长度 rows 的路径（cols 不参与工作量）。
  p->colNames = {"a"};
  std::vector<double> a;
  buildRandomColumn(&rng, n, &a);
  p->columns.push_back(std::move(a));
  switch (spec.family) {
    case Family::Reduce:
      // 均值与标准差一起测：两条聚合走同一个 reduce 分支，但 sd 要再过一遍。
      p->exprs = {"MEAN(a)", "STD(a)"};
      break;
    case Family::Quantile:
      p->exprs = {"QUANTILE(a, 0.9)"};
      break;
    case Family::Window:
      p->exprs = {"MOV(a, 65)"};
      break;
    default:
      *err = "internal: prepareCell got a matrix family";
      return false;
  }
  return true;
}

bool prepareMatrix(const CaseSpec& spec, int64_t rows, int64_t cols, Prepared* p, std::string* err) {
  Rng rng;
  p->matrix = true;
  p->rows = rows;
  p->cols = cols;

  if (spec.family == Family::Matmul) {
    const size_t R = static_cast<size_t>(rows);
    const size_t C = static_cast<size_t>(cols);
    std::vector<double> flatA(R * C);
    // 列主序：flat[i + j*R] 是 A(i, j)。
    for (size_t j = 0; j < C; ++j)
      for (size_t i = 0; i < R; ++i) flatA[i + j * R] = rng.uniform(-1.0, 1.0);
    std::vector<double> flatB(C * C);
    for (size_t j = 0; j < C; ++j)
      for (size_t i = 0; i < C; ++i) flatB[i + j * C] = rng.uniform(-1.0, 1.0);
    p->varNames = {"A", "B"};
    p->mats.push_back(dc::MatVal::fromFlat(flatA.data(), static_cast<int64_t>(R),
                                           static_cast<int64_t>(C)));
    p->mats.push_back(dc::MatVal::fromFlat(flatB.data(), static_cast<int64_t>(C),
                                           static_cast<int64_t>(C)));
    p->exprs = {"A * B"};
    return true;
  }

  if (spec.family != Family::Solve) {
    *err = "internal: prepareMatrix got a cell family";
    return false;
  }
  if (rows != cols) {
    *err = "solve needs a square system: --rows and --cols must be equal (got rows=" +
           std::to_string(rows) + " cols=" + std::to_string(cols) + ")";
    return false;
  }

  const size_t N = static_cast<size_t>(rows);
  // 对角占优：对角 2..2.5，非对角 ±1e-3。取值不改变 LU 的运算量，但让解良态、残差有意义。
  std::vector<double> flatA(N * N);
  for (size_t j = 0; j < N; ++j)
    for (size_t i = 0; i < N; ++i)
      flatA[i + j * N] = (i == j) ? (2.0 + rng.uniform(0.0, 0.5)) : rng.uniform(-1e-3, 1e-3);

  // 已知解 x_known（1..1.6），b 用 long double 由 A·x 反算：这样求解结果有一个解析参照，
  // 不需要另一个求解器。
  p->xKnown.resize(N);
  for (size_t i = 0; i < N; ++i) p->xKnown[i] = 1.0 + 0.1 * static_cast<double>(i % 7);
  std::vector<double> flatB(N);
  for (size_t i = 0; i < N; ++i) {
    long double sum = 0.0L;
    for (size_t j = 0; j < N; ++j) sum += static_cast<long double>(flatA[i + j * N]) * p->xKnown[j];
    flatB[i] = static_cast<double>(sum);
  }

  p->varNames = {"A", "B"};
  p->mats.push_back(dc::MatVal::fromFlat(flatA.data(), static_cast<int64_t>(N),
                                         static_cast<int64_t>(N)));
  p->mats.push_back(dc::MatVal::fromFlat(flatB.data(), static_cast<int64_t>(N), 1));
  p->exprs = {"SOLVE(A, B)"};
  return true;
}

bool prepare(const CaseSpec& spec, int64_t rows, int64_t cols, Prepared* p, std::string* err) {
  p->family = spec.family;
  if (spec.family == Family::Elem || spec.family == Family::Reduce ||
      spec.family == Family::Quantile || spec.family == Family::Window) {
    return prepareCell(spec, rows, cols, p, err);
  }
  return prepareMatrix(spec, rows, cols, p, err);
}

// ── 求值（只有这一段进计时）────────────────────────────────────────────

struct RunResult {
  std::vector<std::vector<double>> outputs;
  int64_t outRows = 0;
  int64_t outCols = 0;
};

bool runOnce(const Prepared& p, RunResult* r, std::string* err) {
  try {
    if (!p.matrix) {
      for (const std::string& expr : p.exprs) {
        r->outputs.push_back(dc::ExprEngine::evaluate(expr, p.colNames, p.columns, p.length));
        const std::vector<double>& out = r->outputs.back();
        g_sink += out.empty() ? 0.0 : out.front();
      }
    } else {
      int64_t outRows = 0;
      int64_t outCols = 0;
      r->outputs.push_back(dc::ExprEngine::evaluateMatrix(p.exprs[0], p.varNames, p.mats,
                                                          &outRows, &outCols));
      r->outRows = outRows;
      r->outCols = outCols;
      g_sink += r->outputs.back().empty() ? 0.0 : r->outputs.back().front();
    }
  } catch (const std::exception& e) {
    *err = e.what();
    return false;
  }
  return true;
}

// ── 独立校验（不计时）──────────────────────────────────────────────────

bool checkValue(double got, long double want, double relTol, const std::string& where,
                std::string* err) {
  const long double diff = std::fabs(static_cast<long double>(got) - want);
  const long double tol = static_cast<long double>(relTol) * (1.0L + std::fabs(want));
  if (!(diff <= tol)) {
    char buf[320];
    std::snprintf(buf, sizeof buf, "%s: want %.15Lg, got %.15g", where.c_str(), want, got);
    *err = buf;
    return false;
  }
  return true;
}

bool checkSize(const std::vector<double>& out, size_t want, const std::string& what,
               std::string* err) {
  if (out.size() != want) {
    *err = what + ": expected " + std::to_string(want) + " values, got " +
           std::to_string(out.size());
    return false;
  }
  return true;
}

bool verifyElem(const Prepared& p, const std::vector<double>& out, std::string* err) {
  if (!checkSize(out, p.length, "elem output", err)) return false;
  if (p.length == 0) return true;
  const size_t reps[] = {0, p.length / 2, p.length - 1};
  for (size_t idx : reps) {
    long double want = 0.0L;
    for (size_t j = 0; j < p.coeffs.size(); ++j) {
      want += static_cast<long double>(p.coeffs[j]) * p.columns[j][idx];
    }
    if (!checkValue(out[idx], want, kCellRelTol, "elem[" + std::to_string(idx) + "]", err))
      return false;
  }
  return true;
}

bool verifyReduce(const Prepared& p, const RunResult& r, std::string* err) {
  if (r.outputs.size() != 2) {
    *err = "reduce: expected 2 expressions (MEAN, STD), got " + std::to_string(r.outputs.size());
    return false;
  }
  const std::vector<double>& a = p.columns[0];
  const size_t n = a.size();
  if (n == 0) {
    *err = "reduce: empty input";
    return false;
  }
  if (!checkSize(r.outputs[0], n, "reduce MEAN output", err)) return false;
  if (!checkSize(r.outputs[1], n, "reduce STD output", err)) return false;
  // long double 两遍：先均值，再离差平方和。与引擎的 double 顺序求和独立。
  long double sum = 0.0L;
  for (double x : a) sum += x;
  const long double mean = sum / static_cast<long double>(n);
  long double ss = 0.0L;
  for (double x : a) {
    const long double d = static_cast<long double>(x) - mean;
    ss += d * d;
  }
  const long double stddev =
      n > 1 ? std::sqrt(ss / static_cast<long double>(n - 1)) : (n == 1 ? 0.0L : NAN);

  const size_t reps[] = {0, n / 2, n - 1};
  for (size_t idx : reps) {
    if (!checkValue(r.outputs[0][idx], mean, kCellRelTol,
                    "reduce MEAN[" + std::to_string(idx) + "]", err))
      return false;
    if (!checkValue(r.outputs[1][idx], stddev, kCellRelTol,
                    "reduce STD[" + std::to_string(idx) + "]", err))
      return false;
  }
  return true;
}

bool verifyQuantile(const Prepared& p, const std::vector<double>& out, std::string* err) {
  if (!checkSize(out, p.length, "quantile output", err)) return false;
  if (p.length == 0) return true;
  std::vector<double> sorted;
  sorted.reserve(p.columns[0].size());
  for (double x : p.columns[0])
    if (std::isfinite(x)) sorted.push_back(x);
  std::sort(sorted.begin(), sorted.end());
  if (sorted.empty()) {
    *err = "quantile: no finite input";
    return false;
  }
  // 与引擎同一份 R-7 定义（参考实现是 stats.ts:quantile），但这里独立重写一遍。
  const long double position = static_cast<long double>(sorted.size() - 1) * kQuantile;
  const size_t lower = static_cast<size_t>(std::floor(position));
  const size_t upper = static_cast<size_t>(std::ceil(position));
  long double want = sorted[lower];
  if (lower != upper) {
    const long double frac = position - static_cast<long double>(lower);
    want = static_cast<long double>(sorted[lower]) +
           (static_cast<long double>(sorted[upper]) - static_cast<long double>(sorted[lower])) *
               frac;
  }
  const size_t reps[] = {0, p.length / 2, p.length - 1};
  for (size_t idx : reps) {
    if (!checkValue(out[idx], want, kCellRelTol, "quantile[" + std::to_string(idx) + "]", err))
      return false;
  }
  return true;
}

bool verifyWindow(const Prepared& p, const std::vector<double>& out, std::string* err) {
  if (!checkSize(out, p.length, "window output", err)) return false;
  if (p.length == 0) return true;
  // 与引擎的 MOV 定义一致：w = 65，half = floor(w/2) = 32，两端截断后取均值。
  const size_t half = static_cast<size_t>(kWindowSize / 2);
  const std::vector<double>& a = p.columns[0];
  const size_t reps[] = {0, p.length / 2, p.length - 1};
  for (size_t idx : reps) {
    const size_t lo = idx > half ? idx - half : 0;
    const size_t hi = std::min(a.size(), idx + half + 1);
    long double sum = 0.0L;
    for (size_t k = lo; k < hi; ++k) sum += a[k];
    const long double want = sum / static_cast<long double>(hi - lo);
    if (!checkValue(out[idx], want, kCellRelTol, "window[" + std::to_string(idx) + "]", err))
      return false;
  }
  return true;
}

bool verifyMatmul(const Prepared& p, const RunResult& r, std::string* err) {
  const int64_t R = p.rows;
  const int64_t C = p.cols;
  if (r.outRows != R || r.outCols != C) {
    *err = "matmul: expected shape " + std::to_string(R) + "x" + std::to_string(C) + ", got " +
           std::to_string(r.outRows) + "x" + std::to_string(r.outCols);
    return false;
  }
  const std::vector<double>& out = r.outputs[0];
  if (!checkSize(out, static_cast<size_t>(R * C), "matmul output", err)) return false;
  const Eigen::MatrixXd& A = p.mats[0].eigen();
  const Eigen::MatrixXd& B = p.mats[1].eigen();
  const int64_t reps[][2] = {{0, 0}, {R - 1, C - 1}, {R / 2, C / 2}};
  for (const auto& rc : reps) {
    const int64_t rr = rc[0];
    const int64_t cc = rc[1];
    long double want = 0.0L;
    for (int64_t k = 0; k < C; ++k) want += static_cast<long double>(A(rr, k)) * B(k, cc);
    const size_t idx = static_cast<size_t>(rr + cc * R);
    if (!checkValue(out[idx], want, kMatmulRelTol,
                    "matmul[" + std::to_string(rr) + "," + std::to_string(cc) + "]", err))
      return false;
  }
  return true;
}

bool verifySolve(const Prepared& p, const RunResult& r, std::string* err) {
  const size_t N = static_cast<size_t>(p.rows);
  if (r.outRows != static_cast<int64_t>(N) || r.outCols != 1) {
    *err = "solve: expected shape " + std::to_string(N) + "x1, got " +
           std::to_string(r.outRows) + "x" + std::to_string(r.outCols);
    return false;
  }
  const std::vector<double>& x = r.outputs[0];
  if (!checkSize(x, N, "solve output", err)) return false;
  const Eigen::MatrixXd& A = p.mats[0].eigen();
  const Eigen::MatrixXd& b = p.mats[1].eigen();

  const size_t reps[] = {0, N / 2, N - 1};
  for (size_t row : reps) {
    // 解析解：构造 b 时用的 x_known 就应该是解。
    if (!checkValue(x[row], p.xKnown[row], kSolveXRelTol,
                    "solve x[" + std::to_string(row) + "]", err))
      return false;
    // 相对残差：不看解本身，只问 A·x 是否还等于 b（对「解漂了但仍在解空间」更敏感）。
    long double ax = 0.0L;
    long double scale = std::fabs(static_cast<long double>(b(row, 0)));
    for (size_t j = 0; j < N; ++j) {
      const long double aij = A(static_cast<int64_t>(row), static_cast<int64_t>(j));
      ax += aij * static_cast<long double>(x[j]);
      scale += std::fabs(aij) * std::fabs(static_cast<long double>(x[j]));
    }
    const long double residual = std::fabs(ax - static_cast<long double>(b(row, 0)));
    const long double tol = static_cast<long double>(kSolveResidualTol) * (scale + 1.0L);
    if (!(residual <= tol)) {
      char buf[320];
      std::snprintf(buf, sizeof buf, "solve residual[%zu]: |Ax-b| = %.6Lg, tolerance %.6Lg", row,
                    residual, tol);
      *err = buf;
      return false;
    }
  }
  return true;
}

bool verify(const Prepared& p, const RunResult& r, std::string* err) {
  switch (p.family) {
    case Family::Elem:
      return verifyElem(p, r.outputs[0], err);
    case Family::Reduce:
      return verifyReduce(p, r, err);
    case Family::Quantile:
      return verifyQuantile(p, r.outputs[0], err);
    case Family::Window:
      return verifyWindow(p, r.outputs[0], err);
    case Family::Matmul:
      return verifyMatmul(p, r, err);
    case Family::Solve:
      return verifySolve(p, r, err);
  }
  *err = "internal: unknown family";
  return false;
}

// ── 参数解析 ───────────────────────────────────────────────────────────

void usage(std::FILE* to) {
  std::fprintf(to,
               "usage: dc_bench_scale --rows N --case NAME [--cols N] [--samples N] [--warmup N]\n"
               "  cases: elem reduce quantile window matmul solve\n"
               "  --rows     rows of the input (required; solve needs --rows == --cols)\n"
               "  --cols     columns of the input (default %d)\n"
               "  --samples  measured samples, printed as JSONL (default %d)\n"
               "  --warmup   untimed samples before measuring (default %d)\n"
               "stdout is JSONL only: {\"i\":N,\"elapsed_ms\":X,\"status\":\"ok|wrong_result|"
               "error\"[,\"detail\":\"...\"]}\n",
               kDefaultCols, kDefaultSamples, kDefaultWarmup);
}

bool parseLong(const std::string& text, const char* what, int64_t lo, int64_t hi,
               int64_t* out) {
  if (text.empty()) {
    std::fprintf(stderr, "dc_bench_scale: %s needs a value\n", what);
    return false;
  }
  errno = 0;
  char* end = nullptr;
  const long long v = std::strtoll(text.c_str(), &end, 10);
  if (errno != 0 || end == text.c_str() || *end != '\0') {
    std::fprintf(stderr, "dc_bench_scale: %s expects an integer, got \"%s\"\n", what,
                 text.c_str());
    return false;
  }
  if (v < lo || v > hi) {
    std::fprintf(stderr, "dc_bench_scale: %s out of range [%lld, %lld]: %lld\n", what,
                 static_cast<long long>(lo), static_cast<long long>(hi), v);
    return false;
  }
  *out = static_cast<int64_t>(v);
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  bool haveRows = false;
  int64_t rows = 0;
  int64_t cols = kDefaultCols;
  int64_t samples = kDefaultSamples;
  int64_t warmup = kDefaultWarmup;
  std::string caseName;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto value = [&](const char* what) -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "dc_bench_scale: %s needs a value\n", what);
        std::exit(2);
      }
      return argv[++i];
    };
    if (arg == "--rows") {
      if (!parseLong(value("--rows"), "--rows", 1, kMaxCells, &rows)) return 2;
      haveRows = true;
    } else if (arg == "--cols") {
      if (!parseLong(value("--cols"), "--cols", 1, kMaxCells, &cols)) return 2;
    } else if (arg == "--samples") {
      if (!parseLong(value("--samples"), "--samples", 1, 1000000, &samples)) return 2;
    } else if (arg == "--warmup") {
      if (!parseLong(value("--warmup"), "--warmup", 0, 1000000, &warmup)) return 2;
    } else if (arg == "--case") {
      caseName = value("--case");
    } else if (arg == "--help" || arg == "-h") {
      usage(stdout);
      return 0;
    } else {
      std::fprintf(stderr, "dc_bench_scale: unknown argument \"%s\"\n", arg.c_str());
      usage(stderr);
      return 2;
    }
  }

  if (!haveRows) {
    std::fprintf(stderr, "dc_bench_scale: --rows is required\n");
    usage(stderr);
    return 2;
  }
  if (caseName.empty()) {
    std::fprintf(stderr, "dc_bench_scale: --case is required\n");
    usage(stderr);
    return 2;
  }
  const auto found = cases().find(caseName);
  if (found == cases().end()) {
    std::fprintf(stderr, "dc_bench_scale: unknown case \"%s\" (try: elem reduce quantile "
                         "window matmul solve)\n",
                 caseName.c_str());
    return 2;
  }
  const CaseSpec& spec = found->second;

  // 先挡住会直接 OOM 或溢出的规模，再分配。rows/cols 已各自 ≤ kMaxCells（1e8），
  // 乘积最大 1e16，仍在 int64 范围内，不会溢出。
  int64_t needCells = rows;
  switch (spec.family) {
    case Family::Elem:
      needCells = rows * cols;
      break;
    case Family::Matmul:
      needCells = rows * cols + cols * cols;
      break;
    case Family::Solve:
      needCells = rows * rows;
      break;
    default:
      break;
  }
  if (needCells > kMaxCells) {
    std::fprintf(stderr, "dc_bench_scale: %s needs %lld cells, limit is %lld (lower --rows/--cols)\n",
                 caseName.c_str(), static_cast<long long>(needCells),
                 static_cast<long long>(kMaxCells));
    return 2;
  }

  Prepared prepared;
  std::string err;
  try {
    if (!prepare(spec, rows, cols, &prepared, &err)) {
      std::fprintf(stderr, "dc_bench_scale: %s\n", err.c_str());
      return 2;
    }
  } catch (const std::exception& e) {
    // bad_alloc 也走这里：把「规模太大」变成一句能读的报错，而不是 std::terminate。
    std::fprintf(stderr, "dc_bench_scale: failed to prepare inputs: %s\n", e.what());
    return 2;
  }

  std::fprintf(stderr, "dc_bench_scale: case=%s rows=%lld cols=%lld samples=%lld warmup=%lld\n",
               caseName.c_str(), static_cast<long long>(rows), static_cast<long long>(cols),
               static_cast<long long>(samples), static_cast<long long>(warmup));

  // warmup 不打印：它只负责让分配器/缓存/分支预测进入稳态。
  for (int64_t w = 0; w < warmup; ++w) {
    RunResult warm;
    if (!runOnce(prepared, &warm, &err)) {
      std::fprintf(stderr, "dc_bench_scale: warmup evaluation failed: %s\n", err.c_str());
      return 2;
    }
  }

  int wrong = 0;
  int errored = 0;
  for (int64_t s = 1; s <= samples; ++s) {
    RunResult result;
    std::string evalErr;
    const auto t0 = Clock::now();
    const bool evaluated = runOnce(prepared, &result, &evalErr);
    const auto t1 = Clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    if (!std::isfinite(elapsedMs) || elapsedMs < 0.0) elapsedMs = 0.0;

    if (!evaluated) {
      ++errored;
      emitRow(static_cast<int>(s), elapsedMs, "error", evalErr);
      continue;
    }
    std::string why;
    if (!verify(prepared, result, &why)) {
      ++wrong;
      emitRow(static_cast<int>(s), elapsedMs, "wrong_result", why);
      continue;
    }
    emitRow(static_cast<int>(s), elapsedMs, "ok", "");
  }

  if (errored > 0) {
    std::fprintf(stderr, "dc_bench_scale: %d/%lld samples errored\n", errored,
                 static_cast<long long>(samples));
    return 2;
  }
  if (wrong > 0) {
    std::fprintf(stderr, "dc_bench_scale: %d/%lld samples returned wrong results\n", wrong,
                 static_cast<long long>(samples));
    return 1;
  }
  return 0;
}
