#include "nodes.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <queue>
#include <set>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#else
#  include <fcntl.h>
#  include <signal.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <sys/wait.h>
#  include <unistd.h>
#endif

#include "expression.h"
#include "matrix_value.h"  // ShapeError (matrix-mode failures)
#include "signature.h"
#include "summary.h"
#include "units.h"

namespace dc {

const char* nodeName(NodeState s) {
  switch (s) {
    case NodeState::Dirty: return "dirty";
    case NodeState::Computing: return "computing";
    case NodeState::Done: return "done";
    case NodeState::Error: return "error";
  }
  return "dirty";
}

const char* dirtyReasonName(DirtyReason r) {
  switch (r) {
    case DirtyReason::None: return "none";
    case DirtyReason::NotRequested: return "notRequested";
    case DirtyReason::UpstreamChanged: return "upstreamChanged";
    case DirtyReason::DefinitionChanged: return "definitionChanged";
  }
  return "none";
}

// ── DCM2 frame codec ───────────────────────────────────────────────────
// Moved here from http_server.cpp (see nodes.h for why). Behaviour is unchanged: the upload
// path still gets the same bounds and the same error strings, and the serializer still pads
// short columns with NaN so a frame is always rectangular.

namespace {

uint32_t frameReadU32LE(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

double frameReadF64LE(const unsigned char* p) {
  uint64_t bits = 0;
  for (int i = 7; i >= 0; --i) bits = (bits << 8) | p[i];
  double value = 0;
  std::memcpy(&value, &bits, sizeof value);
  return value;
}

}  // namespace

std::string encodeDcm2Frame(const std::vector<std::vector<double>>& columns,
                            const std::vector<std::string>& names, size_t rows,
                            size_t totalRows, size_t totalCols) {
  Json nameArr = Json::array();
  for (const auto& n : names) nameArr.push(Json(n));
  std::string namesJson = nameArr.dump();
  uint32_t magic = 0x44434D32;  // "DCM2"
  uint32_t cols = static_cast<uint32_t>(columns.size());
  uint32_t rowsU = static_cast<uint32_t>(rows);
  uint32_t namesLen = static_cast<uint32_t>(namesJson.size());
  uint32_t totalRowsU = static_cast<uint32_t>(totalRows);
  uint32_t totalColsU = static_cast<uint32_t>(totalCols);
  std::string out;
  out.reserve(24 + columns.size() * rows * 8 + namesLen);
  out.append(reinterpret_cast<char*>(&magic), 4);
  out.append(reinterpret_cast<char*>(&rowsU), 4);
  out.append(reinterpret_cast<char*>(&cols), 4);
  out.append(reinterpret_cast<char*>(&namesLen), 4);
  out.append(reinterpret_cast<char*>(&totalRowsU), 4);
  out.append(reinterpret_cast<char*>(&totalColsU), 4);
  for (const auto& col : columns) {
    std::vector<double> padded = col;
    padded.resize(rows, NAN);
    out.append(reinterpret_cast<const char*>(padded.data()), rows * 8);
  }
  out.append(namesJson);
  return out;
}

bool decodeDcm2Frame(const std::string& frame, std::vector<Column>* columns, std::string* err,
                     size_t maxBytes) {
  if (frame.size() < 16) {
    *err = "frame shorter than the 16-byte header";
    return false;
  }
  const auto* bytes = reinterpret_cast<const unsigned char*>(frame.data());
  const uint32_t magic = frameReadU32LE(bytes);
  // DCM1 is the 16-byte header (no matrix shape); DCM2 adds totalRows/totalCols (24 bytes).
  // Uploads keep accepting both so an old client keeps working after the format grew.
  const bool isV2 = magic == 0x44434D32u;
  if (magic != 0x44434D31u && !isV2) {
    *err = "bad magic (expected DCM1 or DCM2)";
    return false;
  }
  const size_t headerLen = isV2 ? 24u : 16u;
  if (frame.size() < headerLen) {
    *err = "frame shorter than the header";
    return false;
  }
  const uint32_t rows = frameReadU32LE(bytes + 4);
  const uint32_t cols = frameReadU32LE(bytes + 8);
  const uint32_t namesLen = frameReadU32LE(bytes + 12);
  // Bound the shape BEFORE multiplying: rows*cols*8 can wrap uint64 for hostile headers,
  // which would make the truncation check pass and the copy run off the buffer.
  const uint64_t bound = static_cast<uint64_t>(maxBytes);
  if (bound == 0 || cols > bound / 8u || namesLen > bound ||
      (rows > 0 && cols > bound / 8u / rows)) {
    *err = "frame shape too large";
    return false;
  }
  const uint64_t dataLen = static_cast<uint64_t>(rows) * cols * 8u;
  const uint64_t needed = static_cast<uint64_t>(headerLen) + dataLen + namesLen;
  if (frame.size() < needed) {
    *err = "truncated frame";
    return false;
  }
  Json names;
  if (namesLen > 0) {
    std::string namesJson(frame.data() + headerLen + dataLen, namesLen);
    std::string jerr;
    if (!Json::parse(namesJson, &names, &jerr) || !names.isArray()) {
      *err = "bad names payload: " + jerr;
      return false;
    }
  }
  columns->clear();
  columns->reserve(cols);
  for (uint32_t c = 0; c < cols; ++c) {
    Column col;
    if (names.isArray() && c < names.items().size() && names.items()[c].isString())
      Matrix::labelParsed(names.items()[c].asString(), &col.posName, &col.annotation);
    else
      col.posName = "Pos." + std::to_string(c + 1);
    col.data.resize(rows);
    const unsigned char* base = bytes + headerLen + static_cast<size_t>(c) * rows * 8u;
    for (uint32_t r = 0; r < rows; ++r)
      col.data[r] = frameReadF64LE(base + static_cast<size_t>(r) * 8u);
    columns->push_back(std::move(col));
  }
  return true;
}

bool readDcm2FrameFile(const std::string& path, std::vector<Column>* columns, std::string* err) {
  std::error_code ec;
  const std::uintmax_t size = std::filesystem::file_size(path, ec);
  if (ec) {
    *err = "cannot stat " + path;
    return false;
  }
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    *err = "cannot open " + path;
    return false;
  }
  std::string bytes(static_cast<size_t>(size), '\0');
  if (size > 0) in.read(bytes.data(), static_cast<std::streamsize>(size));
  if (in.gcount() != static_cast<std::streamsize>(size)) {
    *err = "short read on " + path;
    return false;
  }
  // The file is the child's whole output, so its own size is the only honest bound — an
  // output table has no business being capped at the HTTP request-body limit.
  return decodeDcm2Frame(bytes, columns, err, static_cast<size_t>(size));
}

// ── repository root ────────────────────────────────────────────────────

namespace {

bool isRepoRoot(const std::filesystem::path& dir) {
  std::error_code ec;
  return std::filesystem::is_regular_file(dir / "backend" / "runner" / "runner.py", ec);
}

// Nearest ancestor of `start` that looks like this checkout. The deployment runs from the
// repo by design (systemd WorkingDirectory=<repo>/backend) and ctest runs from
// <repo>/backend/build, and main.cpp's findWebRoot starts from the working directory for the
// same reason — the project has no build-time asset path and this feature does not invent
// one.
std::string nearestRepoRoot(const std::filesystem::path& start) {
  if (start.empty()) return {};
  std::filesystem::path dir = start;
  for (int depth = 0; depth < 8; ++depth) {
    if (isRepoRoot(dir)) return dir.string();
    const std::filesystem::path parent = dir.parent_path();
    if (parent.empty() || parent == dir) break;
    dir = parent;
  }
  return {};
}

// The running binary's own directory, so a backend started from elsewhere by absolute path
// still finds the checkout. POSIX has /proc/self/exe; Windows has GetModuleFileNameW.
std::filesystem::path executablePath() {
#ifdef _WIN32
  std::wstring buffer(MAX_PATH * 4, L'\0');
  const DWORD n = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (n == 0 || static_cast<size_t>(n) >= buffer.size()) return {};
  buffer.resize(static_cast<size_t>(n));
  return std::filesystem::path(buffer);
#else
  std::vector<char> buffer(4096, '\0');
  for (;;) {
    const ssize_t n = ::readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
    if (n < 0) return {};
    if (static_cast<size_t>(n) < buffer.size() - 1) {
      buffer[static_cast<size_t>(n)] = '\0';
      return std::filesystem::path(buffer.data());
    }
    buffer.resize(buffer.size() * 2, '\0');
  }
#endif
}

constexpr int64_t kDefaultScriptTimeoutMs = 10000;
// The upper bound is about arithmetic, not a product decision: the value becomes a chrono
// deadline and a signed millisecond budget in the runner's meta.
constexpr int64_t kMaxScriptTimeoutMs = 2147483647;

bool isPythonIdentifier(const std::string& name) {
  // ASCII letter / underscore first, then letters, digits, underscore. Python's
  // str.isidentifier() is wider, but a port name is a UI label AND a script variable; the
  // subset both ends agree on is what this contract fixes.
  if (name.empty()) return false;
  const auto alpha = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
  const auto digit = [](char c) { return c >= '0' && c <= '9'; };
  if (!alpha(name[0]) && name[0] != '_') return false;
  for (size_t i = 1; i < name.size(); ++i) {
    const char c = name[i];
    if (!alpha(c) && !digit(c) && c != '_') return false;
  }
  return true;
}

// Returns the offending parameter name, or an empty string when the declaration is usable.
// Runs at creation (→ 400 invalidParams) and again before every evaluation, because PATCH
// /api/nodes/{id} can replace params without passing through creation — and the runner
// answers a malformed declaration with exit 64, which would blame the script for a card bug.
std::string validatePythonParams(const Json& params, size_t boundPorts) {
  if (!params.isObject()) return "params";
  const Json* script = params.find("script");
  if (script == nullptr || !script->isString()) return "script";
  // The declaration has to cover the bound ports exactly: zero ports is legal (a generator
  // card prints no input), a mismatch means the card would inject a different set of names
  // than its ports promise.
  const Json* portNames = params.find("portNames");
  if (portNames == nullptr || !portNames->isArray()) return "portNames";
  if (portNames->items().size() != boundPorts) return "portNames";
  std::set<std::string> seenPorts;
  for (const Json& item : portNames->items()) {
    if (!item.isString() || !isPythonIdentifier(item.asString())) return "portNames";
    if (!seenPorts.insert(item.asString()).second) return "portNames";
  }
  const Json* outputs = params.find("outputs");
  if (outputs == nullptr || !outputs->isArray() || outputs->items().empty()) return "outputs";
  std::set<std::string> seenOutputs;
  for (const Json& item : outputs->items()) {
    if (!item.isString() || item.asString().empty()) return "outputs";
    if (!seenOutputs.insert(item.asString()).second) return "outputs";
  }
  if (const Json* timeout = params.find("timeout_ms")) {
    if (!timeout->isNumber() || !std::isfinite(timeout->asNumber())) return "timeout_ms";
    const double value = timeout->asNumber();
    if (value != std::floor(value) || value < 1 ||
        value > static_cast<double>(kMaxScriptTimeoutMs))
      return "timeout_ms";
  }
  return "";
}

}  // namespace

std::string findRepoRoot() {
  std::error_code ec;
  const std::string fromCwd = nearestRepoRoot(std::filesystem::current_path(ec));
  if (!fromCwd.empty()) return fromCwd;
  const std::filesystem::path exe = executablePath();
  return exe.empty() ? std::string() : nearestRepoRoot(exe.parent_path());
}

void EventBus::publish(Json event) {
  std::lock_guard<std::mutex> lock(mu_);
  log_.emplace_back(nextSeq_++, std::move(event));
  if (log_.size() > kMaxLog) log_.pop_front();
  cv_.notify_all();
}

std::vector<std::pair<int64_t, Json>> EventBus::wait(int64_t since, int timeoutMs) {
  std::unique_lock<std::mutex> lock(mu_);
  cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
               [&] { return log_.empty() ? false : log_.back().first > since; });
  std::vector<std::pair<int64_t, Json>> out;
  for (const auto& e : log_)
    if (e.first > since) out.push_back(e);
  return out;
}

bool NodeRegistry::wouldCycle(int64_t dependentId, int64_t dependsOnId,
                              std::vector<int64_t>* pathOut) const {
  // If `dependsOnId` already sits on top of `dependentId` (transitively through the
  // dependency direction), adding dependentId -> dependsOnId closes a loop.
  // BFS from dependsOnId over upstream sources, looking for dependentId.
  if (dependentId == dependsOnId) {
    if (pathOut) pathOut->assign({dependentId, dependentId});
    return true;
  }
  std::map<int64_t, int64_t> previous;  // node -> parent on the found path
  std::queue<int64_t> queue;
  std::set<int64_t> seen{dependsOnId};
  queue.push(dependsOnId);
  while (!queue.empty()) {
    int64_t current = queue.front();
    queue.pop();
    // Upstream of `current`: its input bindings' source keys (matrices are sinks),
    // plus — when `current` is a result matrix — the node that produced it.
    std::vector<int64_t> ups;
    auto dit = dependencies_.find(current);
    if (dit != dependencies_.end()) ups.assign(dit->second.begin(), dit->second.end());
    auto ownerIt = resultOwner_.find(current);
    if (ownerIt != resultOwner_.end() &&
        std::find(ups.begin(), ups.end(), ownerIt->second.first) == ups.end())
      ups.push_back(ownerIt->second.first);
    for (int64_t up : ups) {
      if (seen.count(up)) continue;
      seen.insert(up);
      previous[up] = current;
      if (up == dependentId) {
        if (pathOut) {
          std::vector<int64_t> path{up};
          int64_t cursor = up;
          while (cursor != dependsOnId) {
            cursor = previous[cursor];
            path.push_back(cursor);
          }
          std::reverse(path.begin(), path.end());
          path.push_back(dependsOnId);  // ring: start and end at the same node
          *pathOut = path;
        }
        return true;
      }
      queue.push(up);
    }
  }
  return false;
}

namespace {

// Does this node's signature say "evaluate only when explicitly asked"?
// Unknown signatures (should not exist past creation) are treated as eager, which is the
// safe direction: computing a node that did not want to be computed is visible, while
// silently never computing one is not.
bool wantsExplicitCompute(const ComputeNode& node) {
  const FunctionSignature* sig = findSignature(node.signatureId);
  return sig != nullptr && sig->explicitCompute;
}

// Shared creation body. REQUIRES the registry lock to be held (create/createV2 take it).
// `nOutputs` comes from the signature (K), never from the data.
NodeRegistry::CreateResult createLocked(std::map<int64_t, ComputeNode>* nodes,
                                        std::map<int64_t, std::set<int64_t>>* dependents,
                                        std::map<int64_t, std::set<int64_t>>* dependencies,
                                        std::map<int64_t, std::pair<int64_t, int32_t>>* owners,
                                        MatrixStore* store, int64_t nodeId,
                                        const std::string& signatureId,
                                        const std::vector<PortBinding>& inputs,
                                        const std::string& formula, const Json& params,
                                        size_t nOutputs) {
  NodeRegistry::CreateResult result;
  ComputeNode node;
  node.id = nodeId;
  node.signatureId = signatureId;
  // v2: `portId` is the identity. A v1 client that only sends `varName` keeps working —
  // the identity then falls back to the declared variable name.
  for (PortBinding b : inputs) {
    if (b.portId.empty()) b.portId = b.varName;
    node.inputs.push_back(std::move(b));
  }
  node.formula = formula;
  node.params = params;
  // K is a signature property, never data-dependent.
  for (size_t i = 0; i < nOutputs; ++i) node.resultMatrixIds.push_back(store->insert(Matrix{}));
  for (size_t i = 0; i < node.resultMatrixIds.size(); ++i)
    (*owners)[NodeRegistry::matrixKey(node.resultMatrixIds[i])] = {nodeId, static_cast<int32_t>(i)};
  for (const auto& b : node.inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    int64_t key = NodeRegistry::sourceKey(b);
    (*dependents)[key].insert(nodeId);
    (*dependencies)[nodeId].insert(key);
  }
  nodes->emplace(nodeId, std::move(node));
  result.nodeId = nodeId;
  return result;
}

}  // namespace

NodeRegistry::CreateResult NodeRegistry::create(const std::vector<PortBinding>& inputs,
                                                const std::string& formula) {
  std::lock_guard<std::mutex> lock(mu_);
  CreateResult result;

  // Atomic edge check: every source must exist and no edge may close a loop.
  int64_t tentativeId = nextNodeId_;
  for (const auto& b : inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    std::vector<int64_t> path;
    if (wouldCycle(tentativeId, sourceKey(b), &path)) {
      result.cyclePath = path;
      return result;
    }
  }

  int64_t nodeId = nextNodeId_++;
  return createLocked(&nodes_, &dependents_, &dependencies_, &resultOwner_, store_, nodeId, "",
                      inputs, formula, Json::object(), 1);
}

NodeRegistry::CreateResult NodeRegistry::createV2(const std::string& signatureId,
                                                  const std::vector<PortBinding>& inputs,
                                                  const Json& params) {
  std::lock_guard<std::mutex> lock(mu_);
  const FunctionSignature* sig = findSignature(signatureId);
  if (!sig) {
    CreateResult refused;
    refused.errorCode = "unknownSignature";
    return refused;
  }

  // The signature declares the ports; a card may not invent its own. Refusing unknown or
  // missing REQUIRED ports here (rather than failing later inside evaluation) keeps the
  // contract where the spec puts it: the signature is the shape of the card.
  // See docs/architecture/port-semantics-v1.md §inputs.
  //
  // `portsFromParams` (builtin:python) is the documented exception: the signature is an
  // empty template, so there are no declared ports to match — the DECLARATION in params is
  // validated instead, and its port count must match the bindings exactly
  // (docs/decisions/2026-11-15-python-script-card.md §三).
  size_t nOutputs = sig->outputs.size();
  if (sig->portsFromParams) {
    const std::string badParam = validatePythonParams(params, inputs.size());
    if (!badParam.empty()) {
      CreateResult refused;
      refused.errorCode = "invalidParams";
      return refused;
    }
    // Output 0 is always the display matrix; the remaining declared outputs are allocated
    // below as `extraOutputs`.
    nOutputs = 1;
  } else {
    std::set<std::string> bound;
    for (const auto& b : inputs) bound.insert(b.portId.empty() ? b.varName : b.portId);
    for (const auto& binding : bound) {
      bool declared = false;
      for (const auto& port : sig->inputs) {
        if (port.portId == binding) {
          declared = true;
          break;
        }
      }
      if (!declared) {
        CreateResult refused;
        refused.errorCode = "unknownPort";
        return refused;
      }
    }
    for (const auto& port : sig->inputs) {
      if (port.required && bound.count(port.portId) == 0) {
        CreateResult refused;
        refused.errorCode = "unboundPort";
        return refused;
      }
    }
  }

  // Atomic edge check (same rule as v1): every source must exist, no edge may close a loop.
  int64_t tentativeId = nextNodeId_;
  for (const auto& b : inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    std::vector<int64_t> path;
    if (wouldCycle(tentativeId, sourceKey(b), &path)) {
      CreateResult result;
      result.cyclePath = path;
      return result;
    }
  }

  int64_t nodeId = nextNodeId_++;
  CreateResult created = createLocked(&nodes_, &dependents_, &dependencies_, &resultOwner_,
                                      store_, nodeId, signatureId, inputs, "", params,
                                      nOutputs);
  if (sig->explicitCompute && created.nodeId >= 0) {
    auto it = nodes_.find(created.nodeId);
    if (it != nodes_.end()) {
      // `explicitCompute` signatures are born "not requested": the result matrices exist (K
      // is fixed by the signature) but hold no numbers until the client asks. Saying so here
      // — rather than in the HTTP layer — keeps the status honest for every caller, fixtures
      // included.
      it->second.dirtyReason = DirtyReason::NotRequested;
      // A portsFromParams card declares its outputs, so their matrices are allocated NOW
      // (K is fixed by the declaration, not by the run): the ids stay stable for the life of
      // the card and a run only fills them.
      if (sig->portsFromParams) {
        const Json* declaredOutputs = params.find("outputs");
        Json extras = Json::array();
        if (declaredOutputs != nullptr && declaredOutputs->isArray()) {
          for (size_t i = 1; i < declaredOutputs->items().size(); ++i) {
            const int64_t matrixId = store_->insert(Matrix{});
            resultOwner_[matrixKey(matrixId)] = {created.nodeId, static_cast<int32_t>(i)};
            extras.push(Json::object({{"name", Json(declaredOutputs->items()[i].asString())},
                                      {"matrixId", Json(matrixId)},
                                      {"rows", Json(static_cast<int64_t>(0))},
                                      {"cols", Json(static_cast<int64_t>(0))}}));
          }
        }
        it->second.extraOutputs = std::move(extras);
      }
    }
  }
  return created;
}

bool NodeRegistry::updateParams(int64_t nodeId, const Json& params) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;
  it->second.params = params;
  it->second.state = NodeState::Dirty;
  it->second.dirtyReason = DirtyReason::DefinitionChanged;
  ++it->second.definitionVersion;
  return true;
}

bool NodeRegistry::update(int64_t nodeId, const std::string* formula,
                          const std::vector<PortBinding>* inputs,
                          std::vector<int64_t>* cycleOut) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;

  if (inputs) {
    // Validate every new edge FIRST, against the still-unchanged graph. wouldCycle()
    // walks the dependency map upwards from the source and never consults this node's
    // own inputs, so the old edge set does not have to be torn down to run the check —
    // and it must not be: a rejected PATCH has to leave the previous bindings intact
    // (audit finding: the old code dropped them before validating, so a 409 cycle
    // silently broke a node that had been working).
    std::vector<int64_t> path;
    for (const auto& b : *inputs) {
      if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
      if (wouldCycle(nodeId, sourceKey(b), &path)) {
        if (cycleOut) *cycleOut = path;
        return false;  // atomic refusal: no edge added, none removed
      }
    }
    // Commit only after the whole batch is known to be acceptable.
    for (auto& d : dependencies_[nodeId]) dependents_[d].erase(nodeId);
    dependencies_[nodeId].clear();
    it->second.inputs.clear();
    for (PortBinding b : *inputs) {
      if (b.portId.empty()) b.portId = b.varName;
      it->second.inputs.push_back(std::move(b));
    }
    for (const auto& b : it->second.inputs) {
      if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
      int64_t key = sourceKey(b);
      dependents_[key].insert(nodeId);
      dependencies_[nodeId].insert(key);
    }
  }
  if (formula) it->second.formula = *formula;
  it->second.state = NodeState::Dirty;
  it->second.dirtyReason = DirtyReason::DefinitionChanged;
  ++it->second.definitionVersion;
  return true;
}

bool NodeRegistry::remove(int64_t nodeId, bool* hadDependents) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;
  auto depIt = dependents_.find(nodeId);
  if (depIt != dependents_.end() && !depIt->second.empty()) {
    if (hadDependents) *hadDependents = true;
    return false;
  }
  if (hadDependents) *hadDependents = false;
  for (auto& d : dependencies_[nodeId]) dependents_[d].erase(nodeId);
  dependencies_.erase(nodeId);
  dependents_.erase(nodeId);
  // K outputs: release every result matrix this node owns.
  std::vector<int64_t> results = it->second.resultMatrixIds;
  // Script-card extra outputs are node results as well.
  for (const Json& extra : it->second.extraOutputs.items()) {
    if (extra["matrixId"].isNumber())
      results.push_back(static_cast<int64_t>(extra["matrixId"].asNumber()));
  }
  for (int64_t resultId : results) resultOwner_.erase(matrixKey(resultId));
  nodes_.erase(it);
  for (int64_t resultId : results) store_->remove(resultId);
  return true;
}

std::optional<ComputeNode> NodeRegistry::get(int64_t nodeId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return std::nullopt;
  return it->second;
}

bool NodeRegistry::removeMatrix(int64_t matrixId, bool* hadDependents) {
  std::lock_guard<std::mutex> lock(mu_);
  const int64_t key = matrixKey(matrixId);
  auto dit = dependents_.find(key);
  if (dit != dependents_.end() && !dit->second.empty()) {
    if (hadDependents) *hadDependents = true;
    return false;
  }
  if (resultOwner_.find(key) != resultOwner_.end()) {
    // It is some node's output matrix; deleting it would orphan the producer.
    if (hadDependents) *hadDependents = true;
    return false;
  }
  dependents_.erase(key);
  if (hadDependents) *hadDependents = false;
  return store_->remove(matrixId);
}

std::vector<int64_t> NodeRegistry::dependentsOf(int64_t nodeId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = dependents_.find(nodeId);
  if (it == dependents_.end()) return {};
  return std::vector<int64_t>(it->second.begin(), it->second.end());
}

std::vector<int64_t> NodeRegistry::allNodeIds() const {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<int64_t> ids;
  for (const auto& kv : nodes_) ids.push_back(kv.first);
  return ids;
}

bool NodeRegistry::gatherInputs(const std::vector<PortBinding>& bindings,
                                std::vector<std::string>* names,
                                std::vector<std::vector<double>>* data, size_t* length,
                                std::vector<PortSlice>* slices, std::string* errorCode,
                                std::string* errorName) {
  names->clear();
  data->clear();
  slices->clear();
  *length = 0;
  // Port semantics (v1): a port binds a whole table to a declared variable.
  // Every column stays addressable under its natural label; a single-column table is
  // additionally aliased to the declared varName so `a + 1` reads naturally. Multi-
  // column tables get per-column slicing from the deferred conditional-filter card.
  //
  // The registry lock is taken per binding and released before touching the matrix store:
  // copying a huge table must not block unrelated node writers (max-headroom). Lock order
  // is always registry → store, never the reverse.
  for (const auto& b : bindings) {
    int64_t matrixId = -1;
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (b.sourceNodeId >= 0) {
        auto nit = nodes_.find(b.sourceNodeId);
        if (nit == nodes_.end()) {
          *errorCode = "unknownColumn";
          *errorName = b.varName;
          return false;
        }
        if (nit->second.state == NodeState::Error) {
          // Never compute on a dead upstream: its stored result is cleared, and reporting
          // the cause is more useful than the generic "unbound input".
          *errorCode = "upstreamError";
          *errorName = "upstream node " + std::to_string(b.sourceNodeId) + " failed (" +
                       nit->second.errorCode + ")";
          return false;
        }
        // v2: pick the declared output of a K-output upstream.
        const auto& outs = nit->second.resultMatrixIds;
        if (b.sourceOutputIndex < 0 ||
            static_cast<size_t>(b.sourceOutputIndex) >= outs.size()) {
          *errorCode = "unknownColumn";
          *errorName = b.varName + " (missing output " + std::to_string(b.sourceOutputIndex) + ")";
          return false;
        }
        matrixId = outs[static_cast<size_t>(b.sourceOutputIndex)];
      } else if (b.sourceMatrixId >= 0) {
        // A node result can be bound as a plain matrix; when its producer failed, this
        // port must inherit the error instead of reading the (now cleared) result.
        auto ownerIt = resultOwner_.find(matrixKey(b.sourceMatrixId));
        if (ownerIt != resultOwner_.end()) {
          auto nit = nodes_.find(ownerIt->second.first);
          if (nit != nodes_.end() && nit->second.state == NodeState::Error) {
            *errorCode = "upstreamError";
            *errorName = "upstream node " + std::to_string(ownerIt->second.first) +
                         " failed (" + nit->second.errorCode + ")";
            return false;
          }
        }
        matrixId = b.sourceMatrixId;
      } else {
        *errorCode = "unknownColumn";
        *errorName = b.varName;
        return false;
      }
    }

    size_t columnCount = 0;
    const std::string alias = b.varName;
    const size_t firstColumn = names->size();
    const bool cellMode = b.mode == "cell" && b.columnIndex >= 0;
    const int32_t wantedColumn = b.columnIndex;
    const bool found = store_->withMatrix(matrixId, [&](const Matrix& m) {
      if (cellMode) {
        // A port declared as a COLUMN binds exactly that column: signatures that take a
        // column (not a table) must not receive the whole table and quietly pick one.
        if (static_cast<size_t>(wantedColumn) >= m.columnCount()) return;
        const Column& col = m.column(static_cast<size_t>(wantedColumn));
        names->push_back(Matrix::label(col));
        data->push_back(col.data);
        columnCount = 1;
        *length = std::max(*length, m.rowCount());
        return;
      }
      for (const auto& col : m.columns()) {
        names->push_back(Matrix::label(col));
        data->push_back(col.data);
      }
      // The alias must keep names.size() == data.size(): the engine indexes data by the
      // resolved name index (a mismatched pair reads out of bounds — found by smoke test).
      if (m.columnCount() == 1 && !alias.empty()) {
        names->push_back(alias);
        data->push_back(m.column(0).data);
      }
      columnCount = m.columnCount();
      *length = std::max(*length, m.rowCount());
    });
    if (!found || columnCount == 0) {
      *errorCode = "unknownColumn";
      *errorName = b.varName;
      return false;
    }
    slices->push_back({firstColumn, columnCount});
  }
  return true;
}

// ── script cards (builtin:python) ──────────────────────────────────────
//
// A script card is a function: its ports arrive as name bindings, its outputs are collected
// by name, and data crosses the process boundary ONLY as DCM2 frames in files — stdout is
// never a data channel (docs/decisions/2026-11-15-python-script-card.md §五). The
// interpreter runs in a clean-room child: cleared environment, cwd = a unique temporary
// directory, killed as a process GROUP on timeout or /cancel. The runner is not a sandbox;
// the boundary is process isolation plus a pinned supply chain, not code review.

namespace {

constexpr int kRunnerExitScriptError = 2;     // the script raised
constexpr int kRunnerExitOutput = 3;          // a declared output is missing or not float64
constexpr int kRunnerExitRuntimeMissing = 5;  // numpy / dcm2.py could not be imported
constexpr int kRunnerExitSyntax = 6;          // the script does not compile
constexpr size_t kScriptStderrTailBytes = 4096;

bool writeFileBytes(const std::filesystem::path& path, const std::string& bytes) {
  std::error_code ec;
  std::filesystem::create_directories(path.parent_path(), ec);
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) return false;
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  return out.good();
}

bool readFileBytes(const std::filesystem::path& path, std::string* bytes) {
  std::error_code ec;
  const std::uintmax_t size = std::filesystem::file_size(path, ec);
  if (ec) return false;
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  bytes->assign(static_cast<size_t>(size), '\0');
  if (size > 0) in.read(bytes->data(), static_cast<std::streamsize>(size));
  return in.gcount() == static_cast<std::streamsize>(size);
}

// Last `maxBytes` bytes of a file. A failure's explanation sits at the END of a traceback,
// and a script that prints in a loop must not make us allocate its whole log.
std::string readFileTail(const std::filesystem::path& path, size_t maxBytes) {
  std::error_code ec;
  const std::uintmax_t size = std::filesystem::file_size(path, ec);
  if (ec || size == 0) return {};
  const size_t want = static_cast<size_t>(std::min<std::uintmax_t>(size, maxBytes));
  std::ifstream in(path, std::ios::binary);
  if (!in) return {};
  in.seekg(static_cast<std::streamoff>(size - want));
  std::string out(want, '\0');
  in.read(out.data(), static_cast<std::streamsize>(want));
  out.resize(static_cast<size_t>(in.gcount()));
  return out;
}

// The runner writes one JSON line first ({"error":"invalidOutput","output":...}) and a human
// sentence after it. Lifting the fields keeps the client on code+params instead of parsing
// prose (protocol v1: the UI localises from the code and its params).
Json firstStderrJson(const std::string& stderrText) {
  const size_t eol = stderrText.find('\n');
  const std::string line =
      stderrText.substr(0, eol == std::string::npos ? stderrText.size() : eol);
  if (line.empty() || line.front() != '{') return Json();
  Json parsed;
  std::string parseError;
  if (!Json::parse(line, &parsed, &parseError) || !parsed.isObject()) return Json();
  return parsed;
}

void sleepMillis(int millis) {
#ifdef _WIN32
  ::Sleep(static_cast<DWORD>(millis));
#else
  struct timespec ts;
  ts.tv_sec = millis / 1000;
  ts.tv_nsec = static_cast<long>(millis % 1000) * 1000000L;
  ::nanosleep(&ts, nullptr);
#endif
}

// Unique scratch directory for one run: ports.json, the frames and the child's cwd all live
// here, so two cards can never see each other's files.
bool makeTempDir(std::filesystem::path* out) {
  std::error_code ec;
  const std::filesystem::path parent = std::filesystem::temp_directory_path(ec);
  if (ec) return false;
#ifdef _WIN32
  for (int attempt = 0; attempt < 64; ++attempt) {
    const std::filesystem::path candidate =
        parent / ("dcpy-" + std::to_string(::GetCurrentProcessId()) + "-" +
                  std::to_string(::GetTickCount64()) + "-" + std::to_string(attempt));
    if (std::filesystem::create_directory(candidate, ec)) {
      *out = candidate;
      return true;
    }
    ec.clear();
  }
  return false;
#else
  std::string pattern = (parent / "dcpy-XXXXXX").string();
  std::vector<char> buffer(pattern.begin(), pattern.end());
  buffer.push_back('\0');
  if (::mkdtemp(buffer.data()) == nullptr) return false;
  *out = std::filesystem::path(buffer.data());
  return true;
#endif
}

// Removes the run's scratch directory on every exit path (success, error, timeout, cancel).
struct TempDirGuard {
  std::filesystem::path dir;
  ~TempDirGuard() {
    if (dir.empty()) return;
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
  }
};

// The vendored interpreter: its declaration lives in nodes.h because /api/script/check
// resolves the runtime with the same rule a run does. The definition moved out of this
// anonymous namespace (below) for the same reason; behaviour is unchanged.
struct ScriptPaths {
  std::filesystem::path tmp;     // scratch directory = the child's cwd
  std::filesystem::path in;      // tmp/in: ports.json + one frame per port
  std::filesystem::path out;     // tmp/out.dcm2 (declared output 0)
  std::filesystem::path meta;    // tmp/meta.json (carries the script text)
  std::filesystem::path runner;  // <repo>/backend/runner/runner.py
  std::filesystem::path python;  // <runtime>/bin/python3
  std::filesystem::path pylib;   // <repo>/third_party/pylib
};

struct ProcessOutcome {
  bool launched = false;
  bool timedOut = false;
  bool cancelled = false;
  int exitCode = -1;
  std::string launchError;
};

#ifndef _WIN32

// fork + execve. Everything the child needs is prepared BEFORE the fork: between fork and
// exec only async-signal-safe calls are allowed (no allocation, no C++ objects), because the
// other server threads keep running and the child inherits their locks.
ProcessOutcome runPythonChild(const ScriptPaths& paths, int64_t timeoutMs,
                              std::atomic<bool>* cancelRequested,
                              std::atomic<int64_t>* pgidSlot) {
  ProcessOutcome outcome;
  std::vector<std::string> argvStorage = {paths.python.string(),
                                          paths.runner.string(),
                                          "--in",
                                          paths.in.string(),
                                          "--out",
                                          paths.out.string(),
                                          "--meta",
                                          paths.meta.string()};
  std::vector<char*> argv;
  argv.reserve(argvStorage.size() + 1);
  for (std::string& arg : argvStorage) argv.push_back(const_cast<char*>(arg.c_str()));
  argv.push_back(nullptr);
  // Cleared environment: PATH and PYTHONPATH are the only things a card run inherits
  // (decision §五). numpy arrives through PYTHONPATH, so the child needs no site-packages.
  std::vector<std::string> envStorage = {
      "PATH=/usr/bin:/bin",
      "PYTHONPATH=" + paths.pylib.string(),
  };
  std::vector<char*> envp;
  envp.reserve(envStorage.size() + 1);
  for (std::string& kv : envStorage) envp.push_back(const_cast<char*>(kv.c_str()));
  envp.push_back(nullptr);
  const std::string stdoutPath = (paths.tmp / "stdout.log").string();
  const std::string stderrPath = (paths.tmp / "stderr.log").string();
  const std::string cwd = paths.tmp.string();
  char* const program = argv[0];

  if (cancelRequested->load()) {
    outcome.cancelled = true;
    return outcome;
  }
  const pid_t pid = ::fork();
  if (pid < 0) {
    outcome.launchError = "fork failed (errno " + std::to_string(errno) + ")";
    return outcome;
  }
  if (pid == 0) {
    // Child. async-signal-safe calls only from here on.
    ::setpgid(0, 0);  // own process group: a timeout kills the script AND anything it spawned
    const int nullIn = ::open("/dev/null", O_RDONLY);
    if (nullIn >= 0) {
      ::dup2(nullIn, STDIN_FILENO);
      ::close(nullIn);
    }
    const int outFd = ::open(stdoutPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (outFd >= 0) {
      ::dup2(outFd, STDOUT_FILENO);
      ::close(outFd);
    }
    const int errFd = ::open(stderrPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (errFd >= 0) {
      ::dup2(errFd, STDERR_FILENO);
      ::close(errFd);
    }
    if (::chdir(cwd.c_str()) != 0) ::_exit(126);
    ::execve(program, argv.data(), envp.data());
    ::_exit(127);
  }
  // Parent. Publish the group id before waiting, so /cancel has something to signal.
  outcome.launched = true;
  // Both sides call setpgid (the standard idiom): the child may still be between fork and
  // its own setpgid(0, 0), and until one of them runs, the group pid does not exist — a
  // timeout or /cancel racing into kill(-pid) would hit ESRCH and then block forever below.
  ::setpgid(pid, 0);  // EACCES once the child has exec'd; harmless, the group is already there
  pgidSlot->store(static_cast<int64_t>(pid));
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    int status = 0;
    const pid_t reaped = ::waitpid(pid, &status, WNOHANG);
    if (reaped == pid) {
      pgidSlot->store(0);  // the group id is no longer ours to signal
      outcome.exitCode = WIFEXITED(status)
                             ? WEXITSTATUS(status)
                             : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      // /cancel kills from the HTTP thread, so the kill can be what ended the child before
      // this poll noticed the flag. A clean exit still wins (the run finished on its own);
      // anything else is the cancel, not a script failure.
      const bool cleanExit = WIFEXITED(status) && WEXITSTATUS(status) == 0;
      outcome.cancelled = cancelRequested->load() && !cleanExit;
      outcome.timedOut = false;
      return outcome;
    }
    if (reaped < 0 && errno != EINTR) {
      // ECHILD: someone else reaped our child. Never expected — report it, do not hang.
      pgidSlot->store(0);
      outcome.launchError = "waitpid failed (errno " + std::to_string(errno) + ")";
      return outcome;
    }
    if (cancelRequested->load() || std::chrono::steady_clock::now() >= deadline) {
      const bool cancelled = cancelRequested->load();
      const int64_t pgid = pgidSlot->load();
      if (pgid > 1) ::kill(static_cast<pid_t>(-pgid), SIGKILL);
      while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
      }
      pgidSlot->store(0);
      outcome.cancelled = cancelled;
      outcome.timedOut = !cancelled;
      return outcome;
    }
    sleepMillis(5);
  }
}

#else  // _WIN32

// CreateProcessW. Correctness is verified on Linux only (the spec's stance); what matters
// here is that the SAME contract holds — cleared environment, cwd = the scratch directory,
// the child terminated on timeout/cancel — and that the branch compiles.
ProcessOutcome runPythonChild(const ScriptPaths& paths, int64_t timeoutMs,
                              std::atomic<bool>* cancelRequested,
                              std::atomic<int64_t>* pgidSlot) {
  ProcessOutcome outcome;
  const auto quote = [](const std::filesystem::path& p) { return L"\"" + p.wstring() + L"\""; };
  const std::wstring command = quote(paths.python) + L" " + quote(paths.runner) + L" --in " +
                               quote(paths.in) + L" --out " + quote(paths.out) + L" --meta " +
                               quote(paths.meta);
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');

  // Environment block: PATH + PYTHONPATH only, then the double NUL that ends it.
  std::vector<wchar_t> environment;
  const auto appendVar = [&environment](const std::wstring& kv) {
    environment.insert(environment.end(), kv.begin(), kv.end());
    environment.push_back(L'\0');
  };
  appendVar(L"PATH=" + paths.python.parent_path().wstring() + L";C:\\Windows\\System32");
  appendVar(L"PYTHONPATH=" + paths.pylib.wstring());
  environment.push_back(L'\0');

  SECURITY_ATTRIBUTES inheritable{};
  inheritable.nLength = sizeof inheritable;
  inheritable.bInheritHandle = TRUE;
  const std::wstring stdoutPath = (paths.tmp / "stdout.log").wstring();
  const std::wstring stderrPath = (paths.tmp / "stderr.log").wstring();
  HANDLE handleIn = ::CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE handleOut =
      ::CreateFileW(stdoutPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &inheritable, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE handleErr =
      ::CreateFileW(stderrPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &inheritable, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  STARTUPINFOW startup{};
  startup.cb = sizeof startup;
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = handleIn;
  startup.hStdOutput = handleOut;
  startup.hStdError = handleErr;
  PROCESS_INFORMATION process{};
  const std::wstring cwd = paths.tmp.wstring();
  const BOOL started = ::CreateProcessW(
      paths.python.wstring().c_str(), commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
      environment.data(), cwd.c_str(), &startup, &process);
  if (handleIn != INVALID_HANDLE_VALUE) ::CloseHandle(handleIn);
  if (handleOut != INVALID_HANDLE_VALUE) ::CloseHandle(handleOut);
  if (handleErr != INVALID_HANDLE_VALUE) ::CloseHandle(handleErr);
  if (!started) {
    outcome.launchError = "CreateProcessW failed (error " +
                          std::to_string(static_cast<long long>(::GetLastError())) + ")";
    return outcome;
  }
  ::CloseHandle(process.hThread);
  outcome.launched = true;
  pgidSlot->store(static_cast<int64_t>(process.dwProcessId));
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    if (::WaitForSingleObject(process.hProcess, 5) == WAIT_OBJECT_0) break;
    if (cancelRequested->load() || std::chrono::steady_clock::now() >= deadline) {
      const bool cancelled = cancelRequested->load();
      ::TerminateProcess(process.hProcess, 1);
      ::WaitForSingleObject(process.hProcess, 5000);
      outcome.cancelled = cancelled;
      outcome.timedOut = !cancelled;
      break;
    }
  }
  DWORD exitCode = 1;
  ::GetExitCodeProcess(process.hProcess, &exitCode);
  outcome.exitCode = static_cast<int>(exitCode);
  // Same attribution rule as POSIX: a non-zero exit after a cancel request IS the cancel.
  if (!outcome.timedOut && !outcome.cancelled)
    outcome.cancelled = cancelRequested->load() && outcome.exitCode != 0;
  pgidSlot->store(0);
  ::CloseHandle(process.hProcess);
  return outcome;
}

#endif  // _WIN32

// Exit code → node error code. The lead-verified spectrum is 0/1/2/3/5/6/64: 1 (output frame
// write failure) and 64 (caller error) are the runner failing, never the user's script, so
// they map to internalError and carry stderr as the detail.
const char* scriptErrorCodeForExit(int exitCode) {
  switch (exitCode) {
    case kRunnerExitScriptError: return "scriptError";
    case kRunnerExitOutput: return "invalidOutput";
    case kRunnerExitRuntimeMissing: return "runtimeMissing";
    case kRunnerExitSyntax: return "syntaxError";
    default: return "internalError";
  }
}

// Error detail shared by every failing exit: the code decides the sentence, the stderr tail
// explains it ("stderr 一律进错误详情字段").
Json scriptErrorParams(int exitCode, const std::string& stderrTail) {
  Json params = Json::object();
  params.set("exitCode", Json(static_cast<int64_t>(exitCode)));
  if (!stderrTail.empty()) params.set("stderr", Json(stderrTail));
  const Json structured = firstStderrJson(stderrTail);
  if (structured.isObject()) {
    // Protocol convention: the offending name travels as `name`.
    if (const Json* output = structured.find("output");
        output != nullptr && output->isString())
      params.set("name", *output);
    for (const char* key : {"reason", "line", "col", "msg", "error"}) {
      const Json* value = structured.find(key);
      if (value != nullptr && (value->isString() || value->isNumber())) params.set(key, *value);
    }
  }
  return params;
}

}  // namespace

// Declared in nodes.h: /api/script/check resolves the interpreter with this same rule.
// DC_PYRUNTIME wins outright — a broken override is reported, never silently replaced by the
// checkout's copy — else <repo>/third_party/pyruntime.
PythonRuntime resolvePythonRuntime(std::string* howMissing) {
  PythonRuntime runtime;
  const char* override = std::getenv("DC_PYRUNTIME");
  if (override != nullptr && override[0] != '\0') {
    runtime.dir = std::filesystem::path(override);
  } else {
    const std::string repo = findRepoRoot();
    if (repo.empty()) {
      *howMissing =
          "not running out of a source checkout (no backend/runner/runner.py above the "
          "working directory) and DC_PYRUNTIME is unset";
      return runtime;
    }
    runtime.dir = std::filesystem::path(repo) / "third_party" / "pyruntime";
  }
  std::error_code ec;
  // The path is used after the child chdir()ed into the scratch directory, so a relative
  // DC_PYRUNTIME must be resolved against the caller's cwd now, not there.
  runtime.dir = std::filesystem::absolute(runtime.dir, ec);
  if (ec) {
    *howMissing = "cannot resolve the runtime path " + runtime.dir.string();
    runtime.python.clear();
    return runtime;
  }
#ifdef _WIN32
  const char* kPythonExecutable = "python.exe";
#else
  const char* kPythonExecutable = "python3";
#endif
  runtime.python = runtime.dir / "bin" / kPythonExecutable;
  if (!std::filesystem::is_regular_file(runtime.python, ec)) {
    *howMissing = "no interpreter at " + runtime.python.string();
    runtime.python.clear();
  }
  return runtime;
}

NodeRegistry::ScriptCardOutcome NodeRegistry::runScriptCard(
    int64_t nodeId, const Json& params, const std::vector<PortBinding>& bindings,
    const std::vector<PortSlice>& slices, const std::vector<std::string>& names,
    const std::vector<std::vector<double>>& data) {
  ScriptCardOutcome outcome;
  const std::string badParam = validatePythonParams(params, bindings.size());
  if (!badParam.empty()) {
    outcome.errorCode = "invalidParams";
    outcome.errorParams = Json::object({{"name", Json(badParam)}});
    return outcome;
  }
  const Json& script = *params.find("script");
  const Json& portNames = *params.find("portNames");
  const Json& outputs = *params.find("outputs");
  int64_t timeoutMs = kDefaultScriptTimeoutMs;
  if (const Json* timeout = params.find("timeout_ms"))
    timeoutMs = static_cast<int64_t>(timeout->asNumber());

  const std::string repo = findRepoRoot();
  std::string runtimeNote;
  const PythonRuntime runtime = resolvePythonRuntime(&runtimeNote);
  if (runtime.python.empty() || repo.empty()) {
    outcome.errorCode = "runtimeMissing";
    outcome.errorParams = Json::object(
        {{"detail", Json(runtime.python.empty()
                             ? runtimeNote
                             : std::string("no backend/runner/runner.py above the working "
                                           "directory; not a source checkout"))}});
    return outcome;
  }
  ScriptPaths paths;
  paths.python = runtime.python;
  paths.runner = std::filesystem::path(repo) / "backend" / "runner" / "runner.py";
  paths.pylib = std::filesystem::path(repo) / "third_party" / "pylib";
  std::error_code ec;
  if (!std::filesystem::is_regular_file(paths.runner, ec)) {
    outcome.errorCode = "runtimeMissing";
    outcome.errorParams = Json::object({{"detail", Json("missing " + paths.runner.string())}});
    return outcome;
  }
  if (!makeTempDir(&paths.tmp)) {
    outcome.errorCode = "internalError";
    outcome.errorParams = Json::object({{"detail", Json("cannot create a scratch directory")}});
    return outcome;
  }
  TempDirGuard scratch{paths.tmp};
  paths.in = paths.tmp / "in";
  paths.out = paths.tmp / "out.dcm2";
  paths.meta = paths.tmp / "meta.json";

  // ── input frames: one DCM2 frame per bound port, written with the SHARED encoder ──
  Json ports = Json::array();
  for (size_t k = 0; k < bindings.size(); ++k) {
    if (k >= slices.size() || k >= portNames.items().size()) {
      outcome.errorCode = "internalError";
      outcome.errorParams =
          Json::object({{"detail", Json("input port bookkeeping mismatch")}});
      return outcome;
    }
    const PortSlice& slice = slices[k];
    std::vector<std::vector<double>> columns;
    std::vector<std::string> labels;
    size_t rows = 0;  // per port: two ports are two independent matrices
    for (size_t j = 0; j < slice.columnCount; ++j) {
      columns.push_back(data[slice.firstColumn + j]);
      labels.push_back(names[slice.firstColumn + j]);
      rows = std::max(rows, columns.back().size());
    }
    const std::string frameName = "port" + std::to_string(k) + ".dcm2";
    if (!writeFileBytes(paths.in / frameName,
                        encodeDcm2Frame(columns, labels, rows, rows, columns.size()))) {
      outcome.errorCode = "internalError";
      outcome.errorParams = Json::object({{"detail", Json("cannot write " + frameName)}});
      return outcome;
    }
    ports.push(Json::object({{"port", Json(portNames.items()[k].asString())},
                             {"frame", Json(frameName)}}));
  }
  if (!writeFileBytes(paths.in / "ports.json", ports.dump())) {
    outcome.errorCode = "internalError";
    outcome.errorParams = Json::object({{"detail", Json("cannot write ports.json")}});
    return outcome;
  }
  // The script travels inside meta.json (the runner's interface); it is a file, not an argv
  // element, so no quoting or length limit can corrupt it.
  const Json meta = Json::object({{"script", script},
                                  {"outputs", outputs},
                                  {"timeout_ms", Json(timeoutMs)}});
  if (!writeFileBytes(paths.meta, meta.dump())) {
    outcome.errorCode = "internalError";
    outcome.errorParams = Json::object({{"detail", Json("cannot write meta.json")}});
    return outcome;
  }

  // ── run: registered while it executes so /cancel can signal the process group ──
  auto run = std::make_shared<PythonRun>();
  {
    std::lock_guard<std::mutex> lock(mu_);
    runningPython_[nodeId] = run;
  }
  const ProcessOutcome process =
      runPythonChild(paths, timeoutMs, &run->cancelRequested, &run->pgid);
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = runningPython_.find(nodeId);
    if (it != runningPython_.end() && it->second == run) runningPython_.erase(it);
  }

  if (!process.launched) {
    outcome.errorCode = "internalError";
    outcome.errorParams = Json::object(
        {{"detail", Json(process.launchError.empty() ? std::string("the interpreter did not start")
                                                     : process.launchError)}});
    return outcome;
  }
  const std::string stderrTail = readFileTail(paths.tmp / "stderr.log", kScriptStderrTailBytes);
  if (process.cancelled) {
    // /cancel killed the group. The node goes back to "not computed yet" (see the commit
    // phase): a user stopping a run is not a failed script.
    outcome.errorCode = "runCancelled";
    return outcome;
  }
  if (process.timedOut) {
    outcome.errorCode = "scriptTimeout";
    outcome.errorParams = Json::object({{"timeout_ms", Json(timeoutMs)}});
    if (!stderrTail.empty()) outcome.errorParams.set("stderr", Json(stderrTail));
    return outcome;
  }
  if (process.exitCode != 0) {
    outcome.errorCode = scriptErrorCodeForExit(process.exitCode);
    outcome.errorParams = scriptErrorParams(process.exitCode, stderrTail);
    return outcome;
  }

  // ── success: output 0 is the display matrix, the rest are the declared extra outputs ──
  std::string decodeError;
  if (!readDcm2FrameFile(paths.out.string(), &outcome.primary, &decodeError)) {
    outcome.errorCode = "internalError";
    outcome.errorParams =
        Json::object({{"detail", Json("cannot read out.dcm2: " + decodeError)}});
    return outcome;
  }
  std::string manifestText;
  if (!readFileBytes(paths.tmp / "out.manifest.json", &manifestText)) {
    outcome.errorCode = "internalError";
    outcome.errorParams = Json::object({{"detail", Json("the runner wrote no manifest")}});
    return outcome;
  }
  Json manifest;
  std::string manifestError;
  if (!Json::parse(manifestText, &manifest, &manifestError) || !manifest.isArray()) {
    outcome.errorCode = "internalError";
    outcome.errorParams =
        Json::object({{"detail", Json("bad manifest: " + manifestError)}});
    return outcome;
  }
  // K is fixed by the declaration: a run fills the declared outputs, it never changes how
  // many there are (decision §三).
  if (manifest.items().size() != outputs.items().size()) {
    outcome.errorCode = "internalError";
    outcome.errorParams =
        Json::object({{"expected", Json(static_cast<int64_t>(outputs.items().size()))},
                      {"got", Json(static_cast<int64_t>(manifest.items().size()))}});
    return outcome;
  }
  for (size_t i = 1; i < manifest.items().size(); ++i) {
    const Json& entry = manifest.items()[i];
    const std::string frameName = entry["frame"].isString() ? entry["frame"].asString() : "";
    const std::string declaredName = entry["name"].isString() ? entry["name"].asString() : "";
    if (frameName.empty() || declaredName.empty()) {
      outcome.errorCode = "internalError";
      outcome.errorParams =
          Json::object({{"detail", Json("manifest entry without name/frame")}});
      return outcome;
    }
    std::vector<Column> columns;
    if (!readDcm2FrameFile((paths.tmp / frameName).string(), &columns, &decodeError)) {
      outcome.errorCode = "internalError";
      outcome.errorParams =
          Json::object({{"detail", Json("cannot read " + frameName + ": " + decodeError)}});
      return outcome;
    }
    outcome.extras.emplace_back(declaredName, std::move(columns));
  }
  return outcome;
}

bool NodeRegistry::cancelRun(int64_t nodeId) {
  std::shared_ptr<PythonRun> run;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = runningPython_.find(nodeId);
    if (it == runningPython_.end()) return false;
    run = it->second;
  }
  // The waiter polls the same flag, so a kill that loses this race still ends the run; the
  // direct signal is what makes /cancel immediate instead of "within one poll interval".
  run->cancelRequested.store(true);
  const int64_t pgid = run->pgid.load();
#ifndef _WIN32
  if (pgid > 1) ::kill(static_cast<pid_t>(-pgid), SIGKILL);
#endif
  (void)pgid;
  return true;
}

// Reconcile the card's extra output matrices with one successful run. REQUIRES mu_.
// The ids are allocated at creation so they stay stable; this fills them and handles the one
// case that can change the count — a params edit, which is still a declaration change and
// never data.
void NodeRegistry::syncExtraOutputsLocked(
    ComputeNode& node,
    const std::vector<std::pair<std::string, std::vector<Column>>>& extras) {
  const std::vector<Json> existing = node.extraOutputs.items();
  Json list = Json::array();
  for (size_t i = 0; i < extras.size(); ++i) {
    int64_t matrixId = -1;
    if (i < existing.size() && existing[i]["matrixId"].isNumber())
      matrixId = static_cast<int64_t>(existing[i]["matrixId"].asNumber());
    bool reused = false;
    if (matrixId >= 0) {
      reused = store_->replace(matrixId, extras[i].second);
      if (!reused) matrixId = -1;
    }
    if (matrixId < 0) {
      matrixId = store_->insert(Matrix(extras[i].second));
      resultOwner_[matrixKey(matrixId)] = {node.id, static_cast<int32_t>(i + 1)};
    }
    const size_t rows = extras[i].second.empty() ? 0 : extras[i].second.front().data.size();
    list.push(Json::object({{"name", Json(extras[i].first)},
                            {"matrixId", Json(matrixId)},
                            {"rows", Json(static_cast<int64_t>(rows))},
                            {"cols", Json(static_cast<int64_t>(extras[i].second.size()))}}));
  }
  // Surplus matrices (the declaration shrank): release them instead of leaking a result.
  for (size_t i = extras.size(); i < existing.size(); ++i) {
    if (!existing[i]["matrixId"].isNumber()) continue;
    const int64_t matrixId = static_cast<int64_t>(existing[i]["matrixId"].asNumber());
    resultOwner_.erase(matrixKey(matrixId));
    store_->remove(matrixId);
  }
  node.extraOutputs = std::move(list);
}

void NodeRegistry::clearExtraOutputsLocked(ComputeNode& node) {
  if (node.extraOutputs.items().empty()) return;
  // Keep the declared names and matrix ids (the client may still point at them) but drop the
  // numbers AND the recorded shape: a stale "rows: 3, cols: 2" next to an empty matrix is the
  // same lie as a stale result.
  Json blank = Json::array();
  for (const Json& extra : node.extraOutputs.items()) {
    const int64_t matrixId =
        extra["matrixId"].isNumber() ? static_cast<int64_t>(extra["matrixId"].asNumber()) : -1;
    if (matrixId >= 0) store_->replace(matrixId, {});
    blank.push(Json::object(
        {{"name", Json(extra["name"].isString() ? extra["name"].asString() : std::string())},
         {"matrixId", Json(matrixId)},
         {"rows", Json(static_cast<int64_t>(0))},
         {"cols", Json(static_cast<int64_t>(0))}}));
  }
  node.extraOutputs = std::move(blank);
}

void NodeRegistry::failNodeLocked(int64_t nodeId, const std::string& code, Json params) {
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return;
  ComputeNode& node = it->second;
  node.state = NodeState::Error;
  node.dirtyReason = DirtyReason::None;
  node.errorCode = code;
  node.errorParams = std::move(params);
  // Drop the previous results: an erroring node must not keep serving the numbers from
  // its last successful run (audit finding: downstream cards read stale values and
  // still displayed state "done"). Script-card extra outputs are results too.
  for (int64_t resultId : node.resultMatrixIds) store_->replace(resultId, {});
  clearExtraOutputsLocked(node);
  bus_->publish(Json::object({{"nodeId", Json(static_cast<int64_t>(node.id))},
                              {"state", Json(std::string("error"))},
                              {"code", Json(node.errorCode)},
                              {"params", node.errorParams}}));
}

void NodeRegistry::evaluateNode(int64_t nodeId) {
  // ── phase 1 (locked, short): publish `computing` and copy the evaluation request ──
  std::vector<PortBinding> bindings;
  std::string formula;
  std::string signatureId;
  Json params = Json::object();
  uint64_t definitionVersion = 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return;
    it->second.state = NodeState::Computing;
    bus_->publish(Json::object({{"nodeId", Json(nodeId)},
                                {"state", Json(std::string("computing"))}}));
    bindings = it->second.inputs;
    formula = it->second.formula;
    signatureId = it->second.signatureId;
    params = it->second.params;
    definitionVersion = it->second.definitionVersion;
  }

  // ── phase 2 (unlocked): resolve inputs; the store has its own mutex ──
  std::vector<std::string> names;
  std::vector<std::vector<double>> data;
  size_t length = 0;
  std::string gatherCode;
  std::string gatherName;
  std::vector<PortSlice> slices;
  if (!gatherInputs(bindings, &names, &data, &length, &slices, &gatherCode, &gatherName)) {
    std::lock_guard<std::mutex> lock(mu_);
    failNodeLocked(nodeId, gatherCode, Json::object({{"name", Json(gatherName)}}));
    return;
  }

  // ── phase 3 (unlocked): evaluate. NOTHING here holds mu_. ──
  // One `vector<Column>` per declared output ordinal. K is fixed by the signature; the
  // evaluator only decides what goes *inside* each output, never how many there are.
  std::vector<std::vector<Column>> outputs;
  std::string errorCode;
  std::string errorName;
  int64_t errorPosition = -1;
  // `unexpectedChar` and friends name the offending thing in their message; the UI localises
  // the message from `code` + `params`, so the value itself has to travel separately.
  std::string errorDetail;
  int64_t errorArgMin = -1;
  int64_t errorArgMax = -1;
  int64_t errorArgGot = -1;
  // Script cards (builtin:python) carry their own structured detail (stderr tail, exit code,
  // parsed manifest fields) and their declared outputs beyond output 0.
  Json scriptErrorDetail = Json::object();
  // builtin:unit-convert reports which column/unit failed; the sentence is built client-side
  // from `code` + these fields, so they must not be lost in the error path.
  Json unitConvertDetail = Json::object();
  std::vector<std::pair<std::string, std::vector<Column>>> scriptExtras;
  bool cancelled = false;

  // Qualified column references for a multi-input card: `A.pos.1`, `B.温度`,
  // `A.[地面速度_μm/s]`. The letter follows the port declaration order (A, B, C …) and the
  // port id also works (`src.pos.1`), so either spelling the input zone shows resolves.
  std::vector<AliasRange> aliases;
  {
    int ordinal = 0;
    for (size_t k = 0; k < bindings.size() && k < slices.size(); ++k) {
      AliasRange range;
      range.first = slices[k].firstColumn;
      range.count = slices[k].columnCount;
      if (ordinal < 26) {
        range.alias = std::string(1, static_cast<char>('A' + ordinal));
        aliases.push_back(range);
      }
      if (!bindings[k].varName.empty()) {
        range.alias = bindings[k].varName;
        aliases.push_back(range);
      }
      ++ordinal;
    }
  }
  const size_t rowLength = length == 0 ? 1 : length;
  try {
    if (!signatureId.empty()) {
      if (signatureId == kSigLinearRegression) {
        // Least squares over the two declared ports, mirroring web/src/core/stats.ts
        // `linearRegression` (the reference the charts already use): non-finite pairs are
        // dropped, n < 2 or zero x-variance yields NaN statistics rather than a made-up
        // line — NaN is this project's word for "undefined", never 0.
        // Each port must carry exactly ONE column: the signature declares a column, not a
        // table, so a multi-column binding is a shape mismatch, not "use the first one".
        const bool shapesOk = slices.size() >= 2 && slices[0].columnCount == 1 &&
                              slices[1].columnCount == 1;
        if (!shapesOk) {
          errorCode = "shapeMismatch";
          errorName = "x/y";
        } else {
          const auto& xs = data[slices[0].firstColumn];
          const auto& ys = data[slices[1].firstColumn];
          const size_t n = std::min(xs.size(), ys.size());
          std::vector<double> xv;
          std::vector<double> yv;
          for (size_t i = 0; i < n; ++i) {
            if (std::isfinite(xs[i]) && std::isfinite(ys[i])) {
              xv.push_back(xs[i]);
              yv.push_back(ys[i]);
            }
          }
          const size_t count = xv.size();
          double slope = NAN;
          double intercept = NAN;
          double correlation = NAN;
          double r2 = NAN;
          if (count >= 2) {
            double sx = 0;
            double sy = 0;
            for (size_t i = 0; i < count; ++i) {
              sx += xv[i];
              sy += yv[i];
            }
            const double mx = sx / static_cast<double>(count);
            const double my = sy / static_cast<double>(count);
            double sxx = 0;
            double sxy = 0;
            double syy = 0;
            for (size_t i = 0; i < count; ++i) {
              const double dx = xv[i] - mx;
              const double dy = yv[i] - my;
              sxx += dx * dx;
              sxy += dx * dy;
              syy += dy * dy;
            }
            if (sxx > 0) {
              slope = sxy / sxx;
              intercept = my - slope * mx;
              correlation = syy > 0 ? sxy / std::sqrt(sxx * syy) : 0.0;
              r2 = correlation * correlation;
            }
          }
          // One row, five named columns: the output's height is fixed by the signature.
          const char* statNames[5] = {"slope", "intercept", "r", "r2", "n"};
          const double values[5] = {slope, intercept, correlation, r2,
                                    static_cast<double>(count)};
          std::vector<Column> columns;
          for (int i = 0; i < 5; ++i) {
            Column column;
            column.posName = "Pos." + std::to_string(i + 1);
            column.annotation = statNames[i];
            column.data = {values[i]};
            columns.push_back(std::move(column));
          }
          outputs.push_back(std::move(columns));
        }
      } else if (signatureId == kSigExpressionColumns) {
        // builtin:expression-columns — one wide table, one column per expression. This is
        // the v1 formula card's semantics, now computed once in one node instead of once
        // per column in N nodes (the browser-side merge disappears with it).
        std::vector<Column> columns;
        const Json* formulas = params.find("formulas");
        if (!formulas || !formulas->isArray() || formulas->items().empty()) {
          errorCode = "badSignatureParams";
          errorName = "formulas";
        } else {
          const auto& list = formulas->items();
          for (size_t i = 0; i < list.size(); ++i) {
            const Json& f = list[i];
            const std::string expression = f["expression"].isString() ? f["expression"].asString() : "";
            std::string name = f["name"].isString() ? f["name"].asString() : "";
            if (name.empty()) name = "Col" + std::to_string(i + 1);
            Column col;
            col.posName = "Pos." + std::to_string(i + 1);
            col.annotation = name;
            col.data = ExprEngine::evaluate(expression, names, data, rowLength, aliases);
            columns.push_back(std::move(col));
          }
        }
        if (errorCode.empty()) outputs.push_back(std::move(columns));
      } else if (signatureId == kSigSummary) {
        // builtin:summary — rows = the statistic catalog (signature.h), columns = the
        // input variables. The maths all lives in the expression engine (summary.cpp only
        // maps catalog ids to expressions), so there is exactly ONE definition of "sample
        // standard deviation" in the process.
        //
        // `slices[0]` is the port's column range. Column labels arrive flattened
        // ("Pos.1 A"), so they are split again: the output column inherits the source
        // column's posName+annotation verbatim. That is what keeps an un-annotated column
        // named "Pos.7" instead of inventing "A" / "AB" — invented labels run out of
        // meaning long before they run out of letters.
        std::vector<Column> inputColumns;
        if (!slices.empty()) {
          const PortSlice& slice = slices[0];
          for (size_t i = 0; i < slice.columnCount; ++i) {
            Column source;
            Matrix::labelParsed(names[slice.firstColumn + i], &source.posName,
                                &source.annotation);
            source.data = data[slice.firstColumn + i];
            inputColumns.push_back(std::move(source));
          }
        }
        SummaryResult table = evaluateSummary(inputColumns, params);
        if (!table.errorCode.empty()) {
          errorCode = table.errorCode;
          errorName = table.errorName;
        } else {
          outputs.push_back(std::move(table.columns));
        }
      } else if (signatureId == kSigUnitConvert) {
        // builtin:unit-convert — the whole input table with the targeted columns converted
        // (units.cpp). Columns nobody asked about pass through verbatim, so an unconfirmed
        // header (`temp_c`) survives a card that does not touch it.
        //
        // The column labels arrive flattened ("Pos.1 pressure_kpa"), so they are split again:
        // the unit resolver reads the annotation and the annotation rewrite splices the same
        // string, which is why the output column can be renamed without a label channel.
        std::vector<Column> inputColumns;
        if (!slices.empty()) {
          const PortSlice& slice = slices[0];
          for (size_t i = 0; i < slice.columnCount; ++i) {
            Column source;
            Matrix::labelParsed(names[slice.firstColumn + i], &source.posName,
                                &source.annotation);
            source.data = data[slice.firstColumn + i];
            inputColumns.push_back(std::move(source));
          }
        }
        UnitConvertResult converted = evaluateUnitConvert(inputColumns, params);
        if (!converted.errorCode.empty()) {
          errorCode = converted.errorCode;
          // Structured params travel in the same channel the summary/script errors use:
          // the UI localises `code` + these fields into a sentence.
          unitConvertDetail = std::move(converted.errorParams);
        } else {
          outputs.push_back(std::move(converted.columns));
        }
      } else if (signatureId == kSigPython) {
        // builtin:python — the script card. The interpreter runs OUTSIDE the registry lock
        // (runScriptCard registers itself so POST /api/nodes/{id}/cancel can kill its
        // process group). Params are re-validated there: a PATCH can replace them without
        // passing through creation.
        ScriptCardOutcome script = runScriptCard(nodeId, params, bindings, slices, names, data);
        if (script.errorCode.empty()) {
          outputs.push_back(std::move(script.primary));
          scriptExtras = std::move(script.extras);
        } else if (script.errorCode == "runCancelled") {
          // /cancel: the user stopped the run. Handled in the commit phase (back to
          // "not computed yet" — stopping is not a script failure).
          cancelled = true;
        } else {
          errorCode = script.errorCode;
          scriptErrorDetail = std::move(script.errorParams);
        }
      } else {
        errorCode = "unknownSignature";
        errorName = signatureId;
      }
    } else {
      std::vector<double> values = ExprEngine::evaluate(formula, names, data, rowLength, aliases);
      Column out;
      out.posName = "Pos.1";
      out.annotation = "";
      out.data = std::move(values);
      outputs.push_back({std::move(out)});
    }
  } catch (const ExpressionError& e) {
    errorCode = e.code;
    errorPosition = e.position;
    errorDetail = e.detail;
    errorArgMin = e.argMin;
    errorArgMax = e.argMax;
    errorArgGot = e.argGot;
  } catch (const ShapeError& e) {
    // Matrix-mode shape failures are structured too (never a silent garbage matrix).
    errorCode = e.code;
    errorName = e.what();
  } catch (const std::exception&) {
    errorCode = "internalError";
  }

  // ── phase 3b (unlocked): column contract ──
  // The output list of a function card may carry a promised column count
  // (`params.columnContract`), set when the user first names the output's columns. It is
  // an explicit contract, not a shape heuristic: when the produced width drifts, the data
  // flow STOPS HERE with a structured error instead of silently re-labelling columns.
  // K (the number of outputs) is still fixed by the signature; this is about the width of
  // one output table.
  int64_t contractExpected = -1;
  int64_t contractActual = -1;
  if (errorCode.empty()) {
    const Json* contract = params.find("columnContract");
    if (contract && contract->isObject() && (*contract)["columns"].isNumber()) {
      contractExpected = static_cast<int64_t>((*contract)["columns"].asNumber());
      contractActual = outputs.empty() ? 0 : static_cast<int64_t>(outputs[0].size());
      if (contractExpected != contractActual) {
        errorCode = "columnContractViolation";
        errorName.clear();
      }
    }
  }

  // ── phase 4 (locked, short): commit ──
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return;  // deleted while computing
  ComputeNode& node = it->second;
  if (node.definitionVersion != definitionVersion) {
    // The definition changed while we were computing: do not publish numbers that no
    // longer describe this node. Leave it dirty so the update's own recompute runs.
    node.state = NodeState::Dirty;
    node.dirtyReason = DirtyReason::DefinitionChanged;
    bus_->publish(Json::object({{"nodeId", Json(nodeId)},
                                {"state", Json(std::string("dirty"))}}));
    return;
  }
  if (cancelled) {
    // POST /api/nodes/{id}/cancel killed the process group. The card holds no numbers and
    // none are expected: "not requested yet" is the honest state, and a red card would
    // claim the script failed when the user simply stopped it.
    markStaleLocked(nodeId, DirtyReason::NotRequested);
    return;
  }
  if (!errorCode.empty()) {
    Json params_out = Json::object();
    if (errorPosition >= 0) params_out.set("position", Json(errorPosition));
    // Structured identity of the offending token: the UI localises the sentence from
    // `code` + these params, so without them a Chinese UI printed a literal "{char}"
    // (or "{name}") at the user. Key names mirror the TS reference engine's params.
    if (!errorDetail.empty()) {
      if (errorCode == "unexpectedChar") {
        params_out.set("char", Json(errorDetail));
      } else if (errorCode == "unexpectedToken" || errorCode == "trailingToken") {
        params_out.set("token", Json(errorDetail));
      } else {
        params_out.set("name", Json(errorDetail));
      }
    }
    if (errorArgMin >= 0) {
      const bool variadic = errorArgMax == INT32_MAX;
      params_out.set("min", Json(errorArgMin));
      params_out.set("max", Json(variadic ? Json(std::string("∞")) : Json(errorArgMax)));
      // `expected` is what the message interpolates; a range keeps its range.
      if (variadic) {
        params_out.set("expected", Json(std::to_string(errorArgMin) + "–∞"));
      } else if (errorArgMin == errorArgMax) {
        params_out.set("expected", Json(errorArgMin));
      } else {
        params_out.set("expected",
                       Json(std::to_string(errorArgMin) + "–" + std::to_string(errorArgMax)));
      }
      params_out.set("got", Json(errorArgGot));
    }
    if (!errorName.empty()) params_out.set("name", Json(errorName));
    if (contractExpected >= 0) {
      params_out.set("expected", Json(contractExpected));
      params_out.set("actual", Json(contractActual));
    }
    // Script-card detail (stderr tail, runner exit code, the manifest fields the runner
    // named). It carries the sentence a user reads, so the client never has to invent one.
    if (scriptErrorDetail.isObject()) {
      for (const auto& member : scriptErrorDetail.members())
        params_out.set(member.first, member.second);
    }
    if (unitConvertDetail.isObject()) {
      for (const auto& member : unitConvertDetail.members())
        params_out.set(member.first, member.second);
    }
    failNodeLocked(nodeId, errorCode, std::move(params_out));
    return;
  }
  // The signature promised K outputs; a short fill is a structured error, never UB
  // (port-semantics-v1 §evaluation: "少填 = 结构化错误").
  if (outputs.size() != node.resultMatrixIds.size()) {
    failNodeLocked(nodeId, "internalError",
                   Json::object({{"expected", Json(static_cast<int64_t>(node.resultMatrixIds.size()))},
                                 {"got", Json(static_cast<int64_t>(outputs.size()))}}));
    return;
  }
  for (size_t i = 0; i < outputs.size(); ++i)
    store_->replace(node.resultMatrixIds[i], std::move(outputs[i]));
  // The declared outputs beyond 0 (script cards only): same commit, separate store slot.
  if (signatureId == kSigPython) syncExtraOutputsLocked(node, scriptExtras);
  node.state = NodeState::Done;
  node.dirtyReason = DirtyReason::None;
  node.errorCode.clear();
  Json done = Json::object({{"nodeId", Json(nodeId)},
                            {"state", Json(std::string("done"))},
                            {"matrixId", Json(node.resultMatrixIds[0])}});
  if (node.resultMatrixIds.size() > 1) {
    Json ids = Json::array();
    for (int64_t id : node.resultMatrixIds) ids.push(Json(id));
    done.set("resultMatrixIds", std::move(ids));
  }
  if (!node.extraOutputs.items().empty()) done.set("extraOutputs", node.extraOutputs);
  bus_->publish(std::move(done));
}

std::vector<int64_t> NodeRegistry::collectSubtree(int64_t nodeId, bool includeSelf) const {
  // BFS over `dependents_` (edges point source->dependent, so this order is already
  // dependency-first). The node's result matrices are mid-edges: whoever binds any of
  // them depends on this node — K outputs ⇒ K keys.
  std::vector<int64_t> order;
  std::lock_guard<std::mutex> lock(mu_);
  std::set<int64_t> visited;
  std::queue<int64_t> q;
  q.push(nodeId);
  while (!q.empty()) {
    int64_t cur = q.front();
    q.pop();
    if (!visited.insert(cur).second) continue;
    if (cur != nodeId || includeSelf) order.push_back(cur);
    auto it = dependents_.find(cur);
    if (it != dependents_.end())
      for (int64_t d : it->second) q.push(d);
    auto nit = nodes_.find(cur);
    if (nit != nodes_.end()) {
      for (int64_t resultId : nit->second.resultMatrixIds) {
        auto rit = dependents_.find(matrixKey(resultId));
        if (rit != dependents_.end())
          for (int64_t d : rit->second) q.push(d);
      }
      // Script-card extra outputs are bindable matrices too, so their dependents are part
      // of this node's subtree.
      for (const Json& extra : nit->second.extraOutputs.items()) {
        if (!extra["matrixId"].isNumber()) continue;
        auto rit = dependents_.find(matrixKey(static_cast<int64_t>(extra["matrixId"].asNumber())));
        if (rit != dependents_.end())
          for (int64_t d : rit->second) q.push(d);
      }
    }
  }
  return order;
}

void NodeRegistry::markStaleLocked(int64_t nodeId, DirtyReason reason) {
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return;
  ComputeNode& node = it->second;
  // A user-facing cause outranks an upstream event: "you never asked me to compute" and
  // "you just edited my parameters" stay true after some matrix upstream changed too, and
  // overwriting them would hide the action the user actually needs to take.
  const bool keepUserCause = node.state == NodeState::Dirty &&
                             (node.dirtyReason == DirtyReason::NotRequested ||
                              node.dirtyReason == DirtyReason::DefinitionChanged);
  if (!keepUserCause) node.dirtyReason = reason;
  const bool wasDirty = node.state == NodeState::Dirty;
  node.state = NodeState::Dirty;
  node.errorCode.clear();
  node.errorParams = Json::object();
  // Drop the previous numbers. "dirty" must mean "the values stored here do not describe
  // the current inputs" — the same rule the error path already enforces, for the same
  // audit finding (downstream cards reading stale numbers while showing a live state).
  bool hadNumbers = false;
  for (int64_t resultId : node.resultMatrixIds) {
    Matrix existing;
    if (store_->snapshot(resultId, &existing) && existing.columnCount() > 0) hadNumbers = true;
    store_->replace(resultId, {});
  }
  clearExtraOutputsLocked(node);
  if (!wasDirty || hadNumbers) {
    Json event = Json::object({{"nodeId", Json(nodeId)},
                               {"state", Json(std::string("dirty"))},
                               {"reason", Json(std::string(dirtyReasonName(node.dirtyReason)))}});
    bus_->publish(std::move(event));
  }
}

void NodeRegistry::evaluateInOrder(const std::vector<int64_t>& order) {
  // Nodes whose upstream is pending are marked, not evaluated: their input is not broken,
  // it is simply not computed yet, and reporting a data error for that would be a lie the
  // user cannot act on.
  std::set<int64_t> blocked;
  for (int64_t id : order) {
    if (blocked.count(id)) {
      std::lock_guard<std::mutex> lock(mu_);
      markStaleLocked(id, DirtyReason::UpstreamChanged);
      continue;
    }
    bool lazy = false;
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = nodes_.find(id);
      if (it == nodes_.end()) continue;
      lazy = wantsExplicitCompute(it->second);
    }
    if (lazy) {
      {
        std::lock_guard<std::mutex> lock(mu_);
        markStaleLocked(id, DirtyReason::UpstreamChanged);
      }
      for (int64_t dependent : collectSubtree(id, false)) blocked.insert(dependent);
      continue;
    }
    evaluateNode(id);
  }
}

void NodeRegistry::recomputeSubtree(int64_t nodeId) {
  // The loop holds no lock: evaluateNode() takes it in short bursts itself, so a slow node
  // cannot freeze the registry (docs/decisions/2026-10-15-max-headroom-principle.md).
  evaluateInOrder(collectSubtree(nodeId, true));
}

void NodeRegistry::computeNow(int64_t nodeId) {
  // An explicit request erases the "not requested" marker; the evaluation itself runs the
  // usual phases (computing → done/error) under the usual definition-version guard.
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return;
    it->second.dirtyReason = DirtyReason::None;
  }
  evaluateNode(nodeId);
  evaluateInOrder(collectSubtree(nodeId, false));
}

void NodeRegistry::onMatrixChanged(int64_t matrixId) {
  std::vector<int64_t> direct;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = dependents_.find(matrixKey(matrixId));
    if (it == dependents_.end()) return;
    direct.assign(it->second.begin(), it->second.end());
  }
  for (int64_t id : direct) recomputeSubtree(id);
}

}  // namespace dc
