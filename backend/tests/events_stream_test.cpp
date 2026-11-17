// /api/events and the event stream behind it.
//
// The event log is the only channel that tells the browser a card changed state, and since
// 2026-11-17 the front end also decides *automatic runs* from its `dirty` events. That makes
// two properties load-bearing and neither had a gate:
//
//   1. the sequence is a monotonic cursor — `since=<seq>` never replays an older event and
//      never drops a newer one, because a dropped terminal event leaves a card "computing"
//      forever;
//   2. a repeat of the same upstream change announces nothing the second time. A re-announced
//      dirty is what made the front end re-run an already-dirty card in a loop (the backend
//      pushed `dirty` on every pass; the fix was this dedupe plus a client-side filter). The
//      dedupe is asserted HERE, at the source, so the client-side filter is not the only
//      line of defence.
//
// Part A drives the registry + bus directly (no sockets) so the ordering claims are about
// the code that publishes, not about the transport. Part B then proves the HTTP route hands
// that same log to a client, in order, with `seq` attached.
//
// The log is bounded (4096) by design: this is a "what changed since my cursor" stream, not
// a durable queue — a client that has been away re-reads state from GET /api/nodes/{id}.
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "http_harness.h"

#include "http_server.h"
#include "json.h"
#include "matrix_store.h"
#include "nodes.h"

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

namespace {

using Events = std::vector<std::pair<int64_t, dc::Json>>;

std::string strField(const dc::Json& event, const char* key) {
  const dc::Json* field = event.find(key);
  return (field != nullptr && field->isString()) ? field->asString() : std::string();
}

double numField(const dc::Json& event, const char* key, double fallback) {
  const dc::Json* field = event.find(key);
  return (field != nullptr && field->isNumber()) ? field->asNumber() : fallback;
}

dc::PortBinding bindMatrix(int64_t matrixId, const char* port) {
  dc::PortBinding binding;
  binding.portId = port;
  binding.varName = port;
  binding.mode = "matrix";
  binding.sourceMatrixId = matrixId;
  return binding;
}

}  // namespace

int main() {
  if (!dctest::initSockets()) {
    std::printf("FAILED: events_stream (winsock init)\n");
    return 1;
  }
  dctest::ignoreSigpipe();

  // Leaked on purpose: part B's accept loop is a detached thread that may still be serving
  // when main() returns, so the objects it dereferences must outlive the stack frame.
  auto* store = new dc::MatrixStore();
  auto* bus = new dc::EventBus();
  auto* nodes = new dc::NodeRegistry(store, bus);

  dc::Column a;
  a.posName = "Pos.1";
  a.data = {1, 2, 3};
  const int64_t source = store->insert(dc::Matrix({a}));

  // ── A1. creation is not news; the first compute is ─────────────────────────
  const auto created = nodes->create({bindMatrix(source, "src")}, "Pos.1 * 2");
  CHECK(created.nodeId > 0);
  CHECK(bus->wait(0, 0).empty());

  nodes->recomputeSubtree(created.nodeId);
  const Events computed = bus->wait(0, 0);
  CHECK(computed.size() == 2);
  if (computed.size() == 2) {
    CHECK(strField(computed[0].second, "state") == "computing");
    CHECK(strField(computed[1].second, "state") == "done");
    CHECK(computed[0].first < computed[1].first);  // the cursor is strictly monotonic
    CHECK(numField(computed[1].second, "nodeId", -1) == static_cast<double>(created.nodeId));
    // `done` must name the slot the client will read: a state without a handle is a dead end.
    const auto node = nodes->get(created.nodeId);
    CHECK(node.has_value());
    if (node) {
      CHECK(numField(computed[1].second, "matrixId", -1) ==
            static_cast<double>(node->resultMatrixIds[0]));
    }
  }

  // ── A2. the cursor never replays: since=<last> is empty, since=0 is the log ─
  int64_t cursor = computed.empty() ? 0 : computed.back().first;
  CHECK(bus->wait(cursor, 10).empty());
  const Events all = bus->wait(0, 0);
  CHECK(all.size() == computed.size());  // a cursor filters; it does not mutate the log

  // ── A3. a lazy signature: an upstream change is announced ONCE ────────────
  dc::Column sa;
  sa.posName = "Pos.1";
  sa.data = {1, 2, 3, 4};
  const int64_t summarySource = store->insert(dc::Matrix({sa}));
  const auto summary = nodes->createV2("builtin:summary", {bindMatrix(summarySource, "src")},
                                       dc::Json::object());
  CHECK(summary.nodeId > 0);
  // Creation spends no compute (the signature is `explicitCompute`), so this pass only
  // settles the node; whatever it publishes, the count below is measured from `cursor`.
  nodes->recomputeSubtree(summary.nodeId);

  nodes->computeNow(summary.nodeId);
  const Events summaryRan = bus->wait(cursor, 0);
  CHECK(summaryRan.size() == 2);
  if (summaryRan.size() == 2) {
    CHECK(strField(summaryRan[0].second, "state") == "computing");
    CHECK(strField(summaryRan[1].second, "state") == "done");
    cursor = summaryRan[1].first;
  }

  {
    // The upstream change. A lazy card cannot refresh itself, so the honest announcement is
    // `dirty` + the reason — this is exactly the event the front end's auto-run keys on.
    std::vector<dc::CellPatch> patches = {{0, 0, 100.0}};
    int64_t revision = 0;
    CHECK(store->patchCells(summarySource, patches, &revision));
    nodes->onMatrixChanged(summarySource);
    const Events dirtied = bus->wait(cursor, 0);
    CHECK(dirtied.size() == 1);
    if (dirtied.size() == 1) {
      CHECK(strField(dirtied[0].second, "state") == "dirty");
      CHECK(strField(dirtied[0].second, "reason") == "upstreamChanged");
      CHECK(numField(dirtied[0].second, "nodeId", -1) == static_cast<double>(summary.nodeId));
      cursor = dirtied[0].first;
    }
  }

  {
    // The same upstream changed again while the card is already dirty with no numbers.
    // Announcing it again is what turned a suggestion into a loop; the second pass must be
    // silent. (The front end also filters, but a filter is not a contract.)
    std::vector<dc::CellPatch> patches = {{1, 0, 500.0}};  // {row, col, value}
    int64_t revision = 0;
    CHECK(store->patchCells(summarySource, patches, &revision));
    nodes->onMatrixChanged(summarySource);
    CHECK(bus->wait(cursor, 0).empty());
  }

  // ── A4. a failing compute still terminates the stream ─────────────────────
  {
    // "Pos.9" names a column this input does not have: a data error, i.e. the user can act
    // on it. The stream must end in `error` + a code, never stay at `computing`.
    const auto broken = nodes->create({bindMatrix(source, "src")}, "Pos.9");
    CHECK(broken.nodeId > 0);
    nodes->recomputeSubtree(broken.nodeId);
    const Events errored = bus->wait(cursor, 0);
    CHECK(errored.size() == 2);
    if (errored.size() == 2) {
      CHECK(strField(errored[0].second, "state") == "computing");
      CHECK(strField(errored[1].second, "state") == "error");
      CHECK(!strField(errored[1].second, "code").empty());
      CHECK(numField(errored[1].second, "nodeId", -1) == static_cast<double>(broken.nodeId));
      cursor = errored[1].first;
    }
  }

  // ── B. the route hands the same log to a client, in order ─────────────────

  const int port = dctest::pickEphemeralPort();
  if (port == 0) {
    std::printf("FAILED: events_stream (no free port)\n");
    return 1;
  }
  auto* server = new dc::HttpServer(port, store, nodes, bus);
  auto* bindFailed = new std::atomic<bool>(false);
  std::thread([server, bindFailed] {
    if (!server->serve()) bindFailed->store(true);
  }).detach();
  if (!dctest::waitForListen(port, *bindFailed)) {
    std::printf("FAILED: events_stream (could not listen on 127.0.0.1:%d)\n", port);
    return 1;
  }

  dctest::Response res;
  CHECK(dctest::sendRequest(
      port, dctest::buildRequest("GET", "/api/events?since=0&timeout=1", ""), &res));
  CHECK(res.status == 200);
  dc::Json payload;
  std::string parseError;
  CHECK(dc::Json::parse(res.body, &payload, &parseError));
  CHECK(payload.isArray());
  if (payload.isArray()) {
    CHECK(!payload.items().empty());
    int64_t previous = 0;
    bool ordered = true;
    for (const dc::Json& event : payload.items()) {
      const dc::Json* seq = event.find("seq");
      const dc::Json* nodeId = event.find("nodeId");
      CHECK(seq != nullptr && seq->isNumber());
      CHECK(nodeId != nullptr && nodeId->isNumber());
      if (seq != nullptr && seq->isNumber()) {
        if (seq->asNumber() <= static_cast<double>(previous)) ordered = false;
        previous = static_cast<int64_t>(seq->asNumber());
      }
    }
    CHECK(ordered);  // the array is the cursor's contract: sorted, strictly increasing
    CHECK(previous == cursor);  // the newest event the route has is the one the bus ended on
  }

  // A cursor at the head is an empty answer after the long-poll timeout — not a 404, not a
  // replay of the last event. This is the call the UI makes on every idle turn.
  {
    dctest::Response idle;
    const std::string path = "/api/events?since=" + std::to_string(cursor) + "&timeout=1";
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", path, ""), &idle));
    CHECK(idle.status == 200);
    dc::Json empty;
    CHECK(dc::Json::parse(idle.body, &empty, &parseError));
    CHECK(empty.isArray() && empty.items().empty());
  }

  std::printf("%s: events_stream (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
