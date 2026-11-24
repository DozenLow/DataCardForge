#include "http_server.h"
#include "build_sha.h"  // generated at build time
#include "static_files.h"

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>
#  ifndef MSG_NOSIGNAL
#    define MSG_NOSIGNAL 0
#  endif
#  define dc_close_socket closesocket
#else
#  include <arpa/inet.h>
#  include <fcntl.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <signal.h>
#  include <sys/socket.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <sys/wait.h>
#  include <unistd.h>
#  define dc_close_socket close
#endif

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string_view>
#include <thread>
#include <vector>

#include "expression.h"
#include "signature.h"
#include "accuracy.h"

namespace dc {

namespace {

// Hard bounds for one request. Headers are tiny; bodies are bounded so a client cannot
// make the server allocate without limit (audit: the old code only capped the buffer
// while it was still looking for the end of the headers).
constexpr size_t kMaxHeaderBytes = 128u * 1024u;
constexpr size_t kMaxBodyBytes = 32u * 1024u * 1024u;

std::string urlDecode(const std::string& s) {
  auto hexDigit = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '+') {
      out.push_back(' ');
      continue;
    }
    if (s[i] == '%' && i + 2 < s.size()) {
      const int hi = hexDigit(s[i + 1]);
      const int lo = hexDigit(s[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
      // Malformed escape: keep it literal instead of throwing (was a remote crash).
    }
    out.push_back(s[i]);
  }
  return out;
}

// Non-throwing integer parse (std::stoul threw std::invalid_argument/out_of_range out of
// a detached thread → std::terminate → whole process died).
bool parseUnsigned(std::string_view text, size_t* out) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r')) text.remove_suffix(1);
  if (text.empty()) return false;
  unsigned long long value = 0;
  const auto res = std::from_chars(text.data(), text.data() + text.size(), value, 10);
  if (res.ec != std::errc() || res.ptr != text.data() + text.size()) return false;
  *out = static_cast<size_t>(value);  // may legitimately exceed the cap → 413, not 400
  return true;
}

bool parseHexSize(std::string_view text, size_t* out) {
  // Chunk size may carry extensions ("1a;ext=1"); only the leading hex digits count.
  const size_t semi = text.find(';');
  if (semi != std::string_view::npos) text = text.substr(0, semi);
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  if (text.empty()) return false;
  unsigned long long value = 0;
  const auto res = std::from_chars(text.data(), text.data() + text.size(), value, 16);
  if (res.ec != std::errc() || res.ptr != text.data() + text.size()) return false;
  *out = static_cast<size_t>(value);
  return true;
}

int64_t parseId(const std::string& s) {
  long long value = 0;
  const auto res = std::from_chars(s.data(), s.data() + s.size(), value, 10);
  if (res.ec != std::errc() || res.ptr != s.data() + s.size()) return -1;
  return static_cast<int64_t>(value);
}

HttpResponse jsonError(int status, const std::string& code, Json params = Json::object()) {
  Json body = Json::object({{"code", Json(code)}});
  if (!params.isNull() && params.isObject() && !params.members().empty())
    body.set("params", std::move(params));
  return HttpResponse{status, "application/json", body.dump(), nullptr};
}

HttpResponse jsonOk(Json value) { return HttpResponse{200, "application/json", value.dump(), nullptr}; }

// ── Origin gate ────────────────────────────────────────────────────────
// Binding to 127.0.0.1 makes the server reachable, it does not authorise the caller: any
// page the user has open can still POST here, and the wildcard
// `Access-Control-Allow-Origin: *` used to hand the response to whatever origin asked.
// Only the two origins that can be the server's own front end may read a response.
//
// The decision comes from the request's Origin header and nothing else:
//   no header     → not a browser request (curl, scripts) → unchanged response, no CORS
//   loopback host → echo the value verbatim + advertise the allow-list
//   anything else → 403, no CORS headers; unparseable values land here too, because the
//                   safe default for a header this code cannot prove is same-machine

enum class OriginGate { None, Allowed, Forbidden };

struct OriginHeader {
  bool present = false;
  std::string value;
};

struct OriginDecision {
  OriginGate gate = OriginGate::None;
  std::string echo;  // the Origin value, verbatim; only filled when gate == Allowed
};

bool asciiEqualsNoCase(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    const auto ca = static_cast<unsigned char>(a[i]);
    const auto cb = static_cast<unsigned char>(b[i]);
    if (std::tolower(ca) != std::tolower(cb)) return false;
  }
  return true;
}

// Header names are case-insensitive. The value comes back with only the surrounding
// spaces/tabs trimmed: a browser's exact bytes are what gets echoed into the response.
bool findRequestHeader(const std::string& head, std::string_view name, std::string* value) {
  size_t pos = head.find("\r\n");  // skip the request line
  if (pos == std::string::npos) return false;  // no header lines at all
  pos += 2;
  while (pos < head.size()) {
    size_t end = head.find("\r\n", pos);
    if (end == std::string::npos) end = head.size();
    const std::string_view line(head.data() + pos, end - pos);
    const size_t colon = line.find(':');
    if (colon != std::string_view::npos && asciiEqualsNoCase(line.substr(0, colon), name)) {
      std::string_view text = line.substr(colon + 1);
      while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
      while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
      *value = std::string(text);
      return true;
    }
    pos = end + 2;
  }
  return false;
}

// "scheme://host[:port]" with a loopback host and an http(s) scheme, any port. Everything
// else is refused: "null", a path or query suffix, userinfo, an IPv6 literal, the
// 127.0.0.1.example.com look-alike. A browser never sends those, so refusing costs nothing.
bool isLoopbackOrigin(const std::string& origin) {
  if (origin.empty() || origin.size() > 512) return false;
  for (const char c : origin) {  // the echoed value must not carry CR/LF or other controls
    const auto u = static_cast<unsigned char>(c);
    if (u < 0x20 || u == 0x7f) return false;
  }
  const size_t schemeEnd = origin.find("://");
  if (schemeEnd == std::string::npos || schemeEnd == 0) return false;
  const std::string_view scheme(origin.data(), schemeEnd);
  if (!asciiEqualsNoCase(scheme, "http") && !asciiEqualsNoCase(scheme, "https")) return false;

  const std::string_view authority(origin.data() + schemeEnd + 3, origin.size() - schemeEnd - 3);
  if (authority.empty()) return false;
  if (authority.find_first_of(" \t/?#@[\\]") != std::string_view::npos) return false;

  std::string_view host = authority;
  const size_t colon = authority.rfind(':');
  if (colon != std::string_view::npos) {
    const std::string_view port = authority.substr(colon + 1);
    if (port.empty()) return false;
    unsigned int number = 0;
    for (const char c : port) {
      if (c < '0' || c > '9') return false;
      number = number * 10 + static_cast<unsigned int>(c - '0');
      if (number > 65535) return false;
    }
    host = authority.substr(0, colon);
  }
  return asciiEqualsNoCase(host, "127.0.0.1") || asciiEqualsNoCase(host, "localhost");
}

OriginDecision decideOrigin(const OriginHeader& header) {
  OriginDecision out;
  if (!header.present) return out;  // non-browser client: byte-for-byte the old behaviour
  if (isLoopbackOrigin(header.value)) {
    out.gate = OriginGate::Allowed;
    out.echo = header.value;
  } else {
    out.gate = OriginGate::Forbidden;
  }
  return out;
}

enum class ReadStatus { Ok, Closed, BadRequest, TooLarge };

// Reads exactly one HTTP/1.1 request. Never throws: every numeric field goes through
// from_chars and the whole routine is additionally guarded by a catch-all, because this
// runs on a detached per-connection thread where an escaping exception kills the process.
ReadStatus readRequestImpl(socket_t fd, HttpRequest* req, OriginHeader* origin,
                           std::string* pending) {
  // Keep-alive: the HttpRequest is reused across requests on one connection, so every
  // accumulating field starts empty — request N's query string must not leak into request
  // N+1 (audit: `?start=…&count=…` then a query-less /result served the wrong window).
  req->method.clear();
  req->path.clear();
  req->query.clear();
  req->body.clear();
  // The read buffer belongs to the connection and is carried across requests: bytes already
  // recv'd past this one (a pipelined next request in the same TCP segment) stay here rather
  // than being dropped, and recv() runs only when more bytes are actually needed.
  std::string& buf = *pending;
  char tmp[8192];
  size_t headerEnd = buf.find("\r\n\r\n");
  while (headerEnd == std::string::npos) {
    if (buf.size() > kMaxHeaderBytes) return ReadStatus::BadRequest;
    const int n = recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return ReadStatus::Closed;
    buf.append(tmp, static_cast<size_t>(n));
    headerEnd = buf.find("\r\n\r\n");
    if (headerEnd == std::string::npos && buf.size() > kMaxHeaderBytes) return ReadStatus::BadRequest;
  }
  const std::string head = buf.substr(0, headerEnd);
  buf.erase(0, headerEnd + 4);  // consume the header; buf now holds the body (+ any pipeline)

  // Read on every request, not just the ones the router will answer: the CORS decision is
  // made before routing and must not inherit a previous request's value on a keep-alive
  // connection.
  origin->present = findRequestHeader(head, "Origin", &origin->value);
  if (!origin->present) origin->value.clear();

  size_t contentLength = 0;
  bool haveContentLength = false;
  bool chunked = false;
  {
    std::string lower;
    lower.reserve(head.size());
    std::transform(head.begin(), head.end(), std::back_inserter(lower),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const size_t p = lower.find("\r\ncontent-length:");
    if (p != std::string::npos) {
      const std::string_view value(head.data() + p + 2 + 15, head.size() - (p + 2 + 15));
      const size_t crlf = value.find("\r\n");
      if (!parseUnsigned(value.substr(0, crlf), &contentLength)) return ReadStatus::BadRequest;
      haveContentLength = true;
    }
  }
  // Chunked is decided from the Transfer-Encoding header VALUE only. The old test matched the
  // word "chunked" anywhere in the head, so `X-Foo: chunked` + `Transfer-Encoding: identity`
  // (or the word in the request line / another header) was mis-framed as a chunked body.
  {
    std::string te;
    if (findRequestHeader(head, "Transfer-Encoding", &te)) {
      std::transform(te.begin(), te.end(), te.begin(),
                     [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
      chunked = te.find("chunked") != std::string::npos;
    }
  }

  // buf starts at the body. Consume exactly this request's body and leave any trailing
  // (pipelined) bytes in buf for the next readRequest call instead of discarding them.
  if (chunked) {
    std::string decoded;
    size_t i = 0;
    for (;;) {
      size_t eol = buf.find("\r\n", i);
      while (eol == std::string::npos) {
        const int n = recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return ReadStatus::Closed;
        buf.append(tmp, static_cast<size_t>(n));
        if (buf.size() > kMaxBodyBytes + kMaxHeaderBytes) return ReadStatus::TooLarge;
        eol = buf.find("\r\n", i);
      }
      size_t size = 0;
      if (!parseHexSize(std::string_view(buf).substr(i, eol - i), &size)) return ReadStatus::BadRequest;
      if (size == 0) {
        // Consume the terminating chunk's CRLF plus the final blank line (any trailers ride
        // along) so a pipelined next request is not desynced by leftover chunk framing.
        size_t termEnd = buf.find("\r\n\r\n", i);
        while (termEnd == std::string::npos) {
          const int n = recv(fd, tmp, sizeof tmp, 0);
          if (n <= 0) return ReadStatus::Closed;
          buf.append(tmp, static_cast<size_t>(n));
          if (buf.size() > kMaxBodyBytes + kMaxHeaderBytes) return ReadStatus::TooLarge;
          termEnd = buf.find("\r\n\r\n", i);
        }
        i = termEnd + 4;
        break;
      }
      if (size > kMaxBodyBytes) return ReadStatus::TooLarge;
      while (buf.size() < eol + 2 + size + 2) {
        const int n = recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return ReadStatus::Closed;
        buf.append(tmp, static_cast<size_t>(n));
        if (buf.size() > kMaxBodyBytes + kMaxHeaderBytes) return ReadStatus::TooLarge;
      }
      if (decoded.size() + size > kMaxBodyBytes) return ReadStatus::TooLarge;
      decoded.append(buf, eol + 2, size);
      i = eol + 2 + size + 2;
    }
    buf.erase(0, i);
    req->body = std::move(decoded);
  } else {
    if (haveContentLength && contentLength > kMaxBodyBytes) return ReadStatus::TooLarge;
    while (buf.size() < contentLength) {
      const int n = recv(fd, tmp, sizeof tmp, 0);
      if (n <= 0) return ReadStatus::Closed;
      buf.append(tmp, static_cast<size_t>(n));
    }
    req->body = buf.substr(0, contentLength);
    buf.erase(0, contentLength);
  }

  const size_t sp1 = head.find(' ');
  if (sp1 == std::string::npos) return ReadStatus::BadRequest;
  const size_t sp2 = head.find(' ', sp1 + 1);
  if (sp2 == std::string::npos) return ReadStatus::BadRequest;
  req->method = head.substr(0, sp1);
  const std::string target = head.substr(sp1 + 1, sp2 - sp1 - 1);
  const size_t q = target.find('?');
  if (q == std::string::npos) {
    req->path = urlDecode(target);
  } else {
    req->path = urlDecode(target.substr(0, q));
    const std::string query = target.substr(q + 1);
    size_t start = 0;
    while (start <= query.size()) {
      const size_t amp = query.find('&', start);
      const std::string pair = query.substr(start, amp == std::string::npos ? std::string::npos : amp - start);
      const size_t eq = pair.find('=');
      if (eq != std::string::npos) req->query[urlDecode(pair.substr(0, eq))] = urlDecode(pair.substr(eq + 1));
      if (amp == std::string::npos) break;
      start = amp + 1;
    }
  }
  return ReadStatus::Ok;
}

ReadStatus readRequest(socket_t fd, HttpRequest* req, OriginHeader* origin, std::string* pending) {
  try {
    return readRequestImpl(fd, req, origin, pending);
  } catch (...) {
    // Allocation failure or any other unexpected throw: refuse the request, keep serving.
    return ReadStatus::BadRequest;
  }
}

void writeAll(socket_t fd, const char* data, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    const int n = send(fd, data + sent, len - sent, MSG_NOSIGNAL);
    if (n <= 0) return;
    sent += static_cast<size_t>(n);
  }
}

/**
 * The CORS allow-list, as a value rather than a string literal buried in the writer.
 *
 * It must name every verb route() serves: a browser checks this list before sending a
 * cross-origin request, so a verb missing here makes its route unreachable from a page —
 * which is what happened to PATCH /api/nodes/{id} until 2026-11-17 (the route existed, the
 * preflight never offered it).
 *
 * PUT is absent on purpose: nothing implements it, and advertising a verb the server would
 * answer 404 to describes a server that does not exist. Same-origin traffic never reads this
 * header, so the list is exactly the cross-origin contract.
 */
constexpr const char* kCorsAllowedMethods = "GET, POST, PATCH, DELETE, OPTIONS";

void sendResponse(socket_t fd, HttpResponse& res, bool headersOnly, const std::string& allowOrigin) {
  std::string payload;
  if (res.binary) {
    payload = *res.binary;
    delete res.binary;
    res.binary = nullptr;
  } else {
    payload = res.body;
  }
  std::string headers = "HTTP/1.1 " + std::to_string(res.status) + " " +
                        (res.status == 200 ? "OK" : res.status == 204 ? "No Content" : "Error") + "\r\n";
  headers += "Content-Type: " + res.contentType + "\r\n";
  headers += "Content-Length: " + std::to_string(payload.size()) + "\r\n";
  headers += "Connection: keep-alive\r\n";
  if (!allowOrigin.empty()) {
    // Echoing the exact origin (never "*") is what turns the CORS answer into a function of
    // the request; Vary: Origin keeps a cache from handing it to a different origin.
    // Content-Type is the only header the front end sets, so that is the whole allow-list.
    headers += "Access-Control-Allow-Origin: " + allowOrigin + "\r\n";
    headers += "Vary: Origin\r\n";
    headers += std::string("Access-Control-Allow-Methods: ") + kCorsAllowedMethods + "\r\n";
    headers += "Access-Control-Allow-Headers: Content-Type\r\n";
  }
  headers += "\r\n";
  // ONE write for headers + body. Two send() calls on a Nagle socket stall the second
  // segment until the peer's delayed ACK (40 ms measured with the window endpoint): the
  // frontend pages a result table, so that stall used to cost ~40 ms per page.
  // HEAD announces the length but sends no body (smoke test: a HEAD with a body desyncs
  // the next keep-alive request).
  if (!headersOnly) headers.append(payload);
  writeAll(fd, headers.data(), headers.size());
}

// Decode a DCM1/DCM2 frame body into columns (POST /api/matrices/raw). The codec itself
// lives in dc_core now (nodes.cpp) so the script card's data channel and the upload path
// share ONE implementation — docs/decisions/2026-11-15-python-script-card.md §五.
bool decodeMatrixFrame(const std::string& frame, std::vector<Column>* columns, std::string* err) {
  return decodeDcm2Frame(frame, columns, err, kMaxBodyBytes);
}

double cellValue(const Json& v, bool* ok) {
  *ok = true;
  if (v.isNumber()) return v.asNumber();
  if (v.isString()) {
    const std::string& s = v.asString();
    if (s == "NaN") return NAN;
    if (s == "Infinity") return INFINITY;
    if (s == "-Infinity") return -INFINITY;
  }
  *ok = false;
  return 0;
}

// /api/matrices/{id}[/suffix] → id + "/suffix" ("" when absent).
bool splitMatrixPath(const std::string& path, int64_t* id, std::string* suffix) {
  static const std::string prefix = "/api/matrices/";
  if (path.rfind(prefix, 0) != 0) return false;
  const std::string rest = path.substr(prefix.size());
  const size_t slash = rest.find('/');
  *id = parseId(rest.substr(0, slash));
  *suffix = slash == std::string::npos ? std::string() : rest.substr(slash);
  return true;
}

// ── POST /api/script/check ─────────────────────────────────────────────
//
// Compile-only syntax check plus the runner's static "impure" scan.
//
// THIS ENDPOINT NEVER EXECUTES THE SUBMITTED TEXT. The only thing it spawns is
// `runner.py --check <file>`, whose entire job is `compile(source, ..., ast.PyCF_ONLY_AST)`
// followed by an `ast.walk` scan (backend/runner/runner.py, `_check_mode`); the script is
// never imported and never eval/exec'd. There must never be a path in this file that runs
// the submitted bytes — that is the safety boundary of
// docs/decisions/2026-11-15-python-script-card.md §九, not a performance choice. The
// "does not execute" gate in tests/script_check_test.cpp holds it.
//
// The spawn follows the same discipline as runPythonChild (nodes.cpp), per line:
//   - cleared environment: PATH=/usr/bin:/bin and PYTHONPATH=<repo>/third_party/pylib only
//   - cwd = the scratch directory, never the server's working directory
//   - both sides setpgid, so the timeout kills the check AND anything it spawned
//   - the scratch directory (script + logs) is removed on every exit path, timeout included
// It is a small local spawn rather than another runPythonChild mode because the argv shape
// differs (--check takes the script path and nothing else) and runPythonChild is shaped
// around the --in/--out/--meta data channel.
//
// Envelope: 200 with {"ok":true,"lint":{"impure":[...]}} / {"ok":false,"error":{...}} for a
// verdict — the check saying "your script is broken" is not an HTTP failure. A malformed
// REQUEST (bad JSON, `script` missing or not a string) is a protocol error and keeps the
// global {"code":...} body, like every other endpoint.
constexpr int64_t kScriptCheckTimeoutMs = 10000;
// runner.py EXIT_SYNTAX (backend/runner/runner.py). The runner reports a syntax error as one
// JSON line on stderr and this exit code; no other exit code is a verdict.
constexpr int kRunnerCheckSyntaxExit = 6;
// The child does `_exit(127)` when execve fails: the interpreter is there as a file but
// cannot be started. Missing/non-executable python3 is the ONE condition that maps to
// runtimeMissing (a broken environment, not a broken script).
constexpr int kChildExecFailedExit = 127;
constexpr size_t kCheckLogReadCap = 64u * 1024u;

struct CheckPaths {
  std::filesystem::path dir;        // scratch directory = the child's cwd
  std::filesystem::path script;     // dir/script.py — the only thing the runner reads
  std::filesystem::path stdoutLog;  // dir/stdout.log (lint JSON)
  std::filesystem::path stderrLog;  // dir/stderr.log (syntax JSON / tracebacks)
  std::filesystem::path python;     // <runtime>/bin/python3
  std::filesystem::path runner;     // <repo>/backend/runner/runner.py
  std::filesystem::path pylib;      // <repo>/third_party/pylib
};

// Removes the check's scratch directory on every exit path (success, error, timeout).
struct CheckScratch {
  std::filesystem::path dir;
  ~CheckScratch() {
    if (dir.empty()) return;
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
  }
};

// mkdtemp on POSIX (0600 name, 0700 mode); a create-directory loop elsewhere. Never reuses
// the parent temp directory itself: the child runs with cwd = this directory.
bool makeCheckScratch(CheckScratch* scratch) {
  std::error_code ec;
  const std::filesystem::path parent = std::filesystem::temp_directory_path(ec);
  if (ec) return false;
#ifndef _WIN32
  for (int attempt = 0; attempt < 16; ++attempt) {
    std::string pattern = (parent / "dcchk-XXXXXX").string();
    std::vector<char> buffer(pattern.begin(), pattern.end());
    buffer.push_back('\0');
    if (::mkdtemp(buffer.data()) != nullptr) {
      scratch->dir = std::filesystem::path(buffer.data());
      return true;
    }
  }
  return false;
#else
  for (int attempt = 0; attempt < 64; ++attempt) {
    const std::filesystem::path candidate =
        parent / ("dcchk-" + std::to_string(::GetCurrentProcessId()) + "-" +
                  std::to_string(::GetTickCount64()) + "-" + std::to_string(attempt));
    if (std::filesystem::create_directory(candidate, ec)) {
      scratch->dir = candidate;
      return true;
    }
    ec.clear();
  }
  return false;
#endif
}

std::string readTextFileCapped(const std::filesystem::path& path, size_t maxBytes) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return std::string();
  std::string out(maxBytes, '\0');
  in.read(out.data(), static_cast<std::streamsize>(maxBytes));
  out.resize(static_cast<size_t>(in.gcount()));
  return out;
}

// runner.py writes exactly one protocol line, but the interpreter may prepend noise (warnings,
// a wrapper's chatter), so the first parseable line that starts with '{' is the protocol line.
Json firstJsonLine(const std::string& text) {
  size_t start = 0;
  while (start < text.size()) {
    size_t end = text.find('\n', start);
    if (end == std::string::npos) end = text.size();
    std::string line = text.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (!line.empty() && line.front() == '{') {
      Json parsed;
      std::string parseError;
      return Json::parse(line, &parsed, &parseError) ? parsed : Json();
    }
    start = end + 1;
  }
  return Json();
}

struct CheckSpawn {
  bool launched = false;
  int exitCode = -1;
  bool timedOut = false;
  std::string launchError;
};

#ifndef _WIN32

CheckSpawn runCheckChild(const CheckPaths& paths, int64_t timeoutMs) {
  CheckSpawn result;
  std::vector<std::string> argvStorage = {paths.python.string(), paths.runner.string(),
                                          "--check", paths.script.string()};
  std::vector<char*> argv;
  argv.reserve(argvStorage.size() + 1);
  for (std::string& arg : argvStorage) argv.push_back(const_cast<char*>(arg.c_str()));
  argv.push_back(nullptr);
  // PATH and PYTHONPATH are the only things the child inherits — the same cleared
  // environment a run gets (decision §五). The check does not need numpy, but keeping the
  // same environment means "passes the check, fails the run" cannot come from here.
  std::vector<std::string> envStorage = {
      "PATH=/usr/bin:/bin",
      "PYTHONPATH=" + paths.pylib.string(),
  };
  std::vector<char*> envp;
  envp.reserve(envStorage.size() + 1);
  for (std::string& kv : envStorage) envp.push_back(const_cast<char*>(kv.c_str()));
  envp.push_back(nullptr);
  const std::string stdoutPath = paths.stdoutLog.string();
  const std::string stderrPath = paths.stderrLog.string();
  const std::string cwd = paths.dir.string();
  char* const program = argv[0];

  const pid_t pid = ::fork();
  if (pid < 0) {
    result.launchError = "fork failed (errno " + std::to_string(errno) + ")";
    return result;
  }
  if (pid == 0) {
    // Child. async-signal-safe calls only from here on.
    ::setpgid(0, 0);  // own process group: the timeout kills the check and anything it spawned
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
    ::_exit(kChildExecFailedExit);
  }
  result.launched = true;
  // Both sides call setpgid (the standard idiom): until one of them runs, the group does not
  // exist and a timeout racing into kill(-pid) would hit ESRCH.
  ::setpgid(pid, 0);
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    int status = 0;
    const pid_t reaped = ::waitpid(pid, &status, WNOHANG);
    if (reaped == pid) {
      result.exitCode = WIFEXITED(status)
                            ? WEXITSTATUS(status)
                            : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      return result;
    }
    if (reaped < 0 && errno != EINTR) {
      result.launchError = "waitpid failed (errno " + std::to_string(errno) + ")";
      return result;
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      ::kill(static_cast<pid_t>(-pid), SIGKILL);
      while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
      }
      result.timedOut = true;
      return result;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}

#else  // _WIN32

CheckSpawn runCheckChild(const CheckPaths& paths, int64_t timeoutMs) {
  CheckSpawn result;
  const auto quote = [](const std::filesystem::path& p) { return L"\"" + p.wstring() + L"\""; };
  const std::wstring command = quote(paths.python) + L" " + quote(paths.runner) + L" --check " +
                               quote(paths.script);
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');

  // PATH + PYTHONPATH only (same cleared environment as a run).
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
  const std::wstring stdoutPath = paths.stdoutLog.wstring();
  const std::wstring stderrPath = paths.stderrLog.wstring();
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
  const std::wstring cwd = paths.dir.wstring();
  const BOOL started = ::CreateProcessW(
      paths.python.wstring().c_str(), commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
      environment.data(), cwd.c_str(), &startup, &process);
  if (handleIn != INVALID_HANDLE_VALUE) ::CloseHandle(handleIn);
  if (handleOut != INVALID_HANDLE_VALUE) ::CloseHandle(handleOut);
  if (handleErr != INVALID_HANDLE_VALUE) ::CloseHandle(handleErr);
  if (!started) {
    result.launchError = "CreateProcessW failed (error " +
                         std::to_string(static_cast<long long>(::GetLastError())) + ")";
    return result;
  }
  ::CloseHandle(process.hThread);
  result.launched = true;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    if (::WaitForSingleObject(process.hProcess, 5) == WAIT_OBJECT_0) break;
    if (std::chrono::steady_clock::now() >= deadline) {
      ::TerminateProcess(process.hProcess, 1);
      ::WaitForSingleObject(process.hProcess, 5000);
      result.timedOut = true;
      break;
    }
  }
  DWORD exitCode = 1;
  ::GetExitCodeProcess(process.hProcess, &exitCode);
  result.exitCode = static_cast<int>(exitCode);
  ::CloseHandle(process.hProcess);
  return result;
}

#endif  // _WIN32

// The endpoint's own verdict envelope: 200, {"ok":false,"error":{code,...}}.
HttpResponse checkVerdictFailed(const std::string& code, Json details = Json::object()) {
  Json error = Json::object({{"code", Json(code)}});
  for (const auto& member : details.members()) error.set(member.first, member.second);
  Json body = Json::object({{"ok", Json(false)}, {"error", std::move(error)}});
  return jsonOk(std::move(body));
}

HttpResponse handleScriptCheck(const HttpRequest& req) {
  Json parsed;
  std::string parseError;
  if (!Json::parse(req.body, &parsed, &parseError) || !parsed.isObject())
    return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(parseError)}}));
  const Json* script = parsed.find("script");
  if (script == nullptr || !script->isString()) return jsonError(400, "unexpectedToken");
  const std::string& source = script->asString();

  // Same interpreter resolution a run uses (nodes.h), so the two can never disagree about
  // "is there a runtime on this machine". The note is not forwarded: the verdict contract for
  // runtimeMissing has no detail field (the card's environment stamp is the explanation); the
  // out-parameter exists because resolvePythonRuntime reports WHY it found nothing.
  std::string runtimeNote;
  const std::string repo = findRepoRoot();
  const PythonRuntime runtime = resolvePythonRuntime(&runtimeNote);
  if (repo.empty() || runtime.python.empty()) return checkVerdictFailed("runtimeMissing");

  CheckPaths paths;
  paths.python = runtime.python;
  paths.runner = std::filesystem::path(repo) / "backend" / "runner" / "runner.py";
  paths.pylib = std::filesystem::path(repo) / "third_party" / "pylib";
  std::error_code ec;
  if (!std::filesystem::is_regular_file(paths.runner, ec))
    return checkVerdictFailed("runtimeMissing");

  CheckScratch scratch;
  if (!makeCheckScratch(&scratch))
    return checkVerdictFailed("internalError",
                              Json::object({{"detail", Json("cannot create a scratch directory")}}));
  paths.dir = scratch.dir;
  paths.script = paths.dir / "script.py";
  paths.stdoutLog = paths.dir / "stdout.log";
  paths.stderrLog = paths.dir / "stderr.log";
  {
    std::ofstream out(paths.script, std::ios::binary | std::ios::trunc);
    if (!out)
      return checkVerdictFailed(
          "internalError", Json::object({{"detail", Json("cannot write the temporary script")}}));
    out.write(source.data(), static_cast<std::streamsize>(source.size()));
    if (!out)
      return checkVerdictFailed(
          "internalError", Json::object({{"detail", Json("cannot write the temporary script")}}));
  }

  const CheckSpawn spawn = runCheckChild(paths, kScriptCheckTimeoutMs);
  if (!spawn.launched)
    return checkVerdictFailed("internalError", Json::object({{"detail", Json(spawn.launchError)}}));
  if (spawn.timedOut)
    return checkVerdictFailed(
        "internalError",
        Json::object({{"detail", Json("the check did not finish within " +
                                      std::to_string(kScriptCheckTimeoutMs) + " ms")}}));
  if (spawn.exitCode == kChildExecFailedExit) return checkVerdictFailed("runtimeMissing");
  if (spawn.exitCode == 126)
    return checkVerdictFailed(
        "internalError",
        Json::object({{"detail", Json("the check child could not enter its scratch directory")}}));

  const std::string stderrText = readTextFileCapped(paths.stderrLog, kCheckLogReadCap);
  if (spawn.exitCode == kRunnerCheckSyntaxExit) {
    // {"error":"syntax","line":N,"col":M,"msg":"..."} on stderr; the line/col are what the
    // editor jumps to, so they travel as numbers, never as prose.
    const Json structured = firstJsonLine(stderrText);
    const Json* line = structured.isObject() ? structured.find("line") : nullptr;
    const Json* col = structured.isObject() ? structured.find("col") : nullptr;
    if (line == nullptr || !line->isNumber() || col == nullptr || !col->isNumber())
      return checkVerdictFailed(
          "internalError",
          Json::object({{"detail", Json("the runner reported a syntax error without a "
                                        "position (stderr: " + stderrText.substr(0, 200) + ")")}}));
    const Json* msg = structured.find("msg");
    Json error = Json::object({{"code", Json("syntaxError")},
                               {"line", Json(static_cast<int64_t>(line->asNumber()))},
                               {"col", Json(static_cast<int64_t>(col->asNumber()))},
                               {"message", Json(msg != nullptr && msg->isString() ? msg->asString()
                                                                                  : std::string())}});
    Json body = Json::object({{"ok", Json(false)}, {"error", std::move(error)}});
    return jsonOk(std::move(body));
  }
  if (spawn.exitCode != 0)
    return checkVerdictFailed(
        "internalError",
        Json::object({{"detail", Json("the runner exited with " +
                                      std::to_string(spawn.exitCode) + " (stderr: " +
                                      stderrText.substr(0, 200) + ")")}}));

  // exit 0: stdout carries exactly one line, {"lint":{"impure":[...]}}. Pass the list through
  // untouched — the runner owns the rule, the transport only forwards it.
  const std::string stdoutText = readTextFileCapped(paths.stdoutLog, kCheckLogReadCap);
  const Json structured = firstJsonLine(stdoutText);
  const Json* lint = structured.isObject() ? structured.find("lint") : nullptr;
  const Json* impure = (lint != nullptr && lint->isObject()) ? lint->find("impure") : nullptr;
  if (impure == nullptr || !impure->isArray())
    return checkVerdictFailed(
        "internalError",
        Json::object({{"detail", Json("the runner produced no lint payload (stdout: " +
                                      stdoutText.substr(0, 200) + ")")}}));
  Json body = Json::object(
      {{"ok", Json(true)}, {"lint", Json::object({{"impure", *impure}})}});
  return jsonOk(std::move(body));
}

}  // namespace

std::string encodeMatrixFrame(const std::vector<std::vector<double>>& columns,
                              const std::vector<std::string>& names, size_t rows,
                              size_t totalRows, size_t totalCols) {
  // One implementation, in dc_core (nodes.cpp): the script card writes its input frames with
  // the same bytes this endpoint serves. docs/decisions/2026-11-15-python-script-card.md §五.
  return encodeDcm2Frame(columns, names, rows, totalRows, totalCols);
}

// ── routing ────────────────────────────────────────────────────────────

HttpResponse HttpServer::route(const HttpRequest& req) {
  auto qint = [&](const char* key, int64_t fallback) {
    auto it = req.query.find(key);
    return it == req.query.end() ? fallback : parseId(it->second);
  };

  if (req.path == "/api/hello") {
    Json caps = Json::array();
    caps.push(Json("expr.v1"));
    caps.push(Json("matrix.v1"));
    // v2 (cards/signatures) is additive on the wire, so `protocol` stays 1 — but a client
    // that NEEDS signatures has to be able to tell an old backend apart, otherwise it
    // would create nodes the server silently misinterprets (it would ignore `signatureId`
    // and evaluate an empty `formula`). Capabilities are that seam.
    caps.push(Json("signature.v1"));
    caps.push(Json("card.v2"));
    if (std::getenv("DC_ADVANCED_MATH") != nullptr) {
      const char* value = std::getenv("DC_ADVANCED_MATH");
      if (value[0] != '\0' && std::strcmp(value, "0") != 0)
        caps.push(Json("advanced-math.v1"));
    }
    Json limits = Json::object({{"maxWindowRows", Json(5000)}});
    return jsonOk(Json::object({{"protocol", Json(1)},
                                {"build", Json(std::string(DC_BUILD_SHA))},
                                {"capabilities", std::move(caps)},
                                {"limits", std::move(limits)}}));
  }

  // ── workspace trust (2026-11-17) ──────────────────────────────────────────────
  // The browser hashes the workspace FILE because it is the side that holds the bytes; this
  // store only records which hashes were blessed and which scripts inside were confirmed.
  // Nothing here executes anything: a record is permission, not a trigger.
  if (req.path.rfind("/api/trust", 0) == 0) {
    const std::string rest = req.path.substr(sizeof("/api/trust") - 1);
    if (trust_ == nullptr) return jsonError(503, "trustUnavailable");

    const auto statusBody = [&]() {
      const TrustStatus status = trust_->status();
      return Json::object({{"ok", Json(true)},
                           {"persistence", Json(status.persistence)},
                           {"location", Json(status.location)},
                           {"envId", Json(status.envId)},
                           {"envChanged", Json(status.envChanged)},
                           {"entries", Json(static_cast<int64_t>(status.entries))}});
    };
    const auto isHash = [](const std::string& text) {
      if (text.size() != 64) return false;
      for (const char c : text) {
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!hex) return false;
      }
      return true;
    };

    if (rest.empty() && req.method == "GET") return jsonOk(statusBody());
    if (rest == "/status" && req.method == "GET") return jsonOk(statusBody());
    if (rest == "/persistence" && req.method == "POST") {
      Json parsed;
      std::string error;
      if (!Json::parse(req.body, &parsed, &error)) {
        return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(error)}}));
      }
      const Json* persist = parsed.find("persist");
      if (persist == nullptr || (!persist->isBool() && !persist->isNumber())) {
        return jsonError(400, "unexpectedToken", Json::object({{"detail", Json("persist")}}));
      }
      const bool wanted = persist->isBool() ? persist->asBool() : persist->asNumber() != 0.0;
      if (!trust_->decidePersistence(wanted)) return jsonError(409, "trustUnavailable");
      return jsonOk(statusBody());
    }
    if (rest.empty() && req.method == "POST") {
      Json parsed;
      std::string error;
      if (!Json::parse(req.body, &parsed, &error)) {
        return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(error)}}));
      }
      const Json* hashJson = parsed.find("hash");
      if (hashJson == nullptr || !hashJson->isString() || !isHash(hashJson->asString())) {
        return jsonError(400, "badHash");
      }
      // Permission needs a decision first: recording without one would silently mean
      // "session only", which is exactly the ambiguity the first-run prompt exists to remove.
      if (trust_->status().persistence == "undecided") {
        return jsonError(409, "persistenceUndecided");
      }
      std::vector<std::string> scripts;
      const Json* scriptsJson = parsed.find("scripts");
      if (scriptsJson != nullptr && scriptsJson->isArray()) {
        for (const Json& script : scriptsJson->items()) {
          if (script.isString() && !script.asString().empty()) scripts.push_back(script.asString());
        }
      }
      if (!trust_->record(hashJson->asString(), scripts)) return jsonError(409, "trustUnavailable");
      Json recorded = Json::array();
      for (const auto& script : scripts) recorded.push(Json(script));
      return jsonOk(Json::object({{"ok", Json(true)},
                                  {"hash", Json(hashJson->asString())},
                                  {"scripts", std::move(recorded)}}));
    }
    if (rest.size() > 1) {
      const std::string hash = rest.substr(1);
      if (!isHash(hash)) return jsonError(400, "badHash");
      if (req.method == "GET") {
        const TrustLookup found = trust_->lookup(hash);
        Json scripts = Json::array();
        for (const auto& script : found.scripts) scripts.push(Json(script));
        return jsonOk(Json::object({{"ok", Json(true)},
                                    {"hash", Json(hash)},
                                    {"known", Json(found.known)},
                                    {"envMatch", Json(found.envMatch)},
                                    {"scripts", std::move(scripts)},
                                    {"persistence", Json(trust_->status().persistence)}}));
      }
      if (req.method == "DELETE") {
        return jsonOk(Json::object({{"ok", Json(true)},
                                    {"hash", Json(hash)},
                                    {"revoked", Json(trust_->revoke(hash))}}));
      }
    }
    return jsonError(404, "notFound");
  }

  if (req.path == "/api/matrices" && req.method == "POST") {
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    const Json& colsJson = parsed["columns"];
    if (!colsJson.isArray()) return jsonError(400, "unexpectedToken");
    std::vector<Column> columns;
    size_t rows = 0;
    for (const auto& cj : colsJson.items()) {
      Column col;
      col.posName = cj["posName"].isString() ? cj["posName"].asString()
                                             : "Pos." + std::to_string(columns.size() + 1);
      col.annotation = cj["annotation"].isString() ? cj["annotation"].asString() : "";
      const Json& data = cj["data"];
      if (!data.isArray()) return jsonError(400, "unexpectedToken");
      for (const auto& v : data.items()) {
        bool ok = false;
        const double value = cellValue(v, &ok);
        if (!ok) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json("bad cell value")}}));
        col.data.push_back(value);
      }
      if (columns.empty()) rows = col.data.size();
      else if (col.data.size() != rows) return jsonError(400, "shapeMismatch");
      columns.push_back(std::move(col));
    }
    Matrix m(std::move(columns));
    if (parsed["name"].isString()) m.name = parsed["name"].asString();
    int64_t id = store_->insert(std::move(m));
    bus_->publish(Json::object({{"matrixId", Json(static_cast<int64_t>(id))}, {"state", Json(std::string("done"))}}));
    nodes_->onMatrixChanged(id);
    return jsonOk(Json::object({{"matrixId", Json(static_cast<int64_t>(id))}, {"revision", Json(1)}}));
  }

  // POST /api/matrices/raw — a DCM1 frame body (protocol v1 "载荷编码"), avoids the JSON
  // overhead of the text endpoint for uploads parsed in the browser.
  if (req.path == "/api/matrices/raw" && req.method == "POST") {
    std::vector<Column> columns;
    std::string err;
    if (!decodeMatrixFrame(req.body, &columns, &err))
      return jsonError(400, "badFrame", Json::object({{"detail", Json(err)}}));
    size_t rows = 0;
    for (const auto& c : columns) {
      if (c.data.size() > rows) rows = c.data.size();
    }
    for (auto& c : columns) c.data.resize(rows, NAN);
    Matrix m(std::move(columns));
    m.name = "raw";
    int64_t id = store_->insert(std::move(m));
    bus_->publish(Json::object({{"matrixId", Json(static_cast<int64_t>(id))}, {"state", Json(std::string("done"))}}));
    nodes_->onMatrixChanged(id);
    return jsonOk(Json::object({{"matrixId", Json(static_cast<int64_t>(id))}, {"revision", Json(1)}}));
  }

  int64_t matrixId = -1;
  std::string matrixSuffix;
  const bool isMatrixPath = splitMatrixPath(req.path, &matrixId, &matrixSuffix);

  // GET /api/matrices/{id}/window?start=&count=  → binary DCM1 frame
  if (isMatrixPath && req.method == "GET" && matrixSuffix == "/window") {
    // One lock for shape + labels: the window response carries the FULL matrix shape, so a
    // client that asks for 100 rows still learns the table is 165 000 rows tall.
    std::vector<std::string> names;
    size_t shapeRows = 0;
    size_t shapeCols = 0;
    const bool found = store_->withMatrix(matrixId, [&](const Matrix& m) {
      shapeRows = m.rowCount();
      shapeCols = m.columnCount();
      names.clear();
      names.reserve(m.columnCount());
      for (const Column& col : m.columns()) names.push_back(Matrix::label(col));
    });
    if (!found)
      return jsonError(404, "unknownMatrix", Json::object({{"matrixId", Json(matrixId)}}));
    const int64_t start = qint("start", 0);
    int64_t count = qint("count", 500);
    count = std::min<int64_t>(std::max<int64_t>(0, count), 5000);
    std::vector<std::vector<double>> window;
    const size_t rows = store_->window(matrixId, static_cast<size_t>(std::max<int64_t>(0, start)),
                                       static_cast<size_t>(count), &window);
    HttpResponse res;
    res.status = 200;
    res.contentType = "application/octet-stream";
    res.binary = new std::string(encodeMatrixFrame(window, names, rows, shapeRows, shapeCols));
    return res;
  }

  // PATCH /api/matrices/{id} {cells:[{row,col,value}]} — browser cell edits.
  if (isMatrixPath && req.method == "PATCH" && matrixSuffix.empty()) {
    if (matrixId < 0) return jsonError(400, "unexpectedToken");
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err))
      return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    const Json& cells = parsed["cells"];
    if (!cells.isArray()) return jsonError(400, "unexpectedToken");
    std::vector<CellPatch> patches;
    patches.reserve(cells.items().size());
    for (const auto& cj : cells.items()) {
      if (!cj["row"].isNumber() || !cj["col"].isNumber()) return jsonError(400, "unexpectedToken");
      const double row = cj["row"].asNumber();
      const double col = cj["col"].asNumber();
      if (row < 0 || col < 0) return jsonError(400, "shapeMismatch");
      bool ok = false;
      const double value = cellValue(cj["value"], &ok);
      if (!ok) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json("bad cell value")}}));
      CellPatch patch;
      patch.row = static_cast<size_t>(row);
      patch.col = static_cast<size_t>(col);
      patch.value = value;
      patches.push_back(patch);
    }
    int64_t revision = 0;
    if (!store_->patchCells(matrixId, patches, &revision)) {
      Matrix probe;
      if (!store_->snapshot(matrixId, &probe))
        return jsonError(404, "unknownMatrix", Json::object({{"matrixId", Json(matrixId)}}));
      return jsonError(400, "shapeMismatch");
    }
    bus_->publish(Json::object({{"matrixId", Json(matrixId)}, {"revision", Json(revision)}}));
    // A cell edit is a content change like any other: every node reading this matrix has
    // to recompute. The insert path always did this; the PATCH path was missing it, so an
    // edited table left its function card showing the pre-edit numbers.
    nodes_->onMatrixChanged(matrixId);
    return jsonOk(Json::object({{"matrixId", Json(matrixId)}, {"revision", Json(revision)}}));
  }

  // DELETE /api/matrices/{id} — refused while a compute node still reads or owns it.
  if (isMatrixPath && req.method == "DELETE" && matrixSuffix.empty()) {
    bool hadDependents = false;
    if (!nodes_->removeMatrix(matrixId, &hadDependents)) {
      return jsonError(hadDependents ? 409 : 404,
                       hadDependents ? "hasDependents" : "unknownMatrix",
                       Json::object({{"matrixId", Json(matrixId)}}));
    }
    bus_->publish(Json::object({{"matrixId", Json(matrixId)}, {"deleted", Json(true)}}));
    return jsonOk(Json::object({{"deleted", Json(matrixId)}}));
  }

  // GET /api/signatures — every function signature this backend can evaluate.
  // docs/architecture/port-semantics-v1.md: a signature is the shape of a function card;
  // built-ins register today, plugin implementations will register into the same table.
  if (req.path == "/api/signatures" && req.method == "GET") {
    Json list = Json::array();
    for (const FunctionSignature* sig : allSignatures()) {
      Json inputs = Json::array();
      for (const auto& port : sig->inputs) {
        inputs.push(Json::object({{"portId", Json(port.portId)},
                                  {"displayName", Json(port.displayName)},
                                  {"required", Json(port.required)}}));
      }
      Json outputs = Json::array();
      for (const auto& output : sig->outputs) outputs.push(Json::object({{"outputId", Json(output.outputId)}}));
      list.push(Json::object({{"id", Json(sig->id)},
                              {"version", Json(sig->version)},
                              {"displayName", Json(sig->displayName)},
                              // "auto": evaluated at creation (every signature before
                              // 2026-10-27). "explicit": created uncomputed; the client
                              // must POST /api/nodes/{id}/compute to get numbers. Without
                              // this field a client would render an empty table as data.
                              {"compute", Json(std::string(sig->explicitCompute ? "explicit" : "auto"))},
                              {"inputs", std::move(inputs)},
                              {"outputs", std::move(outputs)}}));
    }
    return jsonOk(Json::object({{"signatures", std::move(list)}}));
  }

  // POST /api/script/check — compile-only check for a script card. Never executes the text;
  // see the long note above handleScriptCheck (and decisions doc §九).
  if (req.path == "/api/script/check" && req.method == "POST")
    return handleScriptCheck(req);

  // GET /api/nodes — the ids of every live compute node. Lets a client reconcile a
  // restored workspace against the server's authoritative set (protocol v1, additive).
  if (req.path == "/api/nodes" && req.method == "GET") {
    Json arr = Json::array();
    for (int64_t id : nodes_->allNodeIds()) arr.push(Json(id));
    return jsonOk(Json::object({{"nodes", std::move(arr)}}));
  }

  if (req.path == "/api/nodes" && req.method == "POST") {
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    std::vector<PortBinding> inputs;
    for (const auto& ij : parsed["inputs"].items()) {
      PortBinding b;
      b.portId = ij["portId"].isString() ? ij["portId"].asString() : "";
      b.varName = ij["varName"].isString() ? ij["varName"].asString() : "";
      b.mode = ij["mode"].isString() ? ij["mode"].asString() : "cell";
      if (ij["sourceNodeId"].isNumber()) b.sourceNodeId = static_cast<int64_t>(ij["sourceNodeId"].asNumber());
      if (ij["sourceMatrixId"].isNumber()) b.sourceMatrixId = static_cast<int64_t>(ij["sourceMatrixId"].asNumber());
      if (ij["sourceOutputIndex"].isNumber()) b.sourceOutputIndex = static_cast<int32_t>(ij["sourceOutputIndex"].asNumber());
      if (ij["columnIndex"].isNumber()) b.columnIndex = static_cast<int32_t>(ij["columnIndex"].asNumber());
      inputs.push_back(std::move(b));
    }
    std::string formula = parsed["formula"].isString() ? parsed["formula"].asString() : "";
    // v2: a signature-driven node carries its parameters in `params` (never in inputs).
    const std::string signatureId =
        parsed["signatureId"].isString() ? parsed["signatureId"].asString() : "";
    const Json params = parsed["params"].isObject() ? parsed["params"] : Json::object();
    auto result = signatureId.empty() ? nodes_->create(inputs, formula)
                                      : nodes_->createV2(signatureId, inputs, params);
    if (!result.errorCode.empty())
      return jsonError(400, result.errorCode,
                       Json::object({{"signatureId", Json(signatureId)}}));
    if (!result.cyclePath.empty()) {
      Json path = Json::array();
      for (auto p : result.cyclePath) path.push(Json(p));
      return jsonError(409, "cycle", Json::object({{"path", std::move(path)}}));
    }
    if (result.nodeId < 0) return jsonError(400, "unexpectedToken");
    nodes_->recomputeSubtree(result.nodeId);
    const auto node = nodes_->get(result.nodeId);
    Json out = Json::object({{"nodeId", Json(result.nodeId)},
                             {"resultMatrixId", Json(node ? node->resultMatrixId() : int64_t{-1})},
                             {"state", Json(std::string(node ? nodeName(node->state) : "dirty"))}});
    if (node && !node->signatureId.empty()) out.set("signatureId", Json(node->signatureId));
    if (node) {
      Json ids = Json::array();
      for (int64_t id : node->resultMatrixIds) ids.push(Json(id));
      out.set("resultMatrixIds", std::move(ids));
      // A lazy signature comes back dirty on purpose: `reason` is how the client tells
      // "you have not asked me to compute yet" from "your upstream changed".
      if (node->state == NodeState::Dirty)
        out.set("reason", Json(std::string(dirtyReasonName(node->dirtyReason))));
      if (!node->warnings.items().empty()) out.set("warnings", node->warnings);
    }
    return jsonOk(std::move(out));
  }

  if (req.path.rfind("/api/nodes/", 0) == 0) {
    const std::string rest = req.path.substr(sizeof("/api/nodes/") - 1);
    const size_t slash = rest.find('/');
    const int64_t id = parseId(rest.substr(0, slash));
    const std::string suffix = slash == std::string::npos ? std::string() : rest.substr(slash);
    if (id < 0) return jsonError(400, "unexpectedToken");
    const auto existing = nodes_->get(id);
    if (!existing) return jsonError(404, "unknownNode", Json::object({{"nodeId", Json(static_cast<int64_t>(id))}}));

    // GET /api/nodes/{id} — the node's authoritative status snapshot. The event stream is
    // transient (bounded log), so a client that reconnects or restores a workspace needs
    // to re-read state without replaying it (protocol v1, additive).
    if (suffix.empty() && req.method == "GET") {
      Json out = Json::object({{"nodeId", Json(existing->id)},
                               {"state", Json(std::string(nodeName(existing->state)))},
                               {"resultMatrixId", Json(existing->resultMatrixId())}});
      // Declared outputs beyond output 0 (builtin:python): their stored matrices, so a
      // client can read them without a second kind of node. Empty for every other
      // signature, which is why nothing outside the script card sees a new field.
      if (!existing->extraOutputs.items().empty())
        out.set("extraOutputs", existing->extraOutputs);
      if (existing->state == NodeState::Dirty)
        out.set("reason", Json(std::string(dirtyReasonName(existing->dirtyReason))));
      // Additive advice (unit warnings). Absent when there is nothing to report, so a clean
      // card's DTO is byte-identical to what it was before warnings existed.
      if (!existing->warnings.items().empty()) out.set("warnings", existing->warnings);
      if (existing->state == NodeState::Error) {
        out.set("code", Json(existing->errorCode));
        out.set("params", existing->errorParams);
      }
      return jsonOk(std::move(out));
    }

    if (suffix.empty() && req.method == "PATCH") {
      Json parsed;
      std::string err;
      if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
      std::vector<PortBinding> inputs;
      bool haveInputs = parsed["inputs"].isArray();
      if (haveInputs) {
        for (const auto& ij : parsed["inputs"].items()) {
          PortBinding b;
          b.portId = ij["portId"].isString() ? ij["portId"].asString() : "";
          b.varName = ij["varName"].isString() ? ij["varName"].asString() : "";
          b.mode = ij["mode"].isString() ? ij["mode"].asString() : "cell";
          if (ij["sourceNodeId"].isNumber()) b.sourceNodeId = static_cast<int64_t>(ij["sourceNodeId"].asNumber());
          if (ij["sourceMatrixId"].isNumber()) b.sourceMatrixId = static_cast<int64_t>(ij["sourceMatrixId"].asNumber());
          if (ij["sourceOutputIndex"].isNumber()) b.sourceOutputIndex = static_cast<int32_t>(ij["sourceOutputIndex"].asNumber());
          if (ij["columnIndex"].isNumber()) b.columnIndex = static_cast<int32_t>(ij["columnIndex"].asNumber());
          inputs.push_back(std::move(b));
        }
      }
      const std::string* formula = parsed["formula"].isString() ? &parsed["formula"].asString() : nullptr;
      const bool haveParams = parsed["params"].isObject();
      // Params commit atomically with inputs: when the PATCH carries an inputs array they ride
      // into update() and are applied only after the cycle check passes, so a refused (409)
      // PATCH leaves the parameter bag and definitionVersion untouched. A params-only PATCH
      // (no inputs array) keeps the updateParams path.
      if (!haveInputs && haveParams) nodes_->updateParams(id, parsed["params"]);
      std::vector<int64_t> cycleOut;
      if (!nodes_->update(id, formula, haveInputs ? &inputs : nullptr, &cycleOut,
                          haveInputs && haveParams ? &parsed["params"] : nullptr)) {
        if (!cycleOut.empty()) {
          Json path = Json::array();
          for (auto p : cycleOut) path.push(Json(p));
          return jsonError(409, "cycle", Json::object({{"path", std::move(path)}}));
        }
        return jsonError(404, "unknownNode");
      }
      nodes_->recomputeSubtree(id);
      const auto node = nodes_->get(id);
      Json patched = Json::object({{"nodeId", Json(static_cast<int64_t>(id))},
                                   {"state", Json(std::string(node ? nodeName(node->state) : "dirty"))}});
      if (node && !node->warnings.items().empty()) patched.set("warnings", node->warnings);
      return jsonOk(std::move(patched));
    }

    if (suffix.empty() && req.method == "DELETE") {
      bool hadDependents = false;
      if (!nodes_->remove(id, &hadDependents)) {
        return jsonError(hadDependents ? 409 : 404, hadDependents ? "hasDependents" : "unknownNode");
      }
      return jsonOk(Json::object({{"deleted", Json(static_cast<int64_t>(id))}}));
    }

    if (suffix == "/compute" && req.method == "POST") {
      // The ONE trigger for `explicitCompute` signatures (builtin:summary). Deliberately
      // not folded into PATCH (an edit is not a compute request) and never into a GET
      // (reconnect/polling paths read status; they must not spend compute).
      nodes_->computeNow(id);
      const auto node = nodes_->get(id);
      if (!node) return jsonError(404, "unknownNode", Json::object({{"nodeId", Json(static_cast<int64_t>(id))}}));
      Json ids = Json::array();
      for (int64_t matrixId : node->resultMatrixIds) ids.push(Json(matrixId));
      Json out = Json::object({{"nodeId", Json(static_cast<int64_t>(id))},
                               {"state", Json(std::string(nodeName(node->state)))},
                               {"resultMatrixIds", std::move(ids)}});
      if (!node->extraOutputs.items().empty()) out.set("extraOutputs", node->extraOutputs);
      if (!node->warnings.items().empty()) out.set("warnings", node->warnings);
      if (node->state == NodeState::Error) {
        out.set("code", Json(node->errorCode));
        out.set("params", node->errorParams);
      }
      return jsonOk(std::move(out));
    }

    if (suffix == "/accuracy" && req.method == "POST") {
      // On demand only: never on the result path, never a state change, never an event.
      // "unsupported" is a first-class answer — the caller must render nothing for it, so
      // that "not measured" can never read as "measured and fine".
      const AccuracyReport report = checkAccuracy(nodes_, store_, id);
      Json out = Json::object({{"nodeId", Json(static_cast<int64_t>(id))},
                               {"status", Json(report.status)}});
      if (!report.reason.empty()) out.set("reason", Json(report.reason));
      if (report.status != "unsupported") {
        out.set("relativeGap", Json(report.relativeGap));
        out.set("digits", Json(report.digits));
        out.set("digitsLost", Json(report.digitsLost));
      }
      return jsonOk(std::move(out));
    }

    if (suffix == "/cancel" && req.method == "POST") {
      // A script-card run is a real child process (builtin:python), so cancel is real: it
      // kills the process group through the same path the timeout uses. With nothing
      // running the v1 answer is unchanged, so no client contract moved.
      if (!nodes_->cancelRun(id))
        return jsonError(409, "notImplemented",
                         Json::object({{"detail", Json("no running job to cancel")}}));
      return jsonOk(Json::object({{"nodeId", Json(static_cast<int64_t>(id))},
                                  {"cancelled", Json(true)}}));
    }

    if (suffix == "/result") {
      const auto node = nodes_->get(id);
      if (!node) return jsonError(404, "unknownNode", Json::object({{"nodeId", Json(static_cast<int64_t>(id))}}));
      std::vector<std::string> names;
      size_t shapeRows = 0;
      size_t shapeCols = 0;
      const bool found = store_->withMatrix(node->resultMatrixId(), [&](const Matrix& m) {
        shapeRows = m.rowCount();
        shapeCols = m.columnCount();
        names.clear();
        names.reserve(m.columnCount());
        for (const Column& col : m.columns()) names.push_back(Matrix::label(col));
      });
      if (!found) return jsonError(404, "unknownMatrix");
      const int64_t start = qint("start", 0);
      int64_t count = qint("count", 500);
      count = std::min<int64_t>(std::max<int64_t>(0, count), 5000);
      std::vector<std::vector<double>> window;
      const size_t rows = store_->window(node->resultMatrixId(), static_cast<size_t>(std::max<int64_t>(0, start)),
                                         static_cast<size_t>(count), &window);
      HttpResponse res;
      res.status = 200;
      res.contentType = "application/octet-stream";
      res.binary = new std::string(encodeMatrixFrame(window, names, rows, shapeRows, shapeCols));
      return res;
    }
  }

  if (req.path == "/api/events") {
    int64_t since = qint("since", 0);
    int64_t timeout = qint("timeout", 25);
    auto events = bus_->wait(since, static_cast<int>(std::min(std::max(timeout, INT64_C(1)), INT64_C(60)) * 1000));
    Json arr = Json::array();
    for (const auto& e : events) {
      Json ev = e.second;
      ev.set("seq", Json(e.first));
      arr.push(std::move(ev));
    }
    return jsonOk(std::move(arr));
  }

  // Packaged front end. Declined here, the JSON 404 stays: a mistyped /api path should stay
  // machine-readable instead of silently turning into index.html.
  {
    HttpResponse res;
    if (serveStatic(req, &res)) return res;
  }

  return jsonError(404, "notImplemented");
}

// Serves the packaged front end. Runs only after every /api route has declined, so it can
// never shadow the protocol. Two ways to answer:
//   1. the requested file exists under webRoot_ (allow-listed extension, stays inside root)
//   2. otherwise a non-API GET/HEAD falls back to index.html — the SPA router owns the path,
//      which is what makes refresh / deep links work
bool HttpServer::serveStatic(const HttpRequest& req, HttpResponse* res) {
  if (webRoot_.empty()) return false;
  if (req.method != "GET" && req.method != "HEAD") return false;
  if (req.path.rfind("/api/", 0) == 0 || req.path == "/api") return false;
  // A traversal probe gets a 404, never the SPA's index.html: a 200 would read as "that path
  // exists". The file rules still apply on top of this.
  if (!isSafeUrlPath(req.path)) return false;

  std::string file = resolveStaticPath(webRoot_, req.path);
  if (file.empty()) {
    // A missing *asset* must fail as a missing asset. Answering /assets/stale-hash.js with
    // index.html makes the browser report a confusing syntax error instead of a 404.
    if (isAllowedStaticExtension(req.path)) return false;
    if (!hasIndex(webRoot_)) return false;
    file = resolveStaticPath(webRoot_, "/");
    if (file.empty()) return false;
  }
  std::string body;
  if (!readFileBinary(file, &body)) return false;
  res->status = 200;
  res->contentType = contentTypeFor(file);
  res->body = std::move(body);
  res->binary = nullptr;
  return true;
}

// ── socket plumbing ────────────────────────────────────────────────────

bool HttpServer::serve() {
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
#endif
  socket_t srv = socket(AF_INET, SOCK_STREAM, 0);
  if (srv == (socket_t)(-1)) return false;
  int one = 1;
  setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&one), sizeof one);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<uint16_t>(port_));
  if (bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
    dc_close_socket(srv);
    return false;
  }
  if (listen(srv, 64) < 0) {
    dc_close_socket(srv);
    return false;
  }
  if (onReady_) onReady_();
  while (true) {
    socket_t fd = accept(srv, nullptr, nullptr);
    if (fd == (socket_t)(-1)) continue;
    // Nagle off: responses are small control messages, and the client reads them serially.
    // Batching here buys nothing and costs one delayed-ACK round trip per request.
    int nodelay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof nodelay);
    std::thread([this, fd] { handleConnection(fd); }).detach();
  }
}

void HttpServer::handleConnection(socket_t fd) {
  HttpRequest req;
  OriginHeader origin;
  std::string pending;  // connection-owned read buffer: pipelined bytes survive across requests
  for (;;) {
    const ReadStatus status = readRequest(fd, &req, &origin, &pending);
    if (status == ReadStatus::Closed) break;
    if (status == ReadStatus::BadRequest || status == ReadStatus::TooLarge) {
      // Framing is unusable; answer once and drop the connection instead of looping. The
      // Origin may be the part that failed to parse, so this one carries no CORS headers.
      HttpResponse res = status == ReadStatus::TooLarge ? jsonError(413, "payloadTooLarge")
                                                        : jsonError(400, "unexpectedToken");
      sendResponse(fd, res, false, std::string());
      break;
    }
    const OriginDecision gate = decideOrigin(origin);
    if (gate.gate == OriginGate::Forbidden) {
      // A page from another origin asked for the answer: refuse the request outright. It
      // cannot read this either (no CORS headers), so nothing leaks — and the refusal does
      // not say whether the path, method or body would otherwise have been valid.
      HttpResponse res = jsonError(403, "forbiddenOrigin");
      sendResponse(fd, res, false, std::string());
      continue;
    }
    if (req.method == "OPTIONS") {
      // Preflight: answer before routing, for any path, because the browser is asking who
      // may call what — the real request still has to pass route() afterwards. An OPTIONS
      // without Origin keeps the non-browser shape: 204 and no CORS headers.
      HttpResponse res;
      res.status = 204;
      res.contentType = "text/plain";
      sendResponse(fd, res, false, gate.echo);
      continue;
    }
    HttpResponse res;
    try {
      res = route(req);
    } catch (const std::exception&) {
      res = jsonError(500, "internalError");
    } catch (...) {
      res = jsonError(500, "internalError");
    }
    const bool headersOnly = req.method == "HEAD";
    sendResponse(fd, res, headersOnly, gate.echo);
    if (headersOnly) break;
  }
  dc_close_socket(fd);
}

}  // namespace dc
