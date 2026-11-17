// HTTP Origin gate: who is allowed to read a response.
//
// Binding to 127.0.0.1 is reachability, not authorisation: any page the user has open can
// still send requests here, and the wildcard `Access-Control-Allow-Origin: *` handed the
// response to whatever origin asked. These cases pin the three-way rule (no Origin /
// loopback Origin / everything else) plus the OPTIONS preflight, end to end over a socket —
// the decision lives inside readRequest/sendResponse, so there is no seam below it worth
// faking.
//
// The server runs in-process on an ephemeral port (never 37811, where the installed service
// may already be listening). Style follows static_path_test.cpp: CHECK accumulates, main
// prints PASS/FAILED and returns non-zero on any failure.
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#ifndef _WIN32
#  include <csignal>
#endif
#include <map>
#include <string>
#include <thread>

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

// One parsed response. Header names are stored lowercased, values untouched.
struct Response {
  int status = 0;
  std::map<std::string, std::string> headers;
  std::string body;
};

bool headerPresent(const Response& res, const std::string& name) {
  return res.headers.find(name) != res.headers.end();
}

std::string headerValue(const Response& res, const std::string& name) {
  const auto it = res.headers.find(name);
  return it == res.headers.end() ? std::string() : it->second;
}

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
  addr.sin_addr.s_addr = htonl(0x7f000001u);  // 127.0.0.1, same as HttpServer::serve()
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

// One complete request/response on its own connection. A receive timeout turns a malformed
// response into a failed CHECK instead of a hung ctest run.
bool sendRequest(int port, const std::string& raw, Response* out) {
  *out = Response();  // a stale Content-Length from the previous case would stall the read
  const dc::socket_t fd = dialLoopback(port);
  if (fd == static_cast<dc::socket_t>(-1)) return false;
#ifdef _WIN32
  const DWORD timeoutMs = 5000;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeoutMs),
             static_cast<int>(sizeof timeoutMs));
#else
  timeval timeout{};
  timeout.tv_sec = 5;
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
    // "HTTP/1.1 204 No Content"
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
      // sendResponse always emits Content-Length, so a response without one is a failure
      // of its own rather than an excuse to read until the server closes.
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

// A port the OS says is free. The listener still races another process for it, which is
// why waitForListen() below reports a bind failure instead of hanging.
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

// The accept loop starts in a detached thread, so readiness is observed by connecting.
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

// origin == "" means the header is absent (a non-browser client); pass "\r\nOrigin:" for an
// empty header value.
std::string buildRequest(const std::string& method, const std::string& path,
                         const std::string& origin, const std::string& body = std::string()) {
  std::string raw = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  if (!origin.empty()) raw += "Origin: " + origin + "\r\n";
  if (!body.empty()) raw += "Content-Type: application/json\r\n";
  raw += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  raw += "\r\n";
  raw += body;
  return raw;
}

}  // namespace

int main() {
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    std::printf("FAILED: origin_gate (winsock init)\n");
    return 1;
  }
#else
  // SIGPIPE exists on POSIX only: on Windows a peer closing early surfaces as a failed
  // send()/recv(), which the CHECK already catches.
#ifdef SIGPIPE
  std::signal(SIGPIPE, SIG_IGN);  // a peer closing early must fail the CHECK, not the process
#endif
#endif
  const int port = pickEphemeralPort();
  if (port == 0) {
    std::printf("FAILED: origin_gate (no free port)\n");
    return 1;
  }

  // Leaked on purpose: the detached accept loop answers until the process exits, so the
  // server and everything it dereferences must outlive main()'s stack. Deleting them first
  // would be a use-after-free on whatever connection is still in flight.
  auto* store = new dc::MatrixStore();
  auto* bus = new dc::EventBus();
  auto* nodes = new dc::NodeRegistry(store, bus);
  auto* server = new dc::HttpServer(port, store, nodes, bus);
  std::atomic<bool> bindFailed{false};
  std::thread([server, &bindFailed] {
    if (!server->serve()) bindFailed.store(true);
  }).detach();
  if (!waitForListen(port, bindFailed)) {
    std::printf("FAILED: origin_gate (could not listen on 127.0.0.1:%d)\n", port);
    return 1;
  }

  const std::string frontend = "http://127.0.0.1:37811";
  Response res;

  // ── no Origin: the non-browser path is unchanged (200, no CORS headers) ─
  CHECK(sendRequest(port, buildRequest("GET", "/api/hello", ""), &res));
  CHECK(res.status == 200);
  CHECK(res.body.find("\"protocol\"") != std::string::npos);
  CHECK(!headerPresent(res, "access-control-allow-origin"));
  CHECK(!headerPresent(res, "access-control-allow-methods"));
  CHECK(!headerPresent(res, "vary"));

  // ── loopback Origin: echoed verbatim, with the allow-list ───────────────
  CHECK(sendRequest(port, buildRequest("GET", "/api/hello", frontend), &res));
  CHECK(res.status == 200);
  CHECK(headerValue(res, "access-control-allow-origin") == frontend);
  CHECK(headerValue(res, "vary") == "Origin");
  // The allow-list has to name every verb route() serves. It was missing PATCH until
  // 2026-11-17: the server implements PATCH /api/nodes/{id}, but a browser would have been
  // stopped at the preflight, leaving that route unreachable from any page. PUT is absent on
  // purpose — nothing implements it.
  CHECK(headerValue(res, "access-control-allow-methods") == "GET, POST, PATCH, DELETE, OPTIONS");
  CHECK(headerValue(res, "access-control-allow-headers") == "Content-Type");
  CHECK(res.body.find("\"protocol\"") != std::string::npos);

  // localhost, https, uppercase scheme+host and a portless origin are all the same machine;
  // the echoed value keeps the exact spelling the browser sent.
  const char* sameMachine[] = {"http://localhost:5173", "https://localhost",
                               "HTTPS://127.0.0.1:5173", "http://LOCALHOST:5173"};
  for (const char* origin : sameMachine) {
    const std::string value = origin;
    CHECK(sendRequest(port, buildRequest("GET", "/api/hello", value), &res));
    CHECK(res.status == 200);
    CHECK(headerValue(res, "access-control-allow-origin") == value);
    CHECK(headerValue(res, "vary") == "Origin");
  }

  // ── any other Origin: 403 {"code":"forbiddenOrigin"}, no CORS headers ───
  CHECK(sendRequest(port, buildRequest("GET", "/api/hello", "https://evil.example"), &res));
  CHECK(res.status == 403);
  CHECK(res.body == "{\"code\":\"forbiddenOrigin\"}");
  CHECK(!headerPresent(res, "access-control-allow-origin"));
  CHECK(!headerPresent(res, "vary"));

  // The gate is not GET-only: the same foreign origin is refused on a write.
  CHECK(sendRequest(port, buildRequest("POST", "/api/hello", "https://evil.example", "{}"), &res));
  CHECK(res.status == 403);
  CHECK(res.body == "{\"code\":\"forbiddenOrigin\"}");

  // A same-machine origin is not method-limited either: the POST reaches the router.
  CHECK(sendRequest(port, buildRequest("POST", "/api/hello", frontend, "{}"), &res));
  CHECK(res.status == 200);
  CHECK(headerValue(res, "access-control-allow-origin") == frontend);

  // Look-alikes and unparseable values are foreign origins, not loopback.
  CHECK(sendRequest(port, buildRequest("GET", "/api/hello", "http://127.0.0.1.evil.example"), &res));
  CHECK(res.status == 403);
  CHECK(sendRequest(port, buildRequest("GET", "/api/hello", "http://localhost:5173/x"), &res));
  CHECK(res.status == 403);
  CHECK(sendRequest(port, buildRequest("GET", "/api/hello", "null"), &res));
  CHECK(res.status == 403);
  CHECK(sendRequest(port, "GET /api/hello HTTP/1.1\r\nHost: x\r\nOrigin:\r\n\r\n", &res));
  CHECK(res.status == 403);

  // ── preflight ──────────────────────────────────────────────────────────
  CHECK(sendRequest(port, buildRequest("OPTIONS", "/api/hello", frontend), &res));
  CHECK(res.status == 204);
  CHECK(res.body.empty());
  CHECK(headerValue(res, "access-control-allow-origin") == frontend);
  CHECK(headerValue(res, "vary") == "Origin");
  CHECK(headerValue(res, "access-control-allow-methods") == "GET, POST, PATCH, DELETE, OPTIONS");
  CHECK(headerValue(res, "access-control-allow-headers") == "Content-Type");

  // A preflight is answered for any path — the browser asks before the real request, and
  // that request is what gets routed (and may then 404).
  CHECK(sendRequest(port, buildRequest("OPTIONS", "/api/nodes", frontend), &res));
  CHECK(res.status == 204);
  CHECK(headerValue(res, "access-control-allow-origin") == frontend);

  // ── the allow-list covers the verbs the router actually serves ────────
  // PATCH /api/nodes/{id} exists (parameter/definition edits). A cross-origin page can only
  // reach it if the preflight offers PATCH — same-machine traffic never asks, which is why
  // the mismatch stayed invisible in development.
  CHECK(sendRequest(port, buildRequest("OPTIONS", "/api/nodes/1", frontend), &res));
  CHECK(res.status == 204);
  CHECK(headerValue(res, "access-control-allow-methods").find("PATCH") != std::string::npos);
  // ...and the verb really reaches route() instead of being turned away by the gate: the
  // registry has no node 1, so the answer is the router's 404, not a 403.
  CHECK(sendRequest(port, buildRequest("PATCH", "/api/nodes/1", frontend, "{}"), &res));
  CHECK(res.status == 404);
  CHECK(res.body.find("unknownNode") != std::string::npos);
  CHECK(headerValue(res, "access-control-allow-origin") == frontend);

  CHECK(sendRequest(port, buildRequest("OPTIONS", "/api/hello", "https://evil.example"), &res));
  CHECK(res.status == 403);
  CHECK(res.body == "{\"code\":\"forbiddenOrigin\"}");
  CHECK(!headerPresent(res, "access-control-allow-origin"));

  // No Origin: still a 204, but nothing CORS-shaped in it.
  CHECK(sendRequest(port, buildRequest("OPTIONS", "/api/hello", ""), &res));
  CHECK(res.status == 204);
  CHECK(!headerPresent(res, "access-control-allow-origin"));
  CHECK(!headerPresent(res, "vary"));

  // ── every response from an allowed origin is readable, errors included ─
  CHECK(sendRequest(port, buildRequest("GET", "/api/no-such-route", frontend), &res));
  CHECK(res.status == 404);
  CHECK(headerValue(res, "access-control-allow-origin") == frontend);
  CHECK(res.body.find("\"code\"") != std::string::npos);

  std::printf("%s: origin_gate (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}