#include "accuracy.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <random>
#include <vector>

#include "expression.h"
#include "matrix_store.h"
#include "nodes.h"
#include "signature.h"
#include "summary.h"

namespace dc {

namespace {

constexpr double kU = std::numeric_limits<double>::epsilon() / 2.0;
// The re-evaluation must reproduce the published result before anything is reported. If it
// cannot, the two code paths disagree and any kappa derived from one of them is fiction —
// so the honest answer is "unsupported", not a number.
constexpr double kReproduceTolerance = 1e-12;
// Below this many trustworthy digits the result is worth warning about. Eight is chosen
// against the measured data: a 1e6-centred variance keeps 9.3 and a 1e8-centred one 7.7,
// so the line separates them, and 8 digits still exceeds any instrument's resolution.
constexpr double kDegradedDigits = 8.0;

struct PortData {
  std::string alias;
  std::vector<std::vector<double>> columns;
  std::vector<std::string> labels;
};

// Re-evaluate a depth-1 node from raw columns. Only the two signatures the workbench
// displays as result tables are handled; anything else returns false so the caller can
// decline instead of guessing.
bool evaluateOnce(const ComputeNode& node, const std::vector<PortData>& ports, size_t rows,
                  std::vector<std::vector<double>>* out) {
  out->clear();
  if (node.signatureId == kSigExpressionColumns) {
    const Json* formulas = node.params.find("formulas");
    if (formulas == nullptr || !formulas->isArray() || formulas->items().empty()) return false;

    std::vector<std::string> names;
    std::vector<std::vector<double>> data;
    std::vector<AliasRange> aliases;
    for (const PortData& p : ports) {
      AliasRange range;
      range.alias = p.alias;
      range.first = names.size();
      range.count = p.columns.size();
      for (size_t i = 0; i < p.columns.size(); ++i) {
        names.push_back(p.labels[i]);
        data.push_back(p.columns[i]);
      }
      aliases.push_back(range);
    }
    const size_t rowLength = rows == 0 ? 1 : rows;
    for (const Json& f : formulas->items()) {
      const std::string expression = f["expression"].isString() ? f["expression"].asString() : "";
      out->push_back(ExprEngine::evaluate(expression, names, data, rowLength, aliases));
    }
    return true;
  }

  if (node.signatureId == kSigSummary) {
    if (ports.empty()) return false;
    std::vector<Column> inputColumns;
    inputColumns.reserve(ports[0].columns.size());
    for (size_t i = 0; i < ports[0].columns.size(); ++i) {
      Column c;
      Matrix::labelParsed(ports[0].labels[i], &c.posName, &c.annotation);
      c.data = ports[0].columns[i];
      inputColumns.push_back(std::move(c));
    }
    SummaryResult table = evaluateSummary(inputColumns, node.params);
    if (!table.errorCode.empty()) return false;
    for (const Column& c : table.columns) out->push_back(c.data);
    return true;
  }

  return false;
}

// Column-major flattening, which is the order the stored result matrix uses.
std::vector<double> flatten(const std::vector<std::vector<double>>& columns) {
  std::vector<double> flat;
  for (const auto& c : columns) flat.insert(flat.end(), c.begin(), c.end());
  return flat;
}

double maxRelativeGap(const std::vector<double>& a, const std::vector<double>& b) {
  if (a.size() != b.size()) return std::numeric_limits<double>::infinity();
  double worst = 0.0;
  for (size_t i = 0; i < a.size(); ++i) {
    if (!std::isfinite(a[i]) || !std::isfinite(b[i])) continue;
    const double scale = std::max(std::fabs(a[i]), std::fabs(b[i]));
    if (scale == 0.0) continue;
    worst = std::max(worst, std::fabs(a[i] - b[i]) / scale);
  }
  return worst;
}


}  // namespace

AccuracyReport checkAccuracy(NodeRegistry* nodes, MatrixStore* store, int64_t nodeId) {
  AccuracyReport report;

  const auto node = nodes->get(nodeId);
  if (!node) {
    report.reason = "unknownNode";
    return report;
  }
  if (node->state != NodeState::Done || node->resultMatrixIds.empty()) {
    // Not "fine" — not computable. The caller renders nothing.
    report.reason = "notComputed";
    return report;
  }

  std::vector<PortData> ports;
  size_t rows = 0;
  for (const PortBinding& b : node->inputs) {
    if (b.sourceNodeId >= 0) {
      // A chained input means part of the error is inherited, and this node-local
      // measurement would be blind to it. Say so instead of reporting a comfortable number.
      report.reason = "chainedInput";
      return report;
    }
    if (b.sourceMatrixId < 0) {
      report.reason = "unboundInput";
      return report;
    }
    Matrix m;
    if (!store->snapshot(b.sourceMatrixId, &m)) {
      report.reason = "unknownMatrix";
      return report;
    }
    PortData p;
    p.alias = b.varName.empty() ? b.portId : b.varName;
    const bool singleColumn = b.mode == "cell" && b.columnIndex >= 0;
    const size_t first = singleColumn ? static_cast<size_t>(b.columnIndex) : 0;
    const size_t last = singleColumn ? first + 1 : m.columnCount();
    if (last > m.columnCount()) {
      report.reason = "unknownColumn";
      return report;
    }
    for (size_t c = first; c < last; ++c) {
      p.columns.push_back(m.column(c).data);
      p.labels.push_back(Matrix::label(m.column(c)));
    }
    if (rows == 0) rows = m.rowCount();
    ports.push_back(std::move(p));
  }

  std::vector<std::vector<double>> base;
  try {
    if (!evaluateOnce(*node, ports, rows, &base)) {
      report.reason = "unsupportedSignature";
      return report;
    }
  } catch (const std::exception&) {
    report.reason = "recomputeFailed";
    return report;
  }

  // Must reproduce the published result, or nothing below means anything.
  Matrix published;
  if (!store->snapshot(node->resultMatrixId(), &published)) {
    report.reason = "noResultMatrix";
    return report;
  }
  std::vector<std::vector<double>> publishedColumns;
  for (size_t c = 0; c < published.columnCount(); ++c) {
    publishedColumns.push_back(published.column(c).data);
  }
  const std::vector<double> baseFlat = flatten(base);
  if (maxRelativeGap(baseFlat, flatten(publishedColumns)) > kReproduceTolerance) {
    report.reason = "cannotReproduce";
    return report;
  }

  // Row-order scan: the SAME values, fed in a different order. The exact answer cannot
  // change (summation is associative in real arithmetic); the rounding can. So the gap
  // between the two results is a direct sample of the rounding noise — which is exactly
  // what a coherent data perturbation could not see, because two cancelling intermediates
  // move together and cancel again.
  //
  // The gap is a SAMPLE, not a bound: two orders can round alike and report zero jitter
  // while the true error is nonzero. The status therefore means "no jitter detected",
  // never "accurate", and the UI copy has to say the same thing.
  std::vector<size_t> order(rows);
  for (size_t i = 0; i < rows; ++i) order[i] = i;
  {
    std::mt19937_64 gen(0x9E3779B97F4A7C15ULL ^ static_cast<uint64_t>(nodeId));
    std::shuffle(order.begin(), order.end(), gen);
  }
  std::vector<size_t> inverse(rows);
  for (size_t i = 0; i < rows; ++i) inverse[order[i]] = i;

  std::vector<PortData> shuffled = ports;
  for (PortData& p : shuffled) {
    for (auto& col : p.columns) {
      if (col.size() != rows) {
        report.reason = "raggedInput";
        return report;
      }
      std::vector<double> reordered(rows);
      for (size_t i = 0; i < rows; ++i) reordered[i] = col[order[i]];
      col = std::move(reordered);
    }
  }

  std::vector<std::vector<double>> shuffledOut;
  try {
    if (!evaluateOnce(*node, shuffled, rows, &shuffledOut)) {
      report.reason = "recomputeFailed";
      return report;
    }
  } catch (const std::exception&) {
    report.reason = "recomputeFailed";
    return report;
  }

  const std::vector<double> shuffledFlat = flatten(shuffledOut);
  if (rows == 0 || shuffledFlat.size() != baseFlat.size()) {
    report.reason = "shapeChanged";
    return report;
  }

  // Output row i belongs to input row order[i], so undo the permutation before comparing.
  // For an aggregation every row holds the same value and this is a no-op.
  double worst = 0.0;
  for (size_t k = 0; k < baseFlat.size(); ++k) {
    const size_t column = k / rows;
    const double a = baseFlat[k];
    const double b = shuffledFlat[column * rows + inverse[k % rows]];
    if (!std::isfinite(a) || !std::isfinite(b) || a == 0.0) continue;
    worst = std::max(worst, std::fabs(a - b) / std::fabs(a));
  }

  report.relativeGap = worst;
  if (worst == 0.0) {
    report.digits = 15.95;
    report.digitsLost = 0.0;
    report.status = "ok";
    return report;
  }
  report.digits = std::clamp(-std::log10(worst), 0.0, 15.95);
  report.digitsLost = 15.95 - report.digits;
  report.status = report.digits >= kDegradedDigits ? "ok" : "degraded";
  return report;
}

}  // namespace dc
