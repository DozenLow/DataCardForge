// Server-side compute nodes: input bindings, formula, result matrix, state machine.
// The dependency graph mirrors web/src/core/DependencyGraph.ts (dedup + cycle refusal)
// with the addition that a node's N input ports are added ATOMICALLY: if any
// edge would close a loop, no edge is registered (docs/decisions/2026-10-17-backend-owns-compute.md).
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "expression.h"
#include "json.h"
#include "matrix_store.h"

namespace dc {

// ── DCM2 frame codec (the ONLY implementation in the process) ─────────────────
// These used to live inside http_server.cpp. They moved here because the script card's data
// channel is part of compute, not of HTTP: the dispatch writes one frame per input port and
// reads the runner's output frame, and dc_core must not depend on the HTTP layer (the node
// tests link dc_core WITHOUT http_server.cpp, so calling back into it would not even link).
// docs/decisions/2026-11-15-python-script-card.md §五: "runner 与 C++ 侧共用同一实现，不写
// 第二份帧编码". http_server.cpp keeps its public encodeMatrixFrame() as a forwarding
// wrapper, so the wire path and its bytes are unchanged.
//
// Frame layout (little-endian): magic "DCM2" u32, rows u32, cols u32, namesLen u32,
// totalRows u32, totalCols u32 (24-byte header), data f64[rows*cols] column-major, names
// JSON array of UTF-8 labels. A window frame carries its own rows/cols plus the full matrix
// shape in totalRows/totalCols; a full matrix passes the same value twice.
std::string encodeDcm2Frame(const std::vector<std::vector<double>>& columns,
                            const std::vector<std::string>& names, size_t rows,
                            size_t totalRows, size_t totalCols);
// Decodes a frame body. `maxBytes` bounds the declared shape (uploads keep the 32 MiB HTTP
// limit; a script output passes the real file size, because a legitimate result table has no
// business being silently capped at the request-body limit).
bool decodeDcm2Frame(const std::string& frame, std::vector<Column>* columns, std::string* err,
                     size_t maxBytes = 32u * 1024u * 1024u);
// Reads and decodes a frame file (script-card output frames).
bool readDcm2FrameFile(const std::string& path, std::vector<Column>* columns, std::string* err);

// Repository root discovery for the script card: the nearest ancestor of the working
// directory (then of the executable) that holds backend/runner/runner.py. Empty when the
// binary is not running out of a source checkout.
std::string findRepoRoot();

// The vendored interpreter a script run uses. Declared here (not only inside nodes.cpp)
// because /api/script/check must resolve the interpreter with the SAME rule a run does — a
// second copy of this logic is exactly how "the check passes but the run cannot find python"
// gets written. The body still lives in nodes.cpp: declaration move only, no behaviour change.
struct PythonRuntime {
  std::filesystem::path dir;
  // <dir>/bin/python3 (python.exe on Windows). Empty ⇒ no usable interpreter, with the
  // *howMissing string (passed to resolvePythonRuntime) saying why.
  std::filesystem::path python;
};
// DC_PYRUNTIME wins outright — a broken override is reported, never silently replaced by the
// checkout's copy — else <repo>/third_party/pyruntime.
PythonRuntime resolvePythonRuntime(std::string* howMissing);

enum class NodeState { Dirty, Computing, Done, Error };

// Why a node sits in `Dirty`. The four states are the light contract (grey / yellow /
// green / red). "Never asked to compute" and "upstream changed" are both grey, and the
// client has to tell them apart — a fifth state would fork the light semantics for every
// consumer, so the cause travels as an additive field (`reason`) instead.
enum class DirtyReason { None, NotRequested, UpstreamChanged, DefinitionChanged };

const char* nodeName(NodeState s);
const char* dirtyReasonName(DirtyReason r);

// v2 port binding (docs/decisions/2026-10-26-card-schema-v2.md, port-semantics-v1.md).
//
// `portId` is the identity: connections are recognised by it, never by position. It is
// additive so v1 clients that only send `varName` keep working — `varName` stays as the
// declared variable the expression engine resolves against, and `portId` falls back to it.
struct PortBinding {
  std::string portId;               // stable identity; v1 clients may omit it (→ varName)
  std::string varName;              // declared variable name ("a", "A", …)
  std::string mode = "cell";        // "cell" | "matrix" — explicit field, never inferred by callers
  int64_t sourceMatrixId = -1;      // when bound to a stored matrix
  int64_t sourceNodeId = -1;        // when bound to another node's result
  int32_t sourceOutputIndex = 0;    // which output of a K-output node (v1 data is always 0)
  // `mode == "cell"`: bind exactly this one column of the source (`columnIndex >= 0`).
  // This is what the field always meant — v1 never read it, so a "cell" port silently
  // bound the whole table. Signatures that declare a column (not a table) need it.
  int32_t columnIndex = -1;
};

struct ComputeNode {
  int64_t id = 0;
  std::string kind = "function";    // v1 only function cards live here
  std::string signatureId;          // v2: registry entry; empty ⇒ the v1 `formula` path
  std::vector<PortBinding> inputs;  // ordered; identity is `portId`, this order is display only
  std::string formula;              // v1 single-expression formula
  Json params = Json::object();     // v2 parameters (separate from the dataflow graph)
  // Outputs indexed by the signature's output ordinal. Always ≥ 1 element once created
  // (v1 nodes have exactly one). K is fixed by the signature, never by the data.
  std::vector<int64_t> resultMatrixIds;
  // Output 0, which is also what the legacy protocol field `resultMatrixId` reports.
  int64_t resultMatrixId() const { return resultMatrixIds.empty() ? -1 : resultMatrixIds[0]; }
  // Declared outputs beyond output 0 (script cards only). A JSON array of
  // {"name": "<declared output name>", "matrixId": <stored matrix>, "rows": <n>, "cols": <n>},
  // one entry per `params.outputs[1..]`, allocated when the card is created so the ids are
  // stable (K is fixed by the declaration: the run fills them, it never adds or drops one).
  // Every other signature leaves this empty, which is why output semantics elsewhere do not
  // change — the decision doc's v1 output-selector plan (§三).
  Json extraOutputs = Json::array();
  NodeState state = NodeState::Dirty;
  // Meaningful while state == Dirty. Never overwrites a user-facing cause (see
  // markStaleLocked): "not requested yet" stays true until the client asks to compute.
  DirtyReason dirtyReason = DirtyReason::None;
  std::string errorCode;            // structured code when state == Error
  Json errorParams = Json::object();
  // Additive ADVICE, never a state: unit warnings found by a static check of the card's
  // expressions (units.h `checkExpressionUnitWarnings`). Empty for every card that has
  // nothing to report and for every signature that does not run the checker, which is why
  // no existing behaviour or fixture moves. A warning cannot fail a node, change a number
  // or flip `state` — it is published next to the result and dropped whenever the result
  // is (docs/tasks/2026-11-19-units-l1.md §L1b / B1).
  Json warnings = Json::array();
  // Bumped by every definition change (inputs / formula / params). Evaluation runs
  // unlocked (max-headroom), so it must refuse to publish a result computed from a
  // definition that has since been replaced — that would be exactly the "downstream reads
  // stale numbers" class the 2026-10-18 audit went after.
  uint64_t definitionVersion = 0;
};

class EventBus {
 public:
  // Monotonic sequence numbers so the client can long-poll `?since=<seq>` safely.
  void publish(Json event);
  // Returns events with seq > since. Blocks up to timeoutMs waiting for new ones.
  std::vector<std::pair<int64_t, Json>> wait(int64_t since, int timeoutMs);

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::pair<int64_t, Json>> log_;
  int64_t nextSeq_ = 1;
  static constexpr size_t kMaxLog = 4096;
};

class NodeRegistry {
 public:
  NodeRegistry(MatrixStore* store, EventBus* bus) : store_(store), bus_(bus) {}

  // Create a node and register all its edges atomically. On a cycle nothing is created
  // and the offending path is returned (outermost node first, repeats the start node).
  struct CreateResult {
    int64_t nodeId = -1;
    std::vector<int64_t> cyclePath;  // empty when accepted
    std::string errorCode;           // structured refusal when nodeId < 0 and no cycle
  };
  CreateResult create(const std::vector<PortBinding>& inputs, const std::string& formula);

  // v2: create from a registry signature. K outputs come from the signature, so the node
  // gets exactly K result matrices at creation (never data-dependent).
  // Unknown signature ⇒ {nodeId=-1, errorCode="unknownSignature"}.
  CreateResult createV2(const std::string& signatureId, const std::vector<PortBinding>& inputs,
                        const Json& params);

  bool update(int64_t nodeId, const std::string* formula,
              const std::vector<PortBinding>* inputs, std::vector<int64_t>* cycleOut);

  // Replace the parameter bag (v2). Marks the node dirty.
  bool updateParams(int64_t nodeId, const Json& params);

  // Refuses with hasDependents semantics left to the caller (close protection is a UI
  // rule; the registry just reports it).
  bool remove(int64_t nodeId, bool* hadDependents);

  // Delete a stored matrix that no node reads and no node owns as a result.
  // Refuses (hadDependents=true) otherwise — the caller maps that to 409.
  bool removeMatrix(int64_t matrixId, bool* hadDependents);

  // Returns a copy: a raw pointer escaped the lock and was a use-after-free window
  // for a concurrent DELETE (see the 2026-10-18 audit).
  std::optional<ComputeNode> get(int64_t nodeId) const;
  std::vector<int64_t> dependentsOf(int64_t nodeId) const;

  // Recompute `nodeId` now, then transitively refresh every dependent in topological
  // order (coalesced: one change triggers each downstream node at most once).
  // Publishes computing/done/error events for every touched node.
  //
  // Signatures declared `explicitCompute` (builtin:summary) are NOT evaluated here: they
  // are marked dirty with a reason and their previous results are dropped, because a
  // summary exists exactly so that the user decides when to pay for it. Their dependents
  // are marked dirty too — an empty upstream is "not ready yet", never a data error.
  void recomputeSubtree(int64_t nodeId);

  // Explicit evaluation request (the only trigger for `explicitCompute` signatures,
  // POST /api/nodes/{id}/compute): evaluate this node — bypassing the laziness rule —
  // then refresh its dependents with the normal rules.
  void computeNow(int64_t nodeId);

  // Called when a stored matrix changed (file switch / edit): mark + recompute all
  // nodes reading it, transitively.
  void onMatrixChanged(int64_t matrixId);

  // Kill the process group of a running script-card evaluation (POST /api/nodes/{id}/cancel,
  // the same kill path the timeout uses — decision §五). Returns false when nothing of this
  // node is running, so the caller can keep answering "no running job to cancel". The
  // evaluation thread then reaps the child and puts the node back to "not computed yet".
  bool cancelRun(int64_t nodeId);

  std::vector<int64_t> allNodeIds() const;

  // Graph keys are namespaced: node ids are positive; matrix sources are -(matrixId+1).
  // Node and matrix counters both start at 1, so raw ids would collide (smoke test found
  // a fresh node "depending on itself" because its own id equalled the bound matrix id).
  static int64_t matrixKey(int64_t matrixId) { return -(matrixId + 1); }
  static int64_t sourceKey(const PortBinding& b) {
    return b.sourceNodeId >= 0 ? b.sourceNodeId : matrixKey(b.sourceMatrixId);
  }

 private:
  // Evaluate one node OUTSIDE the registry lock (max-headroom: a slow formula must never
  // freeze every other request — see docs/decisions/2026-10-15-max-headroom-principle.md).
  // The lock is taken in short bursts: publish `computing`, resolve inputs, eval unlocked,
  // then commit the result. Looking the node up by id in each phase also removes the old
  // dangling-pointer window (the node may be deleted between phases).
  void evaluateNode(int64_t nodeId);
  // The wave's node SET: `nodeId` itself (when includeSelf) plus everything reachable
  // through `dependents_`, in BFS visit order. Visit order is NOT an evaluation order —
  // BFS distance is the SHORTEST path from the change point, and a join fed by paths of
  // different lengths must wait for the LONGEST one. Evaluation order comes from
  // waveOrder(); this function only answers "who is in the wave" (also used to prune the
  // subtree of a lazy node). Takes mu_ itself.
  std::vector<int64_t> collectSubtree(int64_t nodeId, bool includeSelf) const;
  // The wave in evaluation order: a topological sort (Kahn) of the subgraph induced by
  // collectSubtree's set, so every producer INSIDE the wave runs before its consumers
  // whatever the path lengths. Ready nodes are taken in node-id order, which makes one
  // wave's sequence reproducible. Takes mu_ itself.
  std::vector<int64_t> waveOrder(int64_t nodeId, bool includeSelf) const;
  // The wave's first half, single-threaded: walk `order` (dependency-first), mark every
  // `explicitCompute` node stale and prune its subtree (their input is pending, not
  // broken). Returns the dispatchable nodes, still in evaluation order.
  std::vector<int64_t> prepareWave(const std::vector<int64_t>& order);
  // The wave's second half: ready-queue dispatch over the dispatchable set — a node runs
  // as soon as every in-wave producer has completed, never waiting for unrelated nodes.
  // The calling thread is a worker too; spawned helpers are capped (DC_FORMULA_LANE,
  // default 8). Script runs additionally pass the registry-wide process lane below.
  // Blocks until the whole wave is done: the client's synchronous contract is unchanged.
  // docs/decisions/2026-11-22-parallel-wave-scheduler.md.
  void runWaveParallel(const std::vector<int64_t>& order);
  // REQUIRES mu_: mark the node dirty with a reason and drop its previous result, so
  // "dirty" always means "the numbers stored here do not describe the current inputs".
  void markStaleLocked(int64_t nodeId, DirtyReason reason);
  // REQUIRES mu_: fill/reconcile the script card's extra output matrices with one run
  // (builtin:python only — every other signature has no extra outputs to touch).
  void syncExtraOutputsLocked(
      ComputeNode& node,
      const std::vector<std::pair<std::string, std::vector<Column>>>& extras);
  // REQUIRES mu_: blank the numbers behind a script card's extra outputs, so a node that
  // went dirty/error never keeps serving a previous run's tables (same rule as the result
  // matrices).
  void clearExtraOutputsLocked(ComputeNode& node);
  // Transition to Error, clear the stale result, publish the error event.
  // REQUIRES mu_ to be held by the caller.
  void failNodeLocked(int64_t nodeId, const std::string& code, Json params);
  // Where one input port's columns landed in the flattened (names, data) view.
  // Multi-input signatures address their ports through this instead of re-deriving
  // offsets (that duplication is how port order bugs get introduced).
  struct PortSlice {
    size_t firstColumn = 0;
    size_t columnCount = 0;
  };

  // One script-card evaluation (`builtin:python`). Filled OUTSIDE mu_ (the interpreter runs
  // for as long as the card's timeout allows) — see runScriptCard in nodes.cpp.
  struct ScriptCardOutcome {
    std::string errorCode;  // empty ⇒ success; else an Error-state code
    Json errorParams = Json::object();
    std::vector<Column> primary;  // declared output 0 → the node's display matrix
    // Declared outputs 1..K-1 as (name from manifest, columns).
    std::vector<std::pair<std::string, std::vector<Column>>> extras;
  };
  ScriptCardOutcome runScriptCard(int64_t nodeId, const Json& params,
                                  const std::vector<PortBinding>& bindings,
                                  const std::vector<PortSlice>& slices,
                                  const std::vector<std::string>& names,
                                  const std::vector<std::vector<double>>& data);

  // Handle of one script-card run in flight, shared between the evaluation thread and
  // /cancel: the process group to signal, and the flag the waiter polls.
  struct PythonRun {
    std::atomic<bool> cancelRequested{false};
    std::atomic<int64_t> pgid{0};
  };

  // Resolve every binding to its current columns. The registry lock is taken per binding
  // (to check the upstream state) and released before touching the matrix store, so a
  // large table copy never blocks the writer of an unrelated node. `slices` is filled in
  // binding order, one entry per binding, so a signature can say "port x is columns
  // [first, first+count)".
  bool gatherInputs(const std::vector<PortBinding>& inputs, std::vector<std::string>* names,
                    std::vector<std::vector<double>>* data, size_t* length,
                    std::vector<PortSlice>* slices, std::string* errorCode,
                    std::string* errorName);

  mutable std::mutex mu_;
  MatrixStore* store_;
  EventBus* bus_;
  std::map<int64_t, ComputeNode> nodes_;
  int64_t nextNodeId_ = 1;
  // dependsOn -> dependents (both directions available cheaply).
  std::map<int64_t, std::set<int64_t>> dependents_;   // matrixOrNodeId -> nodeIds
  std::map<int64_t, std::set<int64_t>> dependencies_; // nodeId -> matrixOrNodeIds
  // A node's result matrix is NOT an ordinary sink: it sits ON TOP of the node that
  // produced it. Without this map, chains through results (node1 -> res1 -> node2)
  // are invisible to both cascade BFS and cycle detection (found by unit test).
  // v2: K outputs per node, so the owner is (nodeId, outputIndex).
  std::map<int64_t, std::pair<int64_t, int32_t>> resultOwner_;  // matrixKey(result) -> owner
  // Script-card runs in flight, by node id. Guarded by mu_; the pid is published here so
  // /cancel can signal it while the evaluation thread keeps waiting outside the lock.
  std::map<int64_t, std::shared_ptr<PythonRun>> runningPython_;

  // The process lane ("脚本泳道"): a registry-wide cap on concurrent script child
  // processes, shared by every request thread. Heavy runs queue for a slot; the wait is
  // cancel-aware, so /cancel on a queued run ends it without ever spawning. Independent
  // of mu_ — lock order is lane → registry (the queued-cancel path), never the reverse.
  std::mutex scriptLaneMu_;
  std::condition_variable scriptLaneCv_;
  int scriptLaneBusy_ = 0;

  // Cycle check over the *dependency* direction, mirroring findDownstreamPath().
  bool wouldCycle(int64_t dependentId, int64_t dependsOnId, std::vector<int64_t>* pathOut) const;
};

}  // namespace dc
