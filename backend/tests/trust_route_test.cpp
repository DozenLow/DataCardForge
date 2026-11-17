// /api/trust: the ROUTE's contract.
//
// trust_store_test.cpp covers the record (atomic write, env binding, merge, cap) and
// TrustPanel.dom.test.tsx covers the panel against a mocked client. Between them sat the
// HTTP surface, which nothing executed: status codes, the "decide first" rule, the bad-hash
// shape, the verb allow-list, and whether a foreign Origin can read or write trust at all.
// Those are exactly the things a browser acts on, and they are decided in route(), not in
// the store.
//
// The server runs in-process on an ephemeral port (never 37811, where the installed service
// may already be listening) — same harness shape as origin_gate_test.cpp, through the real
// router, the real Origin gate and the one-send response writer.
//
// Cases, in the order a first run walks them:
//   1. a fresh record answers "undecided" and stores nothing yet;
//   2. POST /api/trust before that decision is refused with 409 persistenceUndecided — a
//      recorded hash would otherwise silently mean "session only";
//   3. deciding persistent flips the answer, then a hash round-trips: POST → GET → DELETE;
//   4. malformed input is stated as such (400 badHash, 400 unexpectedToken), and an unknown
//      verb is a 404 rather than a silent success;
//   5. a corrupt record makes the whole store unavailable and every write is refused —
//      "trust nothing" must not read as "nothing is trusted";
//   6. a backend without a store (trust == nullptr) answers 503, not an empty list.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "http_harness.h"

#include "http_server.h"
#include "json.h"
#include "matrix_store.h"
#include "nodes.h"
#include "trust_store.h"

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

namespace {

const char* kHashA =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const char* kHashB =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

void setEnv(const char* name, const char* value) {
#ifdef _WIN32
  _putenv_s(name, value);
#else
  setenv(name, value, 1);
#endif
}

/** A directory nobody else is using. Unique by clock, never by pid (pids get recycled). */
std::string uniqueDir(const char* prefix) {
  std::error_code ec;
  const auto base = std::filesystem::temp_directory_path(ec);
  const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto dir = base / (std::string(prefix) + std::to_string(ticks));
  std::filesystem::create_directories(dir, ec);
  return dir.string();
}

dc::Json parseBody(const std::string& body, bool* ok) {
  dc::Json parsed;
  std::string error;
  *ok = dc::Json::parse(body, &parsed, &error);
  return parsed;
}

/**
 * Starts a server on a free port. Everything it dereferences is leaked on purpose: the
 * detached accept loop answers until the process exits, so deleting the objects under it
 * would be a use-after-free on whatever connection is still in flight.
 */
struct Running {
  int port = 0;
  bool listening = false;
};

Running startServer(dc::TrustStore* trust) {
  Running running;
  running.port = dctest::pickEphemeralPort();
  if (running.port == 0) return running;
  auto* store = new dc::MatrixStore();
  auto* bus = new dc::EventBus();
  auto* nodes = new dc::NodeRegistry(store, bus);
  auto* server = new dc::HttpServer(running.port, store, nodes, bus, std::string(), trust);
  auto* bindFailed = new std::atomic<bool>(false);
  std::thread([server, bindFailed] {
    if (!server->serve()) bindFailed->store(true);
  }).detach();
  running.listening = dctest::waitForListen(running.port, *bindFailed);
  return running;
}

}  // namespace

int main() {
  if (!dctest::initSockets()) {
    std::printf("FAILED: trust_route (winsock init)\n");
    return 1;
  }
  dctest::ignoreSigpipe();

  const std::string frontend = "http://127.0.0.1:37811";
  const std::string foreign = "https://evil.example";

  // ── 1. a fresh record: undecided, nothing stored ───────────────────────────
  const std::string dir = uniqueDir("dc-trust-route-");
  setEnv("DC_TRUST_DIR", dir.c_str());

  auto* trust = new dc::TrustStore(std::string());
  const Running first = startServer(trust);
  if (!first.listening) {
    std::printf("FAILED: trust_route (could not listen on 127.0.0.1:%d)\n", first.port);
    return 1;
  }
  const int port = first.port;
  dctest::Response res;
  bool parsed = false;

  CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trust", ""), &res));
  CHECK(res.status == 200);
  dc::Json status = parseBody(res.body, &parsed);
  CHECK(parsed);
  CHECK(status.isObject());
  if (const dc::Json* field = status.find("persistence")) {
    CHECK(field->isString() && field->asString() == "undecided");
  } else {
    CHECK(false);
  }
  if (const dc::Json* field = status.find("entries")) {
    CHECK(field->isNumber() && field->asNumber() == 0);
  } else {
    CHECK(false);
  }
  // envId is the "another machine" seam: an opaque v1 tag, never empty.
  if (const dc::Json* field = status.find("envId")) {
    CHECK(field->isString());
    const std::string id = field->asString();
    CHECK(id.rfind("v1-", 0) == 0);
    CHECK(id.size() == 3 + 16);
  } else {
    CHECK(false);
  }
  // /status is the same snapshot, so a client can poll a stable name while empty means
  // "the collection root".
  CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trust/status", ""), &res));
  CHECK(res.status == 200);
  dc::Json status2 = parseBody(res.body, &parsed);
  CHECK(parsed && status2.isObject());
  if (const dc::Json* field = status2.find("persistence")) {
    CHECK(field->isString() && field->asString() == "undecided");
  } else {
    CHECK(false);
  }

  // ── 2. recording before the decision: 409, and nothing written ─────────────
  {
    const std::string body = dc::Json::object({{"hash", dc::Json(kHashA)}}).dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust", "", body), &res));
    CHECK(res.status == 409);
    CHECK(res.body.find("persistenceUndecided") != std::string::npos);
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trust", ""), &res));
    CHECK(res.status == 200);
    dc::Json stillEmpty = parseBody(res.body, &parsed);
    if (const dc::Json* field = stillEmpty.find("entries")) {
      CHECK(field->isNumber() && field->asNumber() == 0);
    } else {
      CHECK(false);
    }
  }

  // ── 3. decide, then a hash round-trips through POST → GET → DELETE ────────
  {
    const std::string body = dc::Json::object({{"persist", dc::Json(true)}}).dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust/persistence", "", body),
                              &res));
    CHECK(res.status == 200);
    dc::Json decided = parseBody(res.body, &parsed);
    CHECK(parsed);
    if (const dc::Json* field = decided.find("persistence")) {
      CHECK(field->isString() && field->asString() == "persistent");
    } else {
      CHECK(false);
    }
    if (const dc::Json* field = decided.find("location")) {
      CHECK(field->isString() && !field->asString().empty());
    } else {
      CHECK(false);
    }
  }
  {
    const std::string body =
        dc::Json::object({{"hash", dc::Json(kHashA)},
                          {"scripts", dc::Json::array({dc::Json("card-1"), dc::Json("card-2")})}})
            .dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust", "", body), &res));
    CHECK(res.status == 200);
    dc::Json recorded = parseBody(res.body, &parsed);
    CHECK(parsed);
    if (const dc::Json* scripts = recorded.find("scripts")) {
      CHECK(scripts->isArray() && scripts->items().size() == 2);
    } else {
      CHECK(false);
    }
  }
  {
    const std::string path = std::string("/api/trust/") + kHashA;
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", path, ""), &res));
    CHECK(res.status == 200);
    dc::Json lookup = parseBody(res.body, &parsed);
    CHECK(parsed);
    if (const dc::Json* known = lookup.find("known")) {
      CHECK(known->isBool() && known->asBool());
    } else {
      CHECK(false);
    }
    if (const dc::Json* env = lookup.find("envMatch")) {
      CHECK(env->isBool() && env->asBool());  // same process, same environment
    } else {
      CHECK(false);
    }
    if (const dc::Json* scripts = lookup.find("scripts")) {
      CHECK(scripts->isArray() && scripts->items().size() == 2);
    } else {
      CHECK(false);
    }
    // A hash nobody blessed is a definite "not known", not an error.
    const std::string otherPath = std::string("/api/trust/") + kHashB;
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", otherPath, ""), &res));
    CHECK(res.status == 200);
    dc::Json missing = parseBody(res.body, &parsed);
    if (const dc::Json* known = missing.find("known")) {
      CHECK(known->isBool() && !known->asBool());
    } else {
      CHECK(false);
    }
  }

  // ── 4. malformed input is stated as such; unknown verbs are a miss ────────
  {
    const std::string shortHash = dc::Json::object({{"hash", dc::Json("abc")}}).dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust", "", shortHash), &res));
    CHECK(res.status == 400);
    CHECK(res.body.find("badHash") != std::string::npos);

    const std::string nonHex =
        dc::Json::object(
            {{"hash", dc::Json("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")}})
            .dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust", "", nonHex), &res));
    CHECK(res.status == 400);
    CHECK(res.body.find("badHash") != std::string::npos);

    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust/persistence", "",
                                                         std::string("{oops")),
                              &res));
    CHECK(res.status == 400);
    CHECK(res.body.find("unexpectedToken") != std::string::npos);

    // A string where the contract says boolean: refused, not coerced.
    const std::string wrongType = dc::Json::object({{"persist", dc::Json("yes")}}).dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust/persistence", "",
                                                         wrongType),
                              &res));
    CHECK(res.status == 400);

    // The path is matched by prefix, so a longer name must not fall into the collection.
    // A suffix that cannot be a hash is refused as such (400 badHash) — the same answer a
    // malformed body gets, because both mean "that is not an identity".
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trusted", ""), &res));
    CHECK(res.status == 400);
    CHECK(res.body.find("badHash") != std::string::npos);
    // A one-character suffix never reaches the lookup at all: it is not a collection member,
    // so it stays a plain miss rather than an identity error.
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trustX", ""), &res));
    CHECK(res.status == 404);
    CHECK(res.body.find("notFound") != std::string::npos);

    // Nothing implements PUT here; a 404 says so instead of pretending to have accepted it.
    CHECK(dctest::sendRequest(port, dctest::buildRequest("PUT", "/api/trust", "", "{}"), &res));
    CHECK(res.status == 404);
  }

  // ── 5. the Origin gate applies to trust like any other route ──────────────
  {
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trust", foreign), &res));
    CHECK(res.status == 403);
    CHECK(res.body == "{\"code\":\"forbiddenOrigin\"}");
    CHECK(!dctest::headerPresent(res, "access-control-allow-origin"));

    const std::string body = dc::Json::object({{"hash", dc::Json(kHashB)}}).dump();
    CHECK(dctest::sendRequest(port, dctest::buildRequest("POST", "/api/trust", foreign, body), &res));
    CHECK(res.status == 403);
    CHECK(!dctest::headerPresent(res, "access-control-allow-origin"));

    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", "/api/trust", frontend), &res));
    CHECK(res.status == 200);
    CHECK(dctest::headerValue(res, "access-control-allow-origin") == frontend);
  }

  // ── 6. revoking is the documented "forget this file" path ─────────────────
  {
    const std::string path = std::string("/api/trust/") + kHashA;
    CHECK(dctest::sendRequest(port, dctest::buildRequest("DELETE", path, ""), &res));
    CHECK(res.status == 200);
    dc::Json revoked = parseBody(res.body, &parsed);
    if (const dc::Json* field = revoked.find("revoked")) {
      CHECK(field->isBool() && field->asBool());
    } else {
      CHECK(false);
    }
    CHECK(dctest::sendRequest(port, dctest::buildRequest("GET", path, ""), &res));
    CHECK(res.status == 200);
    dc::Json gone = parseBody(res.body, &parsed);
    if (const dc::Json* known = gone.find("known")) {
      CHECK(known->isBool() && !known->asBool());
    } else {
      CHECK(false);
    }
    // Revoking what is not there is not an error — the state the caller asked for holds.
    CHECK(dctest::sendRequest(port, dctest::buildRequest("DELETE", path, ""), &res));
    CHECK(res.status == 200);
  }

  // ── 7. a corrupt record: trust nothing, and say so ────────────────────────
  {
    const std::string broken = uniqueDir("dc-trust-corrupt-");
    setEnv("DC_TRUST_DIR", broken.c_str());
    {
      // Half-written JSON is the shape a crash mid-save used to leave behind.
      std::ofstream out(std::filesystem::path(broken) / "trust.json",
                        std::ios::binary | std::ios::trunc);
      out << "{\"version\":1,\"envId\":\"v1-00\",\"entries\":";
    }
    auto* corrupt = new dc::TrustStore(std::string());
    const Running second = startServer(corrupt);
    CHECK(second.listening);
    if (second.listening) {
      CHECK(dctest::sendRequest(second.port, dctest::buildRequest("GET", "/api/trust", ""), &res));
      CHECK(res.status == 200);
      dc::Json unreadable = parseBody(res.body, &parsed);
      if (const dc::Json* field = unreadable.find("persistence")) {
        CHECK(field->isString() && field->asString() == "unavailable");
      } else {
        CHECK(false);
      }
      // Every write is refused with the same code, so the UI has one branch to render.
      const std::string body = dc::Json::object({{"hash", dc::Json(kHashA)}}).dump();
      CHECK(dctest::sendRequest(second.port, dctest::buildRequest("POST", "/api/trust", "", body),
                                &res));
      CHECK(res.status == 409);
      CHECK(res.body.find("trustUnavailable") != std::string::npos);

      const std::string persist = dc::Json::object({{"persist", dc::Json(true)}}).dump();
      CHECK(dctest::sendRequest(second.port,
                                dctest::buildRequest("POST", "/api/trust/persistence", "", persist),
                                &res));
      CHECK(res.status == 409);
      CHECK(res.body.find("trustUnavailable") != std::string::npos);
    }
  }

  // ── 8. no store at all (trust == nullptr) is a 503, not an empty list ─────
  {
    const Running third = startServer(nullptr);
    CHECK(third.listening);
    if (third.listening) {
      CHECK(dctest::sendRequest(third.port, dctest::buildRequest("GET", "/api/trust", ""), &res));
      CHECK(res.status == 503);
      CHECK(res.body.find("trustUnavailable") != std::string::npos);
    }
  }

  std::printf("%s: trust_route (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
