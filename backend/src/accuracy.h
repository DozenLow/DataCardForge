// accuracy.h — on-demand accuracy estimate for one node's result.
//
// Deliberately NOT part of the result envelope: it is computed only when a client asks,
// it never changes what the node publishes, and it never touches NodeState. The node's
// already-published result is the only thing it is compared against.
#pragma once

#include <cstdint>
#include <string>

namespace dc {

class MatrixStore;
class NodeRegistry;

struct AccuracyReport {
  // "ok"         the result is reproducible and the estimate clears the threshold
  // "degraded"   it is reproducible but the estimate says digits were lost
  // "unsupported" no estimate was produced — the caller must render NOTHING, never "fine"
  std::string status = "unsupported";
  std::string reason;           // why unsupported (also the tooltip's fallback)
  double kappa = 0.0;           // relative condition number, measured by perturbation
  double digits = 0.0;          // estimated trustworthy significant digits
  double digitsLost = 0.0;      // 15.95 - digits, clamped at 0
};

// Measures how strongly the node's own output responds to a relative perturbation of its
// input data. Requires the node to be Done and every input to be a stored matrix (depth-1);
// deeper chains return "unsupported" rather than a number that would be blind to inherited
// error.
AccuracyReport checkAccuracy(NodeRegistry* nodes, MatrixStore* store, int64_t nodeId);

}  // namespace dc
