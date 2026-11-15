// Script card (builtin:python) end-to-end gate: signature, params validation, process
// dispatch and the DCM2 data channel through the vendored interpreter.
//
// This is the only test that puts a real child process between the registry and a result, so
// it judges exactly the half a mock cannot: that the frames we write are the frames the
// runner reads, that a kill reaches the whole process group, and that every runner exit code
// lands on the node error code the client renders.
//
// It needs third_party/pyruntime (bash scripts/fetch-python-runtime.sh). Without it the test
// prints SKIP and exits 0: "not applicable" and "verified" must not look the same, and a
// machine that never provisioned the runtime must not fail the suite. Where the runtime IS
// present, nothing is skipped.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "matrix_store.h"
#include "nodes.h"
#include "signature.h"

using namespace dc;

namespace {

int failures = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);             \
      ++failures;                                                            \
    }                                                                        \
  } while (0)

#define CHECK_MSG(cond, ...)                                                 \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::printf("FAIL %s:%d %s | ", __FILE__, __LINE__, #cond);            \
      std::printf(__VA_ARGS__);                                              \
      std::printf("\n");                                                     \
      ++failures;                                                            \
    }                                                                        \
  } while (0)

std::string describeColumn(const std::vector<double>& values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i != 0) out += ", ";
    char buf[48];
    std::snprintf(buf, sizeof buf, "%.17g", values[i]);
    out += buf;
  }
  out += "]";
  return out;
}

// Bit for bit, because the claim is "the frame round-trips unchanged": a NaN that comes back
// with a different payload, or one changed least-significant bit, is exactly the class of bug
// a tolerance comparison would hide.
bool bitsEqual(const std::vector<double>& a, const std::vector<double>& b) {
  if (a.size() != b.size()) return false;
  return a.empty() || std::memcmp(a.data(), b.data(), a.size() * sizeof(double)) == 0;
}

void checkColumn(const char* what, const std::vector<double>& got,
                 const std::vector<double>& want) {
  if (bitsEqual(got, want)) return;
  std::printf("FAIL %s: got %s, want %s\n", what, describeColumn(got).c_str(),
              describeColumn(want).c_str());
  ++failures;
}

std::vector<std::vector<double>> snapshotColumns(const MatrixStore& store, int64_t matrixId) {
  Matrix matrix;
  if (!store.snapshot(matrixId, &matrix)) return {};
  std::vector<std::vector<double>> columns;
  for (const Column& column : matrix.columns()) columns.push_back(column.data);
  return columns;
}

int64_t insertMatrix(MatrixStore* store, const std::vector<std::vector<double>>& columns) {
  std::vector<Column> out;
  for (size_t i = 0; i < columns.size(); ++i) {
    Column column;
    column.posName = "Pos." + std::to_string(i + 1);
    column.data = columns[i];
    out.push_back(std::move(column));
  }
  return store->insert(Matrix(std::move(out)));
}

Json pythonParams(const std::string& script, const std::vector<std::string>& portNames,
                  const std::vector<std::string>& outputs, int64_t timeoutMs = -1) {
  Json ports = Json::array();
  for (const auto& name : portNames) ports.push(Json(name));
  Json outNames = Json::array();
  for (const auto& name : outputs) outNames.push(Json(name));
  Json params = Json::object({{"script", Json(script)},
                              {"portNames", std::move(ports)},
                              {"outputs", std::move(outNames)}});
  if (timeoutMs > 0) params.set("timeout_ms", Json(timeoutMs));
  return params;
}

struct Fixture {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes;
  Fixture() : nodes(&store, &bus) {}
};

// Creates one script node bound to `sources` (one port each, named by portNames). Fills
// *errorCode with the refusal code when the declaration was rejected (the HTTP layer turns
// that into 400 invalidParams).
int64_t createPythonNode(Fixture* fixture, const std::vector<int64_t>& sources,
                         const std::vector<std::string>& portNames, const std::string& script,
                         const std::vector<std::string>& outputs, int64_t timeoutMs = -1,
                         std::string* errorCode = nullptr) {
  std::vector<PortBinding> inputs;
  for (size_t i = 0; i < sources.size(); ++i) {
    PortBinding binding;
    binding.portId = "port" + std::to_string(i);
    binding.varName = i < portNames.size() ? portNames[i] : "P" + std::to_string(i);
    binding.mode = "matrix";
    binding.sourceMatrixId = sources[i];
    inputs.push_back(std::move(binding));
  }
  const NodeRegistry::CreateResult created = fixture->nodes.createV2(
      kSigPython, inputs, pythonParams(script, portNames, outputs, timeoutMs));
  if (errorCode != nullptr) *errorCode = created.errorCode;
  return created.nodeId;
}

std::string paramString(const Json& params, const char* key) {
  const Json* value = params.find(key);
  return value != nullptr && value->isString() ? value->asString() : std::string();
}

int64_t paramNumber(const Json& params, const char* key, int64_t fallback = -1) {
  const Json* value = params.find(key);
  return value != nullptr && value->isNumber() ? static_cast<int64_t>(value->asNumber())
                                               : fallback;
}

// ── cases ─────────────────────────────────────────────────────────────

void testSignatureRegistered() {
  const FunctionSignature* sig = findSignature(kSigPython);
  CHECK_MSG(sig != nullptr, "builtin:python is not in the registry");
  if (sig == nullptr) return;
  CHECK(sig->displayName == "python script");
  // The documented contract correction: the template is EMPTY and params declare the shape.
  CHECK(sig->inputs.empty());
  CHECK(sig->outputs.empty());
  CHECK(sig->explicitCompute);
  CHECK(sig->portsFromParams);
  bool listed = false;
  for (const FunctionSignature* entry : allSignatures()) listed |= entry->id == kSigPython;
  CHECK_MSG(listed, "builtin:python missing from allSignatures()");

  // Creating one must NOT run anyone's code: explicitCompute is the whole point.
  Fixture fixture;
  const int64_t nodeId = createPythonNode(&fixture, {}, {},
                                          "raise SystemExit('must not run at creation')\n",
                                          {"out"});
  CHECK(nodeId > 0);
  const auto node = fixture.nodes.get(nodeId);
  CHECK(node && node->state == NodeState::Dirty);
  CHECK(node && node->dirtyReason == DirtyReason::NotRequested);
  CHECK(node && node->resultMatrixId() > 0);
  const auto columns = snapshotColumns(fixture.store, node ? node->resultMatrixId() : -1);
  CHECK(columns.empty());
}

void testParamsValidation() {
  Fixture fixture;
  const std::string script = "out = 1.0\n";
  std::string error;

  // Zero ports is legal (a generator card), so a valid declaration must be accepted.
  CHECK(createPythonNode(&fixture, {}, {}, script, {"out"}, -1, &error) > 0);
  CHECK(error.empty());

  // Missing / mistyped fields.
  createPythonNode(&fixture, {}, {}, script, {"out"}, -1, &error);
  {
    Json params = pythonParams(script, {}, {"out"});
    const auto refused = fixture.nodes.createV2(kSigPython, {}, Json::object());
    CHECK(refused.errorCode == "invalidParams");  // no fields at all
    auto wrongScript = params;
    wrongScript.set("script", Json(static_cast<int64_t>(3)));
    CHECK(fixture.nodes.createV2(kSigPython, {}, wrongScript).errorCode == "invalidParams");
    auto noOutputs = pythonParams(script, {}, {});
    CHECK(fixture.nodes.createV2(kSigPython, {}, noOutputs).errorCode == "invalidParams");
    auto dupOutputs = pythonParams(script, {}, {"out", "out"});
    CHECK(fixture.nodes.createV2(kSigPython, {}, dupOutputs).errorCode == "invalidParams");
    // timeout_ms is optional, but when present it must be a positive integer.
    auto zeroTimeout = pythonParams(script, {}, {"out"});
    zeroTimeout.set("timeout_ms", Json(static_cast<int64_t>(0)));
    CHECK_MSG(fixture.nodes.createV2(kSigPython, {}, zeroTimeout).errorCode == "invalidParams",
              "timeout_ms=0 accepted");
    auto textTimeout = pythonParams(script, {}, {"out"});
    textTimeout.set("timeout_ms", Json(std::string("10s")));
    CHECK_MSG(fixture.nodes.createV2(kSigPython, {}, textTimeout).errorCode == "invalidParams",
              "timeout_ms=\"10s\" accepted");
    auto fractionalTimeout = pythonParams(script, {}, {"out"});
    fractionalTimeout.set("timeout_ms", Json(1.5));
    CHECK_MSG(fixture.nodes.createV2(kSigPython, {}, fractionalTimeout).errorCode == "invalidParams",
              "fractional timeout_ms accepted");
  }

  // portNames: count must equal the bound ports, each a Python identifier, no repeats.
  const int64_t source = insertMatrix(&fixture.store, {{1, 2}});
  CHECK(createPythonNode(&fixture, {source}, {}, script, {"out"}, -1, &error) < 0);
  CHECK_MSG(error == "invalidParams", "missing port name accepted (error=%s)", error.c_str());
  CHECK(createPythonNode(&fixture, {source}, {"A", "B"}, script, {"out"}, -1, &error) < 0);
  CHECK_MSG(error == "invalidParams", "port count mismatch accepted");
  CHECK(createPythonNode(&fixture, {source}, {"1A"}, script, {"out"}, -1, &error) < 0);
  CHECK_MSG(error == "invalidParams", "non-identifier port name accepted");
  CHECK(createPythonNode(&fixture, {source}, {"a b"}, script, {"out"}, -1, &error) < 0);
  CHECK_MSG(error == "invalidParams", "port name with a space accepted");
  CHECK(createPythonNode(&fixture, {source}, {"A"}, script, {"out"}, -1, &error) > 0);
  CHECK(error.empty());
}

void testTransposeFramesAreBitExact() {
  Fixture fixture;
  // M is 2 rows x 3 columns: columns [1,4], [2,5], [3,6]. M.T is 3 rows x 2 columns:
  // columns [1,2,3], [4,5,6]. Transposing is the case where the FRAME's column-major layout
  // is what is being judged, not just the numbers.
  const int64_t source = insertMatrix(&fixture.store, {{1, 4}, {2, 5}, {3, 6}});
  const int64_t nodeId =
      createPythonNode(&fixture, {source}, {"A"}, "out = A.T\n", {"out"}, 10000);
  CHECK(nodeId > 0);
  fixture.nodes.computeNow(nodeId);
  const auto node = fixture.nodes.get(nodeId);
  CHECK_MSG(node && node->state == NodeState::Done,
            "state=%s code=%s stderr=%s", node ? nodeName(node->state) : "?",
            node ? node->errorCode.c_str() : "?",
            node ? paramString(node->errorParams, "stderr").c_str() : "?");
  if (!node || node->state != NodeState::Done) return;
  const auto columns = snapshotColumns(fixture.store, node->resultMatrixId());
  CHECK(columns.size() == 2);
  if (columns.size() == 2) {
    checkColumn("transpose column 0", columns[0], {1, 2, 3});
    checkColumn("transpose column 1", columns[1], {4, 5, 6});
  }
  CHECK(node->errorParams.members().empty());
}

void testInvalidDtypeIsInvalidOutput() {
  Fixture fixture;
  const int64_t source = insertMatrix(&fixture.store, {{1, 2}, {3, 4}});
  // float32 is refused on purpose ("绝不静默 astype"): the exit code is 3 and the reason has
  // to survive all the way into the node's error params.
  const int64_t nodeId = createPythonNode(
      &fixture, {source}, {"A"},
      "import numpy as np\nout = A.astype(np.float32)\n", {"out"}, 10000);
  CHECK(nodeId > 0);
  fixture.nodes.computeNow(nodeId);
  const auto node = fixture.nodes.get(nodeId);
  CHECK_MSG(node && node->state == NodeState::Error, "expected an error state");
  if (!node || node->state != NodeState::Error) return;
  CHECK_MSG(node->errorCode == "invalidOutput", "code=%s", node->errorCode.c_str());
  CHECK(paramNumber(node->errorParams, "exitCode") == 3);
  CHECK(paramString(node->errorParams, "name") == "out");
  const std::string stderrTail = paramString(node->errorParams, "stderr");
  CHECK_MSG(stderrTail.find("invalidOutput") != std::string::npos,
            "error detail lost the runner's stderr: %s", stderrTail.c_str());
  CHECK_MSG(stderrTail.find("float32") != std::string::npos,
            "error detail does not name the dtype: %s", stderrTail.c_str());
  CHECK(std::string(paramString(node->errorParams, "reason")).find("float32") !=
        std::string::npos);
}

void testTimeoutKillsTheProcessGroup() {
  Fixture fixture;
  const int64_t source = insertMatrix(&fixture.store, {{1, 2}});
  const int64_t nodeId = createPythonNode(
      &fixture, {source}, {"A"}, "while True:\n    pass\n", {"out"}, 500);
  CHECK(nodeId > 0);
  const auto started = std::chrono::steady_clock::now();
  fixture.nodes.computeNow(nodeId);
  const double seconds =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  const auto node = fixture.nodes.get(nodeId);
  CHECK_MSG(node && node->state == NodeState::Error, "a runaway script did not fail");
  if (!node || node->state != NodeState::Error) return;
  CHECK_MSG(node->errorCode == "scriptTimeout", "code=%s", node->errorCode.c_str());
  CHECK(paramNumber(node->errorParams, "timeout_ms") == 500);
  // The card asked for 500 ms; anything near the 10 s default means the timeout never fired.
  CHECK_MSG(seconds < 5.0, "timeout took %.2fs (kill did not reach the group?)", seconds);
}

void testMissingRuntimeIsRuntimeMissing() {
  Fixture fixture;
  const int64_t source = insertMatrix(&fixture.store, {{1, 2}});
  const std::string bogus = "/nonexistent-datacardforge-pyruntime";
#ifdef _WIN32
  _putenv_s("DC_PYRUNTIME", bogus.c_str());
#else
  setenv("DC_PYRUNTIME", bogus.c_str(), 1);
#endif
  // DC_PYRUNTIME must win outright: a broken override is never replaced by the checkout's
  // runtime, otherwise "missing runtime" would be untestable on a provisioned machine.
  const int64_t nodeId = createPythonNode(&fixture, {source}, {"A"}, "out = A\n", {"out"}, 5000);
  CHECK_MSG(nodeId > 0, "creating the card must not need the runtime");
  if (nodeId > 0) {
    fixture.nodes.computeNow(nodeId);
    const auto node = fixture.nodes.get(nodeId);
    CHECK_MSG(node && node->state == NodeState::Error, "a missing runtime must be an error");
    if (node && node->state == NodeState::Error)
      CHECK_MSG(node->errorCode == "runtimeMissing", "code=%s", node->errorCode.c_str());
  }
#ifndef _WIN32
  unsetenv("DC_PYRUNTIME");
#else
  _putenv_s("DC_PYRUNTIME", "");
#endif
}

void testExtraOutputsFromTheManifest() {
  Fixture fixture;
  // 2x2 input: columns [1,2], [3,4]. `sums` is 1x2, `doubled` keeps the shape: the second
  // declared output must land in extraOutputs, not in a second result matrix (v1 selector
  // plan: output 0 is the display matrix).
  const int64_t source = insertMatrix(&fixture.store, {{1, 2}, {3, 4}});
  const int64_t nodeId = createPythonNode(
      &fixture, {source}, {"A"},
      "sums = A.sum(axis=0, keepdims=True)\ndoubled = A * 2.0\n", {"sums", "doubled"}, 10000);
  CHECK(nodeId > 0);
  fixture.nodes.computeNow(nodeId);
  const auto node = fixture.nodes.get(nodeId);
  CHECK_MSG(node && node->state == NodeState::Done, "state=%s code=%s stderr=%s",
            node ? nodeName(node->state) : "?", node ? node->errorCode.c_str() : "?",
            node ? paramString(node->errorParams, "stderr").c_str() : "?");
  if (!node || node->state != NodeState::Done) return;
  CHECK(node->resultMatrixIds.size() == 1);
  const auto primary = snapshotColumns(fixture.store, node->resultMatrixId());
  CHECK(primary.size() == 2);
  if (primary.size() == 2) {
    checkColumn("sums column 0", primary[0], {3});
    checkColumn("sums column 1", primary[1], {7});
  }
  CHECK_MSG(node->extraOutputs.items().size() == 1, "extraOutputs has %zu entries",
            node->extraOutputs.items().size());
  if (node->extraOutputs.items().size() == 1) {
    const Json& extra = node->extraOutputs.items()[0];
    CHECK(paramString(extra, "name") == "doubled");
    CHECK(paramNumber(extra, "rows") == 2);
    CHECK(paramNumber(extra, "cols") == 2);
    const auto extraColumns = snapshotColumns(fixture.store, paramNumber(extra, "matrixId"));
    CHECK(extraColumns.size() == 2);
    if (extraColumns.size() == 2) {
      checkColumn("doubled column 0", extraColumns[0], {2, 4});
      checkColumn("doubled column 1", extraColumns[1], {6, 8});
    }
  }
}

void testZeroPortGeneratorCard() {
  Fixture fixture;
  // No input ports at all: ports.json is an empty array and the script is the only input.
  const int64_t nodeId = createPythonNode(
      &fixture, {}, {}, "import numpy as np\nout = np.arange(6.0).reshape(3, 2)\n",
      {"out"}, 10000);
  CHECK(nodeId > 0);
  fixture.nodes.computeNow(nodeId);
  const auto node = fixture.nodes.get(nodeId);
  CHECK_MSG(node && node->state == NodeState::Done, "state=%s code=%s stderr=%s",
            node ? nodeName(node->state) : "?", node ? node->errorCode.c_str() : "?",
            node ? paramString(node->errorParams, "stderr").c_str() : "?");
  if (!node || node->state != NodeState::Done) return;
  const auto columns = snapshotColumns(fixture.store, node->resultMatrixId());
  CHECK(columns.size() == 2);
  if (columns.size() == 2) {
    checkColumn("arange column 0", columns[0], {0, 2, 4});
    checkColumn("arange column 1", columns[1], {1, 3, 5});
  }
}

void testCancelKillsTheRun() {
  Fixture fixture;
  const int64_t source = insertMatrix(&fixture.store, {{1, 2}});
  // A large timeout on purpose: only /cancel can end this run inside the test's patience.
  const int64_t nodeId = createPythonNode(
      &fixture, {source}, {"A"}, "while True:\n    pass\n", {"out"}, 30000);
  CHECK(nodeId > 0);
  const auto started = std::chrono::steady_clock::now();
  std::thread runner([&fixture, nodeId] { fixture.nodes.computeNow(nodeId); });
  // cancelRun() only answers true once the child is registered, so polling it doubles as the
  // handshake — no sleep-and-hope.
  bool signalled = false;
  while (std::chrono::steady_clock::now() - started < std::chrono::seconds(10)) {
    if (fixture.nodes.cancelRun(nodeId)) {
      signalled = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  runner.join();
  const double seconds =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
  CHECK_MSG(signalled, "cancelRun never saw a running job");
  CHECK_MSG(seconds < 5.0, "cancel took %.2fs — the kill did not reach the group", seconds);
  const auto node = fixture.nodes.get(nodeId);
  // Cancelling is not a script failure: the card goes back to "not requested yet".
  CHECK(node && node->state == NodeState::Dirty);
  CHECK(node && node->dirtyReason == DirtyReason::NotRequested);
  CHECK(node && node->errorCode.empty());
  CHECK(!fixture.nodes.cancelRun(nodeId));  // nothing left to cancel
}

}  // namespace

int main() {
  // The runtime location is fixed for the whole run: the tests below check the checkout's
  // vendored interpreter, so an inherited override must not decide what they measure.
  std::string runtimePath;
  const std::string repoRoot = findRepoRoot();
#ifdef _WIN32
  _putenv_s("DC_PYRUNTIME", "");
  runtimePath = repoRoot + "\\third_party\\pyruntime\\bin\\python.exe";
#else
  unsetenv("DC_PYRUNTIME");
  runtimePath = repoRoot + "/third_party/pyruntime/bin/python3";
#endif
  std::error_code ec;
  if (repoRoot.empty() || !std::filesystem::is_regular_file(runtimePath, ec)) {
    std::printf("SKIP: python_node (no vendored runtime; run scripts/fetch-python-runtime.sh)\n");
    if (repoRoot.empty())
      std::printf("      not running out of a source checkout "
                  "(no backend/runner/runner.py above the working directory)\n");
    else
      std::printf("      looked for %s\n", runtimePath.c_str());
    return 0;
  }

  testSignatureRegistered();
  testParamsValidation();
  testTransposeFramesAreBitExact();
  testInvalidDtypeIsInvalidOutput();
  testTimeoutKillsTheProcessGroup();
  testMissingRuntimeIsRuntimeMissing();
  testExtraOutputsFromTheManifest();
  testZeroPortGeneratorCard();
  testCancelKillsTheRun();

  std::printf("%s: python_node (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}