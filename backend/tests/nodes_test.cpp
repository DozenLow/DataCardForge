// Node registry unit tests: chain recompute, atomic cycle refusal, close protection,
// stale-result clearing and matrix deletion guards.
// Run under ctest alongside the fixture gate.
#include <cmath>
#include <cstdio>
#include <vector>

#include "expression.h"
#include "matrix_store.h"
#include "nodes.h"
#include "signature.h"

using namespace dc;

static int failures = 0;

#define CHECK(cond)                                                         \
  do {                                                                      \
    if (!(cond)) {                                                          \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);            \
      ++failures;                                                           \
    }                                                                       \
  } while (0)

static std::vector<double> columnOf(const MatrixStore& store, int64_t matrixId) {
  Matrix m;
  if (!store.snapshot(matrixId, &m) || m.columnCount() == 0) return {};
  return m.column(0).data;
}

int main() {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);

  // Source matrix [1,2,3,4]
  Column c;
  c.posName = "Pos.1";
  c.data = {1, 2, 3, 4};
  int64_t m1 = store.insert(Matrix({c}));

  PortBinding b1;
  b1.varName = "a";
  b1.mode = "cell";
  b1.sourceMatrixId = m1;
  auto r1 = nodes.create({b1}, "a * 2");
  CHECK(r1.nodeId == 1 && r1.cyclePath.empty());
  nodes.recomputeSubtree(r1.nodeId);
  auto n1 = nodes.get(r1.nodeId);
  CHECK(n1 && n1->state == NodeState::Done);
  CHECK(columnOf(store, n1 ? n1->resultMatrixId() : -1) == std::vector<double>({2, 4, 6, 8}));

  // Chain: node2 = node1.result + 10 → [12,14,16,18]
  PortBinding b2;
  b2.varName = "x";
  b2.mode = "cell";
  b2.sourceMatrixId = n1->resultMatrixId();  // results are matrices too
  auto r2 = nodes.create({b2}, "x + 10");
  CHECK(r2.nodeId == 2 && r2.cyclePath.empty());
  nodes.recomputeSubtree(r2.nodeId);
  auto n2 = nodes.get(r2.nodeId);
  CHECK(n2 && n2->state == NodeState::Done);
  CHECK(columnOf(store, n2 ? n2->resultMatrixId() : -1) == std::vector<double>({12, 14, 16, 18}));

  // Upstream content change must cascade through BOTH dependents in topo order.
  store.replace(m1, [] { Column d; d.posName = "Pos.1"; d.data = {5, 5, 5, 5}; return std::vector<Column>{d}; }());
  nodes.onMatrixChanged(m1);
  CHECK(columnOf(store, n1->resultMatrixId()) == std::vector<double>({10, 10, 10, 10}));
  CHECK(columnOf(store, n2->resultMatrixId()) == std::vector<double>({20, 20, 20, 20}));

  // Cycle refusal is ATOMIC: binding node2 as a source of node1 must register nothing
  // AND must leave node1's previous input binding intact (a rejected PATCH may not
  // break a node that was working).
  PortBinding cycA;
  cycA.varName = "y";
  cycA.sourceNodeId = r2.nodeId;
  PortBinding selfB;
  selfB.varName = "z";
  selfB.sourceMatrixId = m1;
  std::vector<int64_t> path;
  std::vector<PortBinding> newInputs{cycA, selfB};
  bool ok = nodes.update(r1.nodeId, nullptr, &newInputs, &path);
  CHECK(!ok && !path.empty());
  auto kept = nodes.get(r1.nodeId);
  CHECK(kept && kept->inputs.size() == 1);
  CHECK(kept && kept->inputs[0].sourceMatrixId == m1);
  // ...and it still evaluates with the preserved binding.
  nodes.recomputeSubtree(r1.nodeId);
  CHECK(columnOf(store, n1->resultMatrixId()) == std::vector<double>({10, 10, 10, 10}));

  // A node that errors must not keep serving its previous numbers, and its dependents
  // must inherit the error instead of recomputing on stale data.
  const std::string brokenFormula = "NOPE(a)";
  ok = nodes.update(r1.nodeId, &brokenFormula, nullptr, &path);
  CHECK(ok);
  nodes.recomputeSubtree(r1.nodeId);
  auto errored = nodes.get(r1.nodeId);
  CHECK(errored && errored->state == NodeState::Error && errored->errorCode == "unknownFunction");
  CHECK(columnOf(store, n1->resultMatrixId()).empty());
  auto downstream = nodes.get(r2.nodeId);
  CHECK(downstream && downstream->state == NodeState::Error &&
        downstream->errorCode == "upstreamError");
  // Restore a working formula for the remaining checks.
  const std::string goodFormula = "a * 2";
  ok = nodes.update(r1.nodeId, &goodFormula, nullptr, &path);
  CHECK(ok);
  nodes.recomputeSubtree(r1.nodeId);
  CHECK(nodes.get(r2.nodeId) && nodes.get(r2.nodeId)->state == NodeState::Done);

  // Close protection: node2 has no dependents; node1 feeds node2 only through the
  // RESULT MATRIX (m-res1), not a node edge — deleting node2 removes its result matrix.
  bool hadDeps = false;
  CHECK(nodes.remove(r2.nodeId, &hadDeps) && !hadDeps);
  CHECK(nodes.dependentsOf(r1.nodeId).empty());

  // Deleting a stored matrix a node reads must be refused.
  CHECK(!nodes.removeMatrix(m1, &hadDeps) && hadDeps);
  // Deleting a node result matrix directly must be refused too (the node owns it).
  CHECK(!nodes.removeMatrix(n1->resultMatrixId(), &hadDeps) && hadDeps);
  // A matrix nothing reads can be deleted.
  int64_t orphan = store.insert(Matrix({c}));
  CHECK(nodes.removeMatrix(orphan, &hadDeps) && !hadDeps);
  Matrix gone;
  CHECK(!store.snapshot(orphan, &gone));

  // Error state carries the structured code. Both codes match the TS reference:
  // "SQRT(" dies at EOF (unexpectedToken), "(a + 1" at the missing ')'.
  PortBinding bErr;
  bErr.varName = "a";
  bErr.sourceMatrixId = m1;
  auto rErr = nodes.create({bErr}, "SQRT(");
  nodes.recomputeSubtree(rErr.nodeId);
  auto ne = nodes.get(rErr.nodeId);
  CHECK(ne && ne->state == NodeState::Error && ne->errorCode == "unexpectedToken");
  auto rErr2 = nodes.create({bErr}, "(a + 1");
  nodes.recomputeSubtree(rErr2.nodeId);
  auto ne2 = nodes.get(rErr2.nodeId);
  CHECK(ne2 && ne2->state == NodeState::Error && ne2->errorCode == "expectedClose");

  // ── v2 signatures (docs/architecture/port-semantics-v1.md) ──────────────
  // Unknown signature is a structured refusal, never a crash or a silent node.
  auto badSig = nodes.createV2("builtin:nope", {}, Json::object());
  CHECK(badSig.nodeId < 0 && badSig.errorCode == "unknownSignature");

  // builtin:expression-columns: ONE node, ONE wide table, one column per expression.
  // This is what replaces the v1 "one node per formula column" mapping.
  Column two;
  two.posName = "Pos.1";
  two.annotation = "A";
  two.data = {1, 2, 3, 4};
  Column three;
  three.posName = "Pos.2";
  three.annotation = "B";
  three.data = {10, 20, 30, 40};
  int64_t m2 = store.insert(Matrix({two, three}));

  PortBinding src;
  src.portId = "src";
  src.varName = "src";
  src.mode = "matrix";
  src.sourceMatrixId = m2;
  Json params = Json::object();
  Json formulas = Json::array();
  Json f1 = Json::object({{"name", Json("double")}, {"expression", Json("A * 2")}});
  Json f2 = Json::object({{"name", Json("sum")}, {"expression", Json("A + B")}});
  formulas.push(std::move(f1));
  formulas.push(std::move(f2));
  params.set("formulas", std::move(formulas));

  auto sigNode = nodes.createV2("builtin:expression-columns", {src}, params);
  CHECK(sigNode.nodeId > 0 && sigNode.cyclePath.empty() && sigNode.errorCode.empty());
  nodes.recomputeSubtree(sigNode.nodeId);
  auto sn = nodes.get(sigNode.nodeId);
  CHECK(sn && sn->state == NodeState::Done);
  // K is fixed by the signature: one output, however many columns it holds.
  CHECK(sn && sn->resultMatrixIds.size() == 1);
  Matrix sigOut;
  CHECK(store.snapshot(sn ? sn->resultMatrixIds[0] : -1, &sigOut));
  CHECK(sigOut.columnCount() == 2);
  CHECK(sigOut.column(0).data == std::vector<double>({2, 4, 6, 8}));
  CHECK(sigOut.column(1).data == std::vector<double>({11, 22, 33, 44}));
  // Column names ride as annotations so downstream cards see the user's labels.
  CHECK(sigOut.column(0).annotation == "double");
  CHECK(sigOut.column(1).annotation == "sum");

  // Editing one expression re-runs the whole node once (not N times).
  Json formulas2 = Json::array();
  Json g1 = Json::object({{"name", Json("triple")}, {"expression", Json("A * 3")}});
  formulas2.push(std::move(g1));
  Json params2 = Json::object();
  params2.set("formulas", std::move(formulas2));
  CHECK(nodes.updateParams(sigNode.nodeId, params2));
  nodes.recomputeSubtree(sigNode.nodeId);
  Matrix out2;
  CHECK(store.snapshot(sn->resultMatrixIds[0], &out2));
  CHECK(out2.columnCount() == 1);
  CHECK(out2.column(0).data == std::vector<double>({3, 6, 9, 12}));

  // A bad expression inside the signature fails the WHOLE node with the parser's code
  // (the v1 per-column mapping would have failed only that one column's node).
  Json params3 = Json::object();
  Json formulas3 = Json::array();
  Json broken = Json::object({{"name", Json("bad")}, {"expression", Json("NOPE(A)")}});
  formulas3.push(std::move(broken));
  params3.set("formulas", std::move(formulas3));
  CHECK(nodes.updateParams(sigNode.nodeId, params3));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto broken2 = nodes.get(sigNode.nodeId);
  CHECK(broken2 && broken2->state == NodeState::Error &&
        broken2->errorCode == "unknownFunction");
  // …and it must not keep serving the previous numbers.
  Matrix cleared;
  CHECK(store.snapshot(sigNode.nodeId > 0 ? sn->resultMatrixIds[0] : -1, &cleared));
  CHECK(cleared.columnCount() == 0);

  // Missing params is a structured error, not UB.
  CHECK(nodes.updateParams(sigNode.nodeId, Json::object()));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto noParams = nodes.get(sigNode.nodeId);
  CHECK(noParams && noParams->state == NodeState::Error &&
        noParams->errorCode == "badSignatureParams");

  // Result matrices of a signature node are mid-edges: a downstream node can read one.
  Json params4 = Json::object();
  Json formulas4 = Json::array();
  Json ok1 = Json::object({{"name", Json("double")}, {"expression", Json("A * 2")}});
  formulas4.push(std::move(ok1));
  params4.set("formulas", std::move(formulas4));
  CHECK(nodes.updateParams(sigNode.nodeId, params4));
  nodes.recomputeSubtree(sigNode.nodeId);
  PortBinding downstream2;
  downstream2.portId = "up";
  downstream2.varName = "up";
  downstream2.sourceNodeId = sigNode.nodeId;
  downstream2.sourceOutputIndex = 0;
  auto d2 = nodes.create({downstream2}, "up + 1");
  CHECK(d2.nodeId > 0);
  nodes.recomputeSubtree(d2.nodeId);
  auto d2n = nodes.get(d2.nodeId);
  CHECK(d2n && d2n->state == NodeState::Done);
  CHECK(columnOf(store, d2n ? d2n->resultMatrixId() : -1) == std::vector<double>({3, 5, 7, 9}));

  // Column contract: naming the output's columns promises their count. A drift is a
  // structured stop (the data flow ends here), not a silent re-labelling.
  Json params5 = Json::object();
  Json formulas5 = Json::array();
  Json f5a = Json::object({{"name", Json("a")}, {"expression", Json("A * 2")}});
  Json f5b = Json::object({{"name", Json("b")}, {"expression", Json("A + 1")}});
  formulas5.push(std::move(f5a));
  formulas5.push(std::move(f5b));
  params5.set("formulas", std::move(formulas5));
  params5.set("columnContract", Json::object({{"outputId", Json("result")}, {"columns", Json(2)}}));
  CHECK(nodes.updateParams(sigNode.nodeId, params5));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto contracted = nodes.get(sigNode.nodeId);
  CHECK(contracted && contracted->state == NodeState::Done &&
        contracted->resultMatrixIds.size() == 1);

  // …adding a third expression without extending the contract must fail the node.
  Json formulas6 = Json::array();
  Json g6a = Json::object({{"name", Json("a")}, {"expression", Json("A * 2")}});
  Json g6b = Json::object({{"name", Json("b")}, {"expression", Json("A + 1")}});
  Json g6c = Json::object({{"name", Json("c")}, {"expression", Json("A")}});
  formulas6.push(std::move(g6a));
  formulas6.push(std::move(g6b));
  formulas6.push(std::move(g6c));
  Json params6 = Json::object();
  params6.set("formulas", std::move(formulas6));
  params6.set("columnContract", Json::object({{"outputId", Json("result")}, {"columns", Json(2)}}));
  CHECK(nodes.updateParams(sigNode.nodeId, params6));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto violated = nodes.get(sigNode.nodeId);
  CHECK(violated && violated->state == NodeState::Error &&
        violated->errorCode == "columnContractViolation");
  CHECK(violated && violated->errorParams["expected"].asNumber() == 2);
  CHECK(violated && violated->errorParams["actual"].asNumber() == 3);
  // The data flow really stops: the previous result is cleared.
  Matrix stopped;
  CHECK(store.snapshot(violated->resultMatrixId(), &stopped));
  CHECK(stopped.columnCount() == 0);

  // Extending the contract is the explicit way out.
  Json params7 = Json::object();
  Json formulas7 = Json::array();
  Json h1 = Json::object({{"name", Json("a")}, {"expression", Json("A * 2")}});
  Json h2 = Json::object({{"name", Json("b")}, {"expression", Json("A + 1")}});
  Json h3 = Json::object({{"name", Json("c")}, {"expression", Json("A")}});
  formulas7.push(std::move(h1));
  formulas7.push(std::move(h2));
  formulas7.push(std::move(h3));
  params7.set("formulas", std::move(formulas7));
  params7.set("columnContract", Json::object({{"outputId", Json("result")}, {"columns", Json(3)}}));
  CHECK(nodes.updateParams(sigNode.nodeId, params7));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto extended = nodes.get(sigNode.nodeId);
  CHECK(extended && extended->state == NodeState::Done);

  // The signature declares the ports; a card may not invent its own. Refused at creation
  // (not later inside evaluation), so a bad binding never produces a half-alive node.
  PortBinding wrongPort;
  wrongPort.portId = "nope";
  wrongPort.varName = "nope";
  wrongPort.sourceMatrixId = m2;
  auto unknownPort = nodes.createV2("builtin:expression-columns", {wrongPort}, params);
  CHECK(unknownPort.nodeId < 0 && unknownPort.errorCode == "unknownPort");
  auto noBinding = nodes.createV2("builtin:expression-columns", {}, params);
  CHECK(noBinding.nodeId < 0 && noBinding.errorCode == "unboundPort");

  // Definition version: an edit invalidates an in-flight evaluation. The registry cannot
  // be paused mid-run from a test, so this pins the mechanism (the version moves on every
  // definition change) plus the observable contract: after an edit + recompute, the node
  // reflects the NEW definition, never a stale Done from the old one.
  Json v1Params = Json::object();
  Json v1Formulas = Json::array();
  Json v1f = Json::object({{"name", Json("first")}, {"expression", Json("A * 2")}});
  v1Formulas.push(std::move(v1f));
  v1Params.set("formulas", std::move(v1Formulas));
  CHECK(nodes.updateParams(sigNode.nodeId, v1Params));
  auto v1Node = nodes.get(sigNode.nodeId);
  const uint64_t versionAfterFirst = v1Node ? v1Node->definitionVersion : 0;
  CHECK(versionAfterFirst > 0);
  Json v2Params = Json::object();
  Json v2Formulas = Json::array();
  Json v2f = Json::object({{"name", Json("second")}, {"expression", Json("A * 3")}});
  v2Formulas.push(std::move(v2f));
  v2Params.set("formulas", std::move(v2Formulas));
  CHECK(nodes.updateParams(sigNode.nodeId, v2Params));
  auto v2Node = nodes.get(sigNode.nodeId);
  CHECK(v2Node && v2Node->definitionVersion > versionAfterFirst);
  nodes.recomputeSubtree(sigNode.nodeId);
  auto afterEdit = nodes.get(sigNode.nodeId);
  CHECK(afterEdit && afterEdit->state == NodeState::Done);
  Matrix edited;
  CHECK(store.snapshot(afterEdit->resultMatrixIds[0], &edited));
  CHECK(edited.columnCount() == 1);
  CHECK(edited.column(0).data == std::vector<double>({3, 6, 9, 12}));

  // ── builtin:summary — lazy evaluation, and a dirty state that cannot be mistaken for
  // "up to date". Three things are asserted here and nowhere else cheaply: creation does
  // NOT compute, an upstream change drops the numbers instead of serving them, and the
  // two dirty causes are distinguishable.
  Column sa;
  sa.posName = "Pos.1";
  sa.annotation = "A";
  sa.data = {1, 2, 3, 4};
  Column sb;  // un-annotated on purpose: its display label must stay "Pos.2"
  sb.posName = "Pos.2";
  sb.annotation = "";
  sb.data = {10, 20, 30, 40};
  int64_t summarySource = store.insert(Matrix({sa, sb}));

  PortBinding summarySrc;
  summarySrc.portId = "src";
  summarySrc.varName = "src";
  summarySrc.mode = "matrix";
  summarySrc.sourceMatrixId = summarySource;
  auto summaryNode = nodes.createV2("builtin:summary", {summarySrc}, Json::object());
  CHECK(summaryNode.nodeId > 0);

  // Creation registers the edges but spends no compute: the signature says explicit.
  nodes.recomputeSubtree(summaryNode.nodeId);
  auto lazy = nodes.get(summaryNode.nodeId);
  CHECK(lazy && lazy->state == NodeState::Dirty);
  CHECK(lazy && lazy->dirtyReason == DirtyReason::NotRequested);
  Matrix emptyResult;
  CHECK(lazy && store.snapshot(lazy->resultMatrixIds[0], &emptyResult));
  CHECK(emptyResult.columnCount() == 0);  // no numbers, not even zeros

  // Explicit request: now it computes, and the shape is fixed by the signature + catalog.
  nodes.computeNow(summaryNode.nodeId);
  auto computed = nodes.get(summaryNode.nodeId);
  CHECK(computed && computed->state == NodeState::Done);
  CHECK(computed && computed->dirtyReason == DirtyReason::None);
  Matrix table;
  CHECK(computed && store.snapshot(computed->resultMatrixIds[0], &table));
  CHECK(table.columnCount() == 2);
  CHECK(table.column(0).annotation == "A");
  // The output column's posName is the SOURCE column's posName: that is what keeps an
  // un-annotated variable displayable as "Pos.2" instead of an invented letter.
  CHECK(table.column(0).posName == "Pos.1");
  CHECK(table.column(1).posName == "Pos.2");
  CHECK(table.column(1).annotation.empty());
  CHECK(table.column(0).data.size() == summaryStatCatalog().size());
  CHECK(table.column(1).data.size() == summaryStatCatalog().size());
  CHECK(table.column(0).data[0] == 4);      // n
  CHECK(table.column(0).data[1] == 0);      // nan
  CHECK(table.column(0).data[2] == 2.5);    // mean
  CHECK(std::fabs(table.column(0).data[9] - 4.0) < 1e-12);   // max
  CHECK(std::fabs(table.column(1).data[2] - 25.0) < 1e-12);  // mean of Pos.2

  // Upstream change: back to dirty/upstreamChanged, and the old numbers are gone.
  std::vector<CellPatch> patches = {{0, 0, 100.0}};
  int64_t revision = 0;
  CHECK(store.patchCells(summarySource, patches, &revision));
  nodes.onMatrixChanged(summarySource);
  auto stale = nodes.get(summaryNode.nodeId);
  CHECK(stale && stale->state == NodeState::Dirty);
  CHECK(stale && stale->dirtyReason == DirtyReason::UpstreamChanged);
  Matrix clearedByUpstream;
  CHECK(stale && store.snapshot(stale->resultMatrixIds[0], &clearedByUpstream));
  CHECK(clearedByUpstream.columnCount() == 0);

  // A second explicit request recovers with the new data.
  nodes.computeNow(summaryNode.nodeId);
  auto recovered = nodes.get(summaryNode.nodeId);
  CHECK(recovered && recovered->state == NodeState::Done);
  Matrix refreshed;
  CHECK(recovered && store.snapshot(recovered->resultMatrixIds[0], &refreshed));
  CHECK(refreshed.columnCount() == 2);
  CHECK(refreshed.column(0).data[1] == 0);                  // nan unchanged
  CHECK(std::fabs(refreshed.column(0).data[2] - 27.25) < 1e-12);  // (100+2+3+4)/4

  // An EMPTY column (0 rows, a shape the HTTP layer really can register) still yields the
  // whole catalog: n=0, nan=0, sem=0, everything else NaN. "Return 0 and move on" is the
  // failure this block exists to catch.
  Column emptyCol;
  emptyCol.posName = "Pos.7";
  emptyCol.annotation = "";
  int64_t emptySource = store.insert(Matrix({emptyCol}));
  PortBinding emptySrc;
  emptySrc.portId = "src";
  emptySrc.varName = "src";
  emptySrc.mode = "matrix";
  emptySrc.sourceMatrixId = emptySource;
  auto emptyNode = nodes.createV2("builtin:summary", {emptySrc}, Json::object());
  CHECK(emptyNode.nodeId > 0);
  nodes.computeNow(emptyNode.nodeId);
  auto emptyDone = nodes.get(emptyNode.nodeId);
  CHECK(emptyDone && emptyDone->state == NodeState::Done);
  Matrix emptyTable;
  CHECK(emptyDone && store.snapshot(emptyDone->resultMatrixIds[0], &emptyTable));
  CHECK(emptyTable.columnCount() == 1);
  CHECK(emptyTable.column(0).posName == "Pos.7");
  CHECK(emptyTable.column(0).data.size() == summaryStatCatalog().size());
  CHECK(emptyTable.column(0).data[0] == 0);     // n
  CHECK(emptyTable.column(0).data[1] == 0);     // nan
  CHECK(std::isnan(emptyTable.column(0).data[3]));   // sd: n = 0 ⇒ NaN, not 0
  CHECK(emptyTable.column(0).data[11] == 0);    // sem: n < 2 ⇒ 0

  // ── a table whose columns have Chinese headers must be usable by its own labels ──
  // Regression for the card that could not compute ANYTHING on an annotated file: the
  // annotation did not tokenise and `Pos.1` missed because the position name had been
  // glued to the annotation. Both spellings, the bracketed form and the port-qualified
  // form are exercised through the real node path (gatherInputs → engine → params).
  Column t0;
  t0.posName = "Pos.1";
  t0.annotation = "时间_秒";
  t0.data = {0, 1};
  Column t1;
  t1.posName = "Pos.2";
  t1.annotation = "地面速度_μm/s";
  t1.data = {10, 20};
  int64_t annotated = store.insert(Matrix({t0, t1}));

  PortBinding annotatedSrc;
  annotatedSrc.portId = "src";
  annotatedSrc.varName = "src";
  annotatedSrc.mode = "matrix";
  annotatedSrc.sourceMatrixId = annotated;

  auto runFormula = [&](const std::string& formula) {
    auto created = nodes.create({annotatedSrc}, formula);
    if (created.nodeId <= 0) return std::vector<double>{};
    nodes.computeNow(created.nodeId);
    return columnOf(store, nodes.get(created.nodeId) ? nodes.get(created.nodeId)->resultMatrixId() : -1);
  };

  CHECK(runFormula("时间_秒 * 2") == std::vector<double>({0, 2}));
  CHECK(runFormula("Pos.1 * 2") == std::vector<double>({0, 2}));
  CHECK(runFormula("pos.1 + 1") == std::vector<double>({1, 2}));
  CHECK(runFormula("[地面速度_μm/s] / 2") == std::vector<double>({5, 10}));
  CHECK(runFormula("【地面速度_μm/s】／2") == std::vector<double>({5, 10}));
  CHECK(runFormula("（时间_秒 ＋ 1）× 2") == std::vector<double>({2, 4}));
  // Qualified by the declaration letter and by the port id.
  CHECK(runFormula("A.pos.2 / 2") == std::vector<double>({5, 10}));
  CHECK(runFormula("src.[地面速度_μm/s] / 2") == std::vector<double>({5, 10}));

  // The error the user actually saw: a name that cannot be spelled bare must come back as
  // a structured, actionable error — the offending column/char travels in `params`, so the
  // localised message can name it instead of printing a literal "{name}".
  // The formula card itself goes through `builtin:expression-columns`, not the v1 path —
  // the two evaluation sites must both see the alias ranges, or `A.pos.1` works in a unit
  // test but fails in the card the user is looking at (that is exactly how this slipped).
  {
    Json params = Json::object();
    Json formulas = Json::array();
    Json row = Json::object();
    row.set("name", Json(std::string("qualified")));
    row.set("expression", Json(std::string("A.pos.1 * 2 + src.pos.2")));
    formulas.push(row);
    params.set("formulas", std::move(formulas));
    auto qualified = nodes.createV2(kSigExpressionColumns, {annotatedSrc}, params);
    CHECK(qualified.nodeId > 0);
    nodes.computeNow(qualified.nodeId);
    auto qualifiedNode = nodes.get(qualified.nodeId);
    CHECK(qualifiedNode && qualifiedNode->state == NodeState::Done);
    // A.pos.1 * 2 + src.pos.2 → [0*2+10, 1*2+20]
    CHECK(columnOf(store, qualifiedNode ? qualifiedNode->resultMatrixId() : -1) ==
          std::vector<double>({10, 22}));
  }

  auto bad = nodes.create({annotatedSrc}, "地面速度_μm/s * 2");
  CHECK(bad.nodeId > 0);
  nodes.computeNow(bad.nodeId);
  auto badNode = nodes.get(bad.nodeId);
  CHECK(badNode && badNode->state == NodeState::Error);
  CHECK(badNode && badNode->errorCode == "unknownColumn");
  CHECK(badNode && badNode->errorParams["name"].isString());
  CHECK(badNode && badNode->errorParams["name"].asString() == "地面速度_μm");
  CHECK(badNode && badNode->errorParams["position"].asNumber() == 0);

  auto badChar = nodes.create({annotatedSrc}, "时间_秒 @ 2");
  CHECK(badChar.nodeId > 0);
  nodes.computeNow(badChar.nodeId);
  auto badCharNode = nodes.get(badChar.nodeId);
  CHECK(badCharNode && badCharNode->state == NodeState::Error);
  CHECK(badCharNode && badCharNode->errorCode == "unexpectedChar");
  CHECK(badCharNode && badCharNode->errorParams["char"].asString() == "@");
  CHECK(badCharNode && badCharNode->errorParams["position"].asNumber() == 5);

  auto badArity = nodes.create({annotatedSrc}, "IF(时间_秒, 1)");
  CHECK(badArity.nodeId > 0);
  nodes.computeNow(badArity.nodeId);
  auto badArityNode = nodes.get(badArity.nodeId);
  CHECK(badArityNode && badArityNode->errorCode == "badArgCount");
  CHECK(badArityNode && badArityNode->errorParams["name"].asString() == "IF");
  CHECK(badArityNode && badArityNode->errorParams["expected"].asNumber() == 3);
  CHECK(badArityNode && badArityNode->errorParams["got"].asNumber() == 2);

  // ── Uneven diamond: one wave must never compute a join from a stale upstream ────────
  // BFS distance from the change point is the SHORTEST path, so a join fed by a short and
  // a long path used to run before the long path's tail finished — publishing numbers that
  // mixed fresh and stale inputs under a green `done` light. Found live (2026-11-22) with
  // a fit card: the wave printed fit(x_new, z_old) = slope 24.236453 while a fresh compute
  // gives fit(x_new, z_new) = 25.832512. The wave order is now a topological sort of the
  // induced subgraph (waveOrder), so every in-wave producer runs before its consumers.
  //
  //   source ─► A ─► B ─► C ─► Z        (long path, depth 4)
  //             └────────────┐
  //                          D = fit(x=A, y=Z)   (join of depths 1 and 4)
  {
    Column diamondCol;
    diamondCol.posName = "Pos.1";
    diamondCol.data = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    const int64_t diamondSource = store.insert(Matrix({diamondCol}));

    auto formulaParams = [](const char* expr) {
      Json params = Json::object();
      Json formulas = Json::array();
      Json entry = Json::object();
      entry.set("name", Json(std::string("f")));
      entry.set("expression", Json(std::string(expr)));
      formulas.push(entry);
      params.set("formulas", std::move(formulas));
      return params;
    };
    PortBinding wholeTable;
    wholeTable.portId = "src";
    wholeTable.mode = "matrix";
    wholeTable.sourceMatrixId = diamondSource;
    const auto diaA = nodes.createV2(kSigExpressionColumns, {wholeTable},
                                     formulaParams("pos.1 * 2"));
    CHECK(diaA.nodeId > 0);
    nodes.computeNow(diaA.nodeId);

    auto chainFrom = [&](int64_t producer, const char* expr) {
      PortBinding b;
      b.portId = "src";
      b.mode = "matrix";
      b.sourceNodeId = producer;
      const auto r = nodes.createV2(kSigExpressionColumns, {b}, formulaParams(expr));
      CHECK(r.nodeId > 0);
      nodes.computeNow(r.nodeId);
      return r;
    };
    const auto diaB = chainFrom(diaA.nodeId, "pos.1 + 1");
    const auto diaC = chainFrom(diaB.nodeId, "pos.1 * pos.1");
    const auto diaZ = chainFrom(diaC.nodeId, "pos.1 + 1");

    PortBinding fitX;
    fitX.portId = "x";
    fitX.varName = "x";
    fitX.mode = "cell";
    fitX.columnIndex = 0;
    fitX.sourceNodeId = diaA.nodeId;
    PortBinding fitY;
    fitY.portId = "y";
    fitY.varName = "y";
    fitY.mode = "cell";
    fitY.columnIndex = 0;
    fitY.sourceNodeId = diaZ.nodeId;
    const auto diaD = nodes.createV2(kSigLinearRegression, {fitX, fitY}, Json::object());
    CHECK(diaD.nodeId > 0);
    nodes.computeNow(diaD.nodeId);

    auto fitCell = [&](int64_t nodeId, size_t column) -> double {
      const auto n = nodes.get(nodeId);
      Matrix m;
      if (!n || !store.snapshot(n->resultMatrixId(), &m) || m.columnCount() <= column ||
          m.column(column).data.empty())
        return NAN;
      return m.column(column).data[0];
    };

    // One wave from the source, exactly like PATCH /api/matrices/{id} does it.
    int64_t revision = 0;
    CHECK(store.patchCells(diamondSource, {CellPatch{0, 0, 7.0}}, &revision));
    nodes.onMatrixChanged(diamondSource);

    // The long path really ran: Z's first cell is ((7*2)+1)^2+1 = 226, not the old 10.
    CHECK(columnOf(store, nodes.get(diaZ.nodeId)->resultMatrixId())[0] == 226.0);

    // Independent oracle: least squares over the FRESH x and z, computed here from the
    // stored columns — not from anything the fit node published.
    const auto xNew = columnOf(store, nodes.get(diaA.nodeId)->resultMatrixId());
    const auto zNew = columnOf(store, nodes.get(diaZ.nodeId)->resultMatrixId());
    double sx = 0, sy = 0;
    for (size_t i = 0; i < xNew.size(); ++i) {
      sx += xNew[i];
      sy += zNew[i];
    }
    const double mx = sx / static_cast<double>(xNew.size());
    const double my = sy / static_cast<double>(zNew.size());
    double sxx = 0, sxy = 0;
    for (size_t i = 0; i < xNew.size(); ++i) {
      sxx += (xNew[i] - mx) * (xNew[i] - mx);
      sxy += (xNew[i] - mx) * (zNew[i] - my);
    }
    const double expectedSlope = sxy / sxx;
    const double expectedIntercept = my - expectedSlope * mx;

    const auto diaDNode = nodes.get(diaD.nodeId);
    CHECK(diaDNode && diaDNode->state == NodeState::Done);
    const double waveSlope = fitCell(diaD.nodeId, 0);
    const double waveIntercept = fitCell(diaD.nodeId, 1);
    CHECK(std::abs(waveSlope - expectedSlope) < 1e-9);
    CHECK(std::abs(waveIntercept - expectedIntercept) < 1e-9);
    // Golden values from the live reproduction (independent Python fit of the same inputs):
    // pins the oracle itself, so a future change to both cannot quietly agree on garbage.
    CHECK(std::abs(waveSlope - 25.832512315270936) < 1e-6);
    CHECK(std::abs(waveIntercept - (-115.5566502463054)) < 1e-6);

    // Idempotence: recomputing the join alone afterwards must change nothing — the wave
    // already fed it fresh inputs. Under the old BFS order this recomputation moved the
    // numbers, which is how the stale read was first noticed.
    nodes.computeNow(diaD.nodeId);
    CHECK(fitCell(diaD.nodeId, 0) == waveSlope);
    CHECK(fitCell(diaD.nodeId, 1) == waveIntercept);
  }

  // ── Parallel fan-out: ready-queue dispatch must keep every number exact ─────────────
  // Ten independent branches under one source, each with its own tail, plus an uneven
  // join (x from a depth-2 node, y from a depth-3 node). The wave has >1 dispatchable
  // node, so it goes through runWaveParallel's worker pool — completion order is not
  // deterministic, the numbers must be. Same oracle rule as the serial diamond: the wave
  // result must equal a fresh least-squares fit of the stored inputs.
  {
    Column fanCol;
    fanCol.posName = "Pos.1";
    fanCol.data = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    const int64_t fanSource = store.insert(Matrix({fanCol}));

    auto fanParams = [](const std::string& expr) {
      Json params = Json::object();
      Json formulas = Json::array();
      Json entry = Json::object();
      entry.set("name", Json(std::string("f")));
      entry.set("expression", Json(expr));
      formulas.push(entry);
      params.set("formulas", std::move(formulas));
      return params;
    };
    PortBinding fanRoot;
    fanRoot.portId = "src";
    fanRoot.mode = "matrix";
    fanRoot.sourceMatrixId = fanSource;
    const auto root = nodes.createV2(kSigExpressionColumns, {fanRoot}, fanParams("pos.1 * 2"));
    CHECK(root.nodeId > 0);
    nodes.computeNow(root.nodeId);

    std::vector<int64_t> branchIds, tailIds;
    for (int i = 0; i < 10; ++i) {
      PortBinding b;
      b.portId = "src";
      b.mode = "matrix";
      b.sourceNodeId = root.nodeId;
      const auto branch = nodes.createV2(
          kSigExpressionColumns, {b}, fanParams("pos.1 + " + std::to_string(i)));
      CHECK(branch.nodeId > 0);
      nodes.computeNow(branch.nodeId);
      PortBinding t;
      t.portId = "src";
      t.mode = "matrix";
      t.sourceNodeId = branch.nodeId;
      const auto tail = nodes.createV2(kSigExpressionColumns, {t}, fanParams("pos.1 * 3"));
      CHECK(tail.nodeId > 0);
      nodes.computeNow(tail.nodeId);
      branchIds.push_back(branch.nodeId);
      tailIds.push_back(tail.nodeId);
    }

    PortBinding fanX;
    fanX.portId = "x";
    fanX.varName = "x";
    fanX.mode = "cell";
    fanX.columnIndex = 0;
    fanX.sourceNodeId = branchIds[0];  // depth 2
    PortBinding fanY;
    fanY.portId = "y";
    fanY.varName = "y";
    fanY.mode = "cell";
    fanY.columnIndex = 0;
    fanY.sourceNodeId = tailIds[6];  // depth 3
    const auto fanJoin = nodes.createV2(kSigLinearRegression, {fanX, fanY}, Json::object());
    CHECK(fanJoin.nodeId > 0);
    nodes.computeNow(fanJoin.nodeId);

    int64_t revision = 0;
    CHECK(store.patchCells(fanSource, {CellPatch{0, 0, 7.0}}, &revision));
    nodes.onMatrixChanged(fanSource);

    // Every node in the fan must be done — a lost wakeup or a stuck remaining count
    // would leave a yellow card behind.
    const auto rootNode = nodes.get(root.nodeId);
    CHECK(rootNode && rootNode->state == NodeState::Done);
    for (int64_t id : branchIds) {
      const auto n = nodes.get(id);
      CHECK(n && n->state == NodeState::Done);
    }
    for (int64_t id : tailIds) {
      const auto n = nodes.get(id);
      CHECK(n && n->state == NodeState::Done);
    }
    const auto joinNode = nodes.get(fanJoin.nodeId);
    CHECK(joinNode && joinNode->state == NodeState::Done);

    // Independent oracle over the FRESH stored columns (x = 2*a, y = 3*(2*a+6)).
    const auto xFresh = columnOf(store, rootNode->resultMatrixId());
    Matrix yMatrix;
    CHECK(store.snapshot(nodes.get(tailIds[6])->resultMatrixId(), &yMatrix));
    const auto yFresh = yMatrix.column(0).data;
    double sx = 0, sy = 0;
    for (size_t i = 0; i < xFresh.size(); ++i) {
      sx += xFresh[i];
      sy += yFresh[i];
    }
    const double mx = sx / static_cast<double>(xFresh.size());
    const double my = sy / static_cast<double>(yFresh.size());
    double sxx = 0, sxy = 0;
    for (size_t i = 0; i < xFresh.size(); ++i) {
      sxx += (xFresh[i] - mx) * (xFresh[i] - mx);
      sxy += (xFresh[i] - mx) * (yFresh[i] - my);
    }
    const double wantSlope = sxy / sxx;
    const double wantIntercept = my - wantSlope * mx;
    Matrix joinMatrix;
    CHECK(store.snapshot(joinNode->resultMatrixId(), &joinMatrix));
    CHECK(std::abs(joinMatrix.column(0).data[0] - wantSlope) < 1e-9);
    CHECK(std::abs(joinMatrix.column(1).data[0] - wantIntercept) < 1e-9);
    // x = 2*a is linear in a and y = 6*a+18, so the fit is exact: slope 3, intercept 18.
    CHECK(std::abs(joinMatrix.column(0).data[0] - 3.0) < 1e-9);
    CHECK(std::abs(joinMatrix.column(1).data[0] - 18.0) < 1e-9);

    // Idempotence: a fresh recompute of the join must not move the numbers.
    nodes.computeNow(fanJoin.nodeId);
    Matrix again;
    CHECK(store.snapshot(joinNode->resultMatrixId(), &again));
    CHECK(again.column(0).data[0] == joinMatrix.column(0).data[0]);
    CHECK(again.column(1).data[0] == joinMatrix.column(1).data[0]);
  }

  // ── Regression (#3): a {params, inputs} update that forms a cycle is refused ATOMICALLY.
  // The PATCH route now commits params inside update() AFTER the cycle gate, so a 409 must
  // leave the parameter bag AND definitionVersion exactly as they were (the old route called
  // updateParams first, half-applying the edit even when update() then refused the cycle).
  {
    Column rc;
    rc.posName = "Pos.1";
    rc.data = {1, 2, 3};
    const int64_t rm = store.insert(Matrix({rc}));

    PortBinding ra;
    ra.varName = "a";
    ra.mode = "cell";
    ra.sourceMatrixId = rm;
    const auto nodeA = nodes.create({ra}, "a * 2");
    CHECK(nodeA.nodeId > 0);

    PortBinding rb;
    rb.varName = "x";
    rb.mode = "cell";
    rb.sourceNodeId = nodeA.nodeId;  // B depends on A
    const auto nodeB = nodes.create({rb}, "x + 1");
    CHECK(nodeB.nodeId > 0);
    nodes.recomputeSubtree(nodeA.nodeId);

    // A known params bag + a recorded version to compare against after the refused update.
    Json aParams = Json::object();
    aParams.set("marker", Json(std::string("original")));
    CHECK(nodes.updateParams(nodeA.nodeId, aParams));
    const auto before = nodes.get(nodeA.nodeId);
    CHECK(before.has_value());
    const uint64_t versionBefore = before ? before->definitionVersion : 0;

    // Make A depend on B (A -> B -> A closes a loop) while ALSO sending a new params bag.
    PortBinding cyc;
    cyc.varName = "y";
    cyc.mode = "cell";
    cyc.sourceNodeId = nodeB.nodeId;
    std::vector<PortBinding> cycInputs{cyc};
    Json newParams = Json::object();
    newParams.set("marker", Json(std::string("mutated")));
    std::vector<int64_t> cycPath;
    const bool refused = nodes.update(nodeA.nodeId, nullptr, &cycInputs, &cycPath, &newParams);
    CHECK(!refused && !cycPath.empty());
    const auto after = nodes.get(nodeA.nodeId);
    CHECK(after.has_value());
    CHECK(after && after->params["marker"].asString() == "original");  // params untouched
    CHECK(after && after->definitionVersion == versionBefore);         // version untouched
    // …and the previous binding is intact (still reads the matrix, not B).
    CHECK(after && after->inputs.size() == 1 && after->inputs[0].sourceMatrixId == rm);

    // The accepted path still commits params + inputs together with a SINGLE version bump.
    PortBinding okBind;
    okBind.varName = "a";
    okBind.mode = "cell";
    okBind.sourceMatrixId = rm;
    std::vector<PortBinding> okInputs{okBind};
    Json okParams = Json::object();
    okParams.set("marker", Json(std::string("accepted")));
    std::vector<int64_t> okPath;
    CHECK(nodes.update(nodeA.nodeId, nullptr, &okInputs, &okPath, &okParams));
    const auto committed = nodes.get(nodeA.nodeId);
    CHECK(committed && committed->params["marker"].asString() == "accepted");
    CHECK(committed && committed->definitionVersion == versionBefore + 1);
  }

  std::printf("%s: node_registry (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
