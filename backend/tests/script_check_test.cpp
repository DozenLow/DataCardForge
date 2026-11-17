// POST /api/script/check: compile-only syntax check + the runner's static impurity scan.
//
// The endpoint exists so the editor can get an AUTHORITATIVE syntax answer (and the
// "not reproducible" stamp) without running anything. That makes two properties worth a
// gate of their own, and both are tested end to end over a socket against the real server:
//
//   1. the three-state verdict — ok + lint passthrough, syntax error with the runner's line/
//      column, and runtimeMissing when no interpreter can be resolved;
//   2. CHECK DOES NOT EXECUTE. The script below calls `open(<path>, 'w')` as its first
//      statement. A check that ran it (or imported the module) would create that file; the
//      endpoint's contract is that the path is never there. The decision doc is explicit
//      that this is the safety boundary, not an optimisation
//      (docs/decisions/2026-11-15-python-script-card.md §九).
//
// It needs third_party/pyruntime (bash scripts/fetch-python-runtime.sh). Without it the test
// prints SKIP and exits 0, like python_node_test.cpp: "not applicable" and "verified" must
// not look the same.
//
// The server runs in-process on an ephemeral port (never 37811, where the installed service
// may already be listening) — same harness as origin_gate_test.cpp, because the endpoint is
// reached through the real router, the real Origin gate and the one-send response writer.
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <map>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  define dc_test_close_socket closesocket
#else
#  include <arpa/inet.h>
#  include <netinet/in.h>
#  include <sys/socket.h>
#  include <unistd.h>
#  define dc_test_close_socket close
#endif

#include "http_server.h"
#include "json.h"
#include "matrix_store.h"
#include "nodes.h"

namespace {

int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

#define CHECK_MSG(cond, ...)                          \
  do {                                                \
    if (!(cond)) {                                    \
      std::printf("FAIL %s:%d %s | ", __FILE__, __LINE__, #cond); \
      std::printf(__VA_ARGS__);                       \
      std::printf("\n");                              \
      ++failures;                                     \
    }                                                 \
  } while (0)

// ── HTTP over a loopback socket ─────────────────────────────────────────

struct Response {
  int status = 0;
  std::map<std::string, std::string> headers;
  std::string body;
};

std::string toLower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string trimmed(std::string s) {
  size_t begin = 0;
  while (begin < s.size() && (s[begin] == ' ' || s[begin] == '\t')) ++begin;
  size_t end = s.size();
  while (end > begin && (s[end - 1] == ' ' || s[end - 1] == '\t')) --end;
  return s.substr(begin, end - begin);
}

dc::socket_t dialLoopback(int port) {
  const dc::socket_t fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd == static_cast<dc::socket_t>(-1)) return fd;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<unsigned short>(port));
  addr.sin_addr.s_addr = htonl(0x7f000001u);
#ifdef _WIN32
  const int addrLen = static_cast<int>(sizeof addr);
#else
  const socklen_t addrLen = static_cast<socklen_t>(sizeof addr);
#endif
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), addrLen) != 0) {
    dc_test_close_socket(fd);
    return static_cast<dc::socket_t>(-1);
  }
  return fd;
}

bool sendAll(dc::socket_t fd, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    const int n = static_cast<int>(::send(fd, data.data() + sent, data.size() - sent, 0));
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

bool sendRequest(int port, const std::string& raw, Response* out) {
  *out = Response();
  const dc::socket_t fd = dialLoopback(port);
  if (fd == static_cast<dc::socket_t>(-1)) return false;
#ifdef _WIN32
  const DWORD timeoutMs = 30000;  // a cold interpreter start must not fail the gate
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeoutMs),
             static_cast<int>(sizeof timeoutMs));
#else
  timeval timeout{};
  timeout.tv_sec = 30;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
#endif
  bool ok = sendAll(fd, raw);
  std::string buf;
  size_t headEnd = std::string::npos;
  while (ok && headEnd == std::string::npos) {
    char chunk[4096];
    const int n = static_cast<int>(::recv(fd, chunk, sizeof chunk, 0));
    if (n <= 0) {
      ok = false;
      break;
    }
    buf.append(chunk, static_cast<size_t>(n));
    headEnd = buf.find("\r\n\r\n");
    if (headEnd == std::string::npos && buf.size() > (1u << 20)) ok = false;
  }
  if (ok) {
    const std::string head = buf.substr(0, headEnd);
    size_t lineEnd = head.find("\r\n");
    if (lineEnd == std::string::npos) lineEnd = head.size();
    const std::string statusLine = head.substr(0, lineEnd);
    const size_t sp = statusLine.find(' ');
    int status = 0;
    int digits = 0;
    if (sp != std::string::npos) {
      for (size_t i = sp + 1; i < statusLine.size() && digits < 3; ++i, ++digits) {
        if (statusLine[i] < '0' || statusLine[i] > '9') break;
        status = status * 10 + (statusLine[i] - '0');
      }
    }
    if (digits != 3) {
      ok = false;
    } else {
      out->status = status;
      size_t pos = head.find("\r\n");
      pos = pos == std::string::npos ? std::string::npos : pos + 2;
      while (pos != std::string::npos && pos < head.size()) {
        size_t end = head.find("\r\n", pos);
        if (end == std::string::npos) end = head.size();
        const std::string line = head.substr(pos, end - pos);
        const size_t colon = line.find(':');
        if (colon != std::string::npos) {
          const std::string name = toLower(trimmed(line.substr(0, colon)));
          if (out->headers.find(name) == out->headers.end())
            out->headers[name] = trimmed(line.substr(colon + 1));
        }
        pos = end < head.size() ? end + 2 : std::string::npos;
      }
      const auto it = out->headers.find("content-length");
      if (it == out->headers.end()) {
        ok = false;
      } else {
        size_t want = 0;
        bool numeric = !it->second.empty();
        for (const char c : it->second) {
          if (c < '0' || c > '9') {
            numeric = false;
            break;
          }
          want = want * 10 + static_cast<size_t>(c - '0');
        }
        const size_t bodyStart = headEnd + 4;
        while (numeric && buf.size() < bodyStart + want) {
          char chunk[4096];
          const int n = static_cast<int>(::recv(fd, chunk, sizeof chunk, 0));
          if (n <= 0) {
            numeric = false;
            break;
          }
          buf.append(chunk, static_cast<size_t>(n));
        }
        if (!numeric) {
          ok = false;
        } else {
          out->body = buf.substr(bodyStart, want);
        }
      }
    }
  }
  dc_test_close_socket(fd);
  return ok;
}

int pickEphemeralPort() {
  const dc::socket_t fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd == static_cast<dc::socket_t>(-1)) return 0;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = 0;
  addr.sin_addr.s_addr = htonl(0x7f000001u);
#ifdef _WIN32
  int addrLen = static_cast<int>(sizeof addr);
#else
  socklen_t addrLen = static_cast<socklen_t>(sizeof addr);
#endif
  int port = 0;
  if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), addrLen) == 0 &&
      ::getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &addrLen) == 0)
    port = static_cast<int>(ntohs(addr.sin_port));
  dc_test_close_socket(fd);
  return port;
}

bool waitForListen(int port, const std::atomic<bool>& bindFailed) {
  for (int attempt = 0; attempt < 300; ++attempt) {
    if (bindFailed.load()) return false;
    const dc::socket_t fd = dialLoopback(port);
    if (fd != static_cast<dc::socket_t>(-1)) {
      dc_test_close_socket(fd);
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return false;
}

std::string buildRequest(const std::string& method, const std::string& path,
                         const std::string& body) {
  std::string raw = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  if (!body.empty()) raw += "Content-Type: application/json\r\n";
  raw += "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n";
  raw += body;
  return raw;
}

// ── check requests ──────────────────────────────────────────────────────

struct CheckReply {
  bool transportOk = false;
  Response http;
  dc::Json json;
};

CheckReply postCheck(int port, const std::string& script) {
  CheckReply reply;
  const dc::Json body = dc::Json::object({{"script", dc::Json(script)}});
  reply.transportOk =
      sendRequest(port, buildRequest("POST", "/api/script/check", body.dump()), &reply.http);
  if (!reply.transportOk) return reply;
  std::string parseError;
  if (!dc::Json::parse(reply.http.body, &reply.json, &parseError))
    std::printf("  body was not JSON: %s\n", reply.http.body.c_str());
  return reply;
}

// Number of leftover scratch directories the endpoint created. The endpoint removes its
// directory on every exit path, so this must not grow across requests.
size_t countCheckScratchDirs() {
  std::error_code ec;
  const std::filesystem::path parent = std::filesystem::temp_directory_path(ec);
  if (ec) return 0;
  size_t count = 0;
  for (const auto& entry : std::filesystem::directory_iterator(parent, ec)) {
    if (entry.path().filename().string().rfind("dcchk-", 0) == 0) ++count;
  }
  return count;
}

bool containsString(const dc::Json& array, const std::string& needle) {
  for (const dc::Json& item : array.items())
    if (item.isString() && item.asString().find(needle) != std::string::npos) return true;
  return false;
}

// A Python string literal for a path this test itself builds: only backslashes and quotes
// need escaping, and a Windows temp path is full of backslashes.
std::string quoteForPython(const std::string& text) {
  std::string out = "\"";
  for (const char c : text) {
    if (c == '\\' || c == '"') out.push_back('\\');
    out.push_back(c);
  }
  out.push_back('"');
  return out;
}

}  // namespace

int main() {
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    std::printf("FAILED: script_check (winsock init)\n");
    return 1;
  }
#else
  // POSIX-only: on Windows the closed peer shows up as a failed send()/recv() instead.
#ifdef SIGPIPE
  std::signal(SIGPIPE, SIG_IGN);  // a peer closing early must fail the CHECK, not the process
#endif
#endif

  std::string runtimeNote;
  const dc::PythonRuntime runtime = dc::resolvePythonRuntime(&runtimeNote);
  if (runtime.python.empty()) {
    std::printf("SKIP: script_check (no %s; run scripts/fetch-python-runtime.sh)\n",
                runtimeNote.c_str());
    return 0;
  }

  const int port = pickEphemeralPort();
  if (port == 0) {
    std::printf("FAILED: script_check (no free port)\n");
    return 1;
  }

  // Leaked on purpose, like origin_gate_test.cpp: the detached accept loop answers until the
  // process exits, so the server and everything it dereferences must outlive main()'s stack.
  auto* store = new dc::MatrixStore();
  auto* bus = new dc::EventBus();
  auto* nodes = new dc::NodeRegistry(store, bus);
  auto* server = new dc::HttpServer(port, store, nodes, bus);
  std::atomic<bool> bindFailed{false};
  std::thread([server, &bindFailed] {
    if (!server->serve()) bindFailed.store(true);
  }).detach();
  if (!waitForListen(port, bindFailed)) {
    std::printf("FAILED: script_check (could not listen on 127.0.0.1:%d)\n", port);
    return 1;
  }

  const size_t scratchBefore = countCheckScratchDirs();

  // ── state 1: syntax OK, lint passthrough ─────────────────────────────
  {
    const CheckReply reply = postCheck(port, "value = 1 + 1\nprint(value)\n");
    CHECK(reply.transportOk);
    CHECK(reply.http.status == 200);
    CHECK(reply.http.headers.count("content-type") == 1);
    CHECK(reply.json.isObject());
    CHECK(reply.json["ok"].asBool());
    const dc::Json* lint = reply.json.find("lint");
    CHECK(lint != nullptr && lint->isObject());
    const dc::Json* impure = (lint != nullptr && lint->isObject()) ? lint->find("impure") : nullptr;
    CHECK(impure != nullptr && impure->isArray());
    CHECK(impure != nullptr && impure->isArray() && impure->items().empty());
  }

  // ── state 1b: impure scripts are REPORTED, not refused ───────────────
  // A card that reads the clock/network/random is allowed to exist and to run; the check
  // only labels it. The list is the runner's own sentences, forwarded untouched.
  {
    const CheckReply reply = postCheck(port, "import socket\nimport random\nflag = random.random()\n");
    CHECK(reply.transportOk);
    CHECK(reply.http.status == 200);
    CHECK(reply.json["ok"].asBool());
    const dc::Json* lint = reply.json.find("lint");
    const dc::Json* impure = (lint != nullptr && lint->isObject()) ? lint->find("impure") : nullptr;
    CHECK(impure != nullptr && impure->isArray());
    if (impure != nullptr && impure->isArray()) {
      CHECK_MSG(containsString(*impure, "import socket"), "impure: %s",
                lint->dump().c_str());
      CHECK_MSG(containsString(*impure, "random"), "impure: %s", lint->dump().c_str());
    }
  }

  // ── state 2: syntax error, with the runner's line/column ─────────────
  {
    // The bad parenthesis is on line 3: the number travels from the interpreter, so this
    // also pins that line numbers are the SCRIPT's lines (no wrapper is prepended).
    const CheckReply reply = postCheck(port, "a = 1\nb = 2\ndef f(:\n    pass\n");
    CHECK(reply.transportOk);
    CHECK(reply.http.status == 200);
    CHECK(!reply.json["ok"].asBool());
    const dc::Json* error = reply.json.find("error");
    CHECK(error != nullptr && error->isObject());
    if (error != nullptr && error->isObject()) {
      CHECK(error->find("code") != nullptr && (*error)["code"].asString() == "syntaxError");
      const dc::Json* line = error->find("line");
      CHECK(line != nullptr && line->isNumber() && static_cast<int>(line->asNumber()) == 3);
      const dc::Json* col = error->find("col");
      CHECK(col != nullptr && col->isNumber() && col->asNumber() >= 1);
      const dc::Json* message = error->find("message");
      CHECK(message != nullptr && message->isString() && !message->asString().empty());
      CHECK_MSG(error->dump().find("\"lint\"") == std::string::npos,
                "a failed check must not carry a lint verdict: %s", error->dump().c_str());
    }
  }

  // ── state 3: runtimeMissing ──────────────────────────────────────────
  {
    // DC_PYRUNTIME wins outright and a broken override is reported, never replaced by the
    // checkout's copy — so pointing it at a directory with no interpreter is the portable
    // way to ask "what does this looks like on a machine without the runtime?".
    const char* previous = std::getenv("DC_PYRUNTIME");
    const std::string saved = previous == nullptr ? std::string() : std::string(previous);
#ifdef _WIN32
    _putenv_s("DC_PYRUNTIME", "C:\\dc-no-such-runtime");
#else
    setenv("DC_PYRUNTIME", "/dc-no-such-runtime", 1);
#endif
    const CheckReply reply = postCheck(port, "value = 1\n");
    const dc::Json* error = reply.json.find("error");
    CHECK(reply.transportOk);
    CHECK(reply.http.status == 200);
    CHECK(!reply.json["ok"].asBool());
    CHECK(error != nullptr && error->isObject());
    CHECK(error != nullptr && error->isObject() && (*error)["code"].asString() == "runtimeMissing");
    // Restore: the does-not-execute case below needs the real runtime.
#ifdef _WIN32
    _putenv_s("DC_PYRUNTIME", saved.c_str());
#else
    if (saved.empty()) {
      unsetenv("DC_PYRUNTIME");
    } else {
      setenv("DC_PYRUNTIME", saved.c_str(), 1);
    }
#endif
  }

  // ── the gate that matters: a check NEVER executes the script ─────────
  {
    std::error_code ec;
    // Unique per run, and deliberately OUTSIDE every scratch directory: if the endpoint (or
    // the runner) executed the text, this is the file that would appear.
    const long long stamp = static_cast<long long>(
        std::chrono::steady_clock::now().time_since_epoch().count());
    const std::filesystem::path marker =
        std::filesystem::temp_directory_path(ec) /
        ("dc-check-must-not-run-" + std::to_string(stamp) + ".txt");
    std::filesystem::remove(marker, ec);
    const std::string script = "with open(" + quoteForPython(marker.string()) +
                               ", \"w\") as fh:\n    fh.write(\"the check executed me\")\n"
                               "result = 1\n";
    const CheckReply reply = postCheck(port, script);
    CHECK(reply.transportOk);
    // The script is VALID Python: a check that ran it would succeed and write the file.
    CHECK(reply.json["ok"].asBool());
    CHECK_MSG(!std::filesystem::exists(marker),
              "the check executed the submitted script (marker at %s)", marker.string().c_str());
    // `open()` is exactly the kind of non-reproducible read the lint is for, so the same
    // reply must carry it — the two halves of the endpoint work on the same tree.
    const dc::Json* lint = reply.json.find("lint");
    const dc::Json* impure = (lint != nullptr && lint->isObject()) ? lint->find("impure") : nullptr;
    CHECK(impure != nullptr && impure->isArray() && containsString(*impure, "open()"));
    std::filesystem::remove(marker, ec);
  }

  // ── scratch cleanup: no temporary directory survives a request ───────
  {
    const size_t scratchAfter = countCheckScratchDirs();
    CHECK_MSG(scratchAfter == scratchBefore, "the check left %zu scratch director(y/ies) behind",
              scratchAfter > scratchBefore ? scratchAfter - scratchBefore : 0);
  }

  // ── malformed request: a protocol error, not a verdict ───────────────
  {
    Response res;
    CHECK(sendRequest(port, buildRequest("POST", "/api/script/check", "{\"script\": 5}"), &res));
    CHECK(res.status == 400);
    CHECK(res.body.find("\"code\"") != std::string::npos);
    CHECK(res.body.find("\"ok\"") == std::string::npos);
  }

  std::printf("%s: script_check (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}