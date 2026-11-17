// Minimal HTTP client for the in-process server tests: dial 127.0.0.1, send one raw
// request, parse one response. Deliberately dependency-free (no curl, no libs), because the
// test binary must run on a bare Windows/macOS/Linux runner with nothing but a compiler.
//
// Extracted for the route-contract tests added with trust/events. origin_gate_test.cpp,
// script_check_test.cpp and xlayer_fixture_node_test.cpp carry their own copies of these
// helpers from before this header existed; adopting it there is a separate, mechanical
// change and is not done here to keep this diff about coverage.
//
// Reading rules that matter:
//   * a receive timeout turns a half-written response into a failed CHECK, never a hung run;
//   * Content-Length is mandatory (the server always sends it), so a response without one is
//     a failure of its own rather than an excuse to read until the socket closes;
//   * the connection is closed after one response — a stale Content-Length must not be able
//     to stall the next case.
#pragma once

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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

namespace dctest {

struct Response {
  int status = 0;
  std::map<std::string, std::string> headers;  // names lowercased
  std::string body;
};

inline bool headerPresent(const Response& res, const std::string& name) {
  return res.headers.find(name) != res.headers.end();
}

inline std::string headerValue(const Response& res, const std::string& name) {
  const auto it = res.headers.find(name);
  return it == res.headers.end() ? std::string() : it->second;
}

inline std::string toLower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

inline std::string trimmed(std::string s) {
  size_t begin = 0;
  while (begin < s.size() && (s[begin] == ' ' || s[begin] == '\t')) ++begin;
  size_t end = s.size();
  while (end > begin && (s[end - 1] == ' ' || s[end - 1] == '\t')) --end;
  return s.substr(begin, end - begin);
}

/** Winsock has to be up before the first socket() call; a no-op elsewhere. */
inline bool initSockets() {
#ifdef _WIN32
  WSADATA wsa;
  return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
#else
  return true;
#endif
}

/**
 * A peer that closes early must fail a CHECK, not kill the process.
 *
 * SIGPIPE exists on POSIX only; on Windows the closed peer shows up as a failed
 * send()/recv(), which the CHECK catches anyway.
 */
inline void ignoreSigpipe() {
#ifdef SIGPIPE
  std::signal(SIGPIPE, SIG_IGN);
#endif
}

inline dc::socket_t dialLoopback(int port) {
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

inline bool sendAll(dc::socket_t fd, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    const int n = static_cast<int>(::send(fd, data.data() + sent, data.size() - sent, 0));
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

/** One complete request/response on its own connection. */
inline bool sendRequest(int port, const std::string& raw, Response* out) {
  *out = Response();  // a stale Content-Length from the previous case would stall the read
  const dc::socket_t fd = dialLoopback(port);
  if (fd == static_cast<dc::socket_t>(-1)) return false;
#ifdef _WIN32
  const DWORD timeoutMs = 10000;  // a long-poll of `timeout=1` must not trip this
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeoutMs),
             static_cast<int>(sizeof timeoutMs));
#else
  timeval timeout{};
  timeout.tv_sec = 10;
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

/** A port the OS says is free. The listener still races another process for it. */
inline int pickEphemeralPort() {
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

/** The accept loop starts in a detached thread, so readiness is observed by connecting. */
inline bool waitForListen(int port, const std::atomic<bool>& bindFailed) {
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

/**
 * origin == "" means the header is absent (a non-browser client); pass "\r\nOrigin:" for an
 * empty header value.
 */
inline std::string buildRequest(const std::string& method, const std::string& path,
                                const std::string& origin,
                                const std::string& body = std::string()) {
  std::string raw = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  if (!origin.empty()) raw += "Origin: " + origin + "\r\n";
  if (!body.empty()) raw += "Content-Type: application/json\r\n";
  raw += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  raw += "\r\n";
  raw += body;
  return raw;
}

/**
 * Port of a request/response pair, or 0 when the exchange itself failed (the caller then
 * reports a failure instead of asserting on an uninitialised status).
 */
inline int statusOf(int port, const std::string& raw, Response* out) {
  if (!sendRequest(port, raw, out)) return 0;
  return out->status;
}

}  // namespace dctest
