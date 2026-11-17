// Golden fixtures, LAYER 2/3 (node): the same five cases replayed through the REAL HTTP
// surface — upload the input frame, create a `builtin:python` card, compute it, read the
// result frame back — and compared byte for byte (with the lead's names exemption).
//
// Why this layer exists: `python_node_test.cpp` drives NodeRegistry directly and the runner
// test drives runner.py directly. Neither sees the seams between them: DCM2 framing on the
// upload route, params validation of a card built from a JSON request, the compute trigger,
// the result/window encoders, and the manifest→extraOutputs plumbing. A card can be correct
// at both ends and still lose a column of numbers in one of those seams — a differential
// fixture over the wire is the only gate that fails when the bytes change shape.
//
// ── comparison rule (lead's ruling, 2026-11-15) ───────────────────────────────────────────
// Python's `json.dumps` writes the names array as `["Pos.1", "Pos.2"]` (space after the
// comma) while C++ `encodeDcm2Frame` writes the compact `["Pos.1","Pos.2"]`. Both are legal
// "names UTF-8 JSON array" payloads, so the names SEGMENT is compared semantically. That
// also means the header's namesLen field (bytes 12..16) legitimately differs, and it is the
// one header field this test does NOT compare — everything else is strict:
//
//   * magic, rows, cols, totalRows, totalCols — field by field, explicit messages;
//   * the data segment, bytes [24, 24 + rows*cols*8) — memcmp, byte for byte;
//   * the names segment — parsed as JSON, same length, same strings in the same order;
//   * every declared extra output — its `extraOutputs` entry (name/rows/cols) must match the
//     `expected/out.manifest.json` entry, and the matrix behind its runtime `matrixId` must
//     reproduce `expected/out.N.dcm2` under the same frame rule.
//
// A mismatch prints the first differing byte OFFSET, not just "different": a shifted payload
// and a wrong numbers block look identical in a summary line.
//
// It needs third_party/pyruntime (bash scripts/fetch-python-runtime.sh). Without it the test
// prints SKIP and exits 0, exactly like python_node_test.cpp and script_check_test.cpp:
// "not applicable" and "verified" must not look the same, and a machine that never
// provisioned the runtime must not fail the suite.
//
// The server runs in-process on an ephemeral port (never 37811, where the installed service
// may be listening) — same harness as script_check_test.cpp.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
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
#  include <csignal>
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

#define CHECK_MSG(cond, ...)                                      \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d %s | ", __FILE__, __LINE__, #cond); \
      std::printf(__VA_ARGS__);                                   \
      std::printf("\n");                                          \
      ++failures;                                                 \
    }                                                             \
  } while (0)

// ── HTTP over a loopback socket ─────────────────────────────────────────

struct Response {
  int status = 0;
  std::string contentType;
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
      // Header names are lowercased on the way in: the server writes "Content-Length" and
      // looking that up case-sensitively is how a passing response reads as a transport
      // error.
      std::map<std::string, std::string> headers;
      size_t pos = head.find("\r\n");
      pos = pos == std::string::npos ? std::string::npos : pos + 2;
      while (pos != std::string::npos && pos < head.size()) {
        size_t end = head.find("\r\n", pos);
        if (end == std::string::npos) end = head.size();
        const std::string line = head.substr(pos, end - pos);
        const size_t colon = line.find(':');
        if (colon != std::string::npos) {
          const std::string name = toLower(trimmed(line.substr(0, colon)));
          if (headers.find(name) == headers.end())
            headers[name] = trimmed(line.substr(colon + 1));
        }
        pos = end < head.size() ? end + 2 : std::string::npos;
      }
      const auto typeIt = headers.find("content-type");
      if (typeIt != headers.end()) out->contentType = typeIt->second;
      // Content-Length delimits a binary frame body. A missing one is a protocol defect,
      // not something to paper over by reading until close.
      size_t want = 0;
      bool numeric = false;
      const auto lengthIt = headers.find("content-length");
      if (lengthIt != headers.end() && !lengthIt->second.empty()) {
        numeric = true;
        for (const char c : lengthIt->second) {
          if (c < '0' || c > '9') {
            numeric = false;
            break;
          }
          want = want * 10 + static_cast<size_t>(c - '0');
        }
      }
      if (!numeric) {
        ok = false;
      } else {
        const size_t bodyStart = headEnd + 4;
        while (buf.size() < bodyStart + want) {
          char chunk[4096];
          const int n = static_cast<int>(::recv(fd, chunk, sizeof chunk, 0));
          if (n <= 0) {
            ok = false;
            break;
          }
          buf.append(chunk, static_cast<size_t>(n));
        }
        if (ok) out->body = buf.substr(bodyStart, want);
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
                         const std::string& body, const std::string& contentType) {
  std::string raw = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  if (!body.empty()) raw += "Content-Type: " + contentType + "\r\n";
  raw += "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n";
  raw += body;
  return raw;
}

// ── fixture files ──────────────────────────────────────────────────────

bool readFileBytes(const std::filesystem::path& path, std::string* out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  *out = std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return true;
}

bool readJsonFile(const std::filesystem::path& path, dc::Json* out, std::string* err) {
  std::string text;
  if (!readFileBytes(path, &text)) {
    *err = "cannot read " + path.string();
    return false;
  }
  return dc::Json::parse(text, out, err);
}

// The cases are directories; README.md sits beside them and is not one.
std::vector<std::string> listCases(const std::filesystem::path& fixtures) {
  std::vector<std::string> names;
  std::error_code ec;
  for (const auto& entry : std::filesystem::directory_iterator(fixtures, ec)) {
    if (!entry.is_directory()) continue;
    const std::string name = entry.path().filename().string();
    if (name.size() > 3 && name[0] >= '0' && name[0] <= '9' && name[1] >= '0' &&
        name[1] <= '9' && name[2] == '-')
      names.push_back(name);
  }
  std::sort(names.begin(), names.end());
  return names;
}

std::vector<std::string> listFiles(const std::filesystem::path& dir) {
  std::vector<std::string> names;
  std::error_code ec;
  for (const auto& entry : std::filesystem::directory_iterator(dir, ec))
    if (entry.is_regular_file()) names.push_back(entry.path().filename().string());
  std::sort(names.begin(), names.end());
  return names;
}

// ── DCM2 frames and the comparison rule ────────────────────────────────

constexpr uint32_t kDcm2Magic = 0x44434D32u;
constexpr size_t kDcm2Header = 24;

uint32_t readU32(const std::string& bytes, size_t offset) {
  const auto* p = reinterpret_cast<const unsigned char*>(bytes.data() + offset);
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

struct Frame {
  uint32_t rows = 0;
  uint32_t cols = 0;
  uint32_t namesLen = 0;
  uint32_t totalRows = 0;
  uint32_t totalCols = 0;
  std::string bytes;  // the whole frame, as received
  std::string names;  // the names segment (JSON text)
  size_t dataLen() const { return static_cast<size_t>(rows) * cols * 8u; }
  size_t dataEnd() const { return kDcm2Header + dataLen(); }
};

bool parseFrame(const std::string& bytes, Frame* out, std::string* err) {
  if (bytes.size() < kDcm2Header) {
    *err = "frame is " + std::to_string(bytes.size()) + " bytes, shorter than the header";
    return false;
  }
  if (readU32(bytes, 0) != kDcm2Magic) {
    *err = "magic is not DCM2 ('2MCD' bytes expected)";
    return false;
  }
  out->rows = readU32(bytes, 4);
  out->cols = readU32(bytes, 8);
  out->namesLen = readU32(bytes, 12);
  out->totalRows = readU32(bytes, 16);
  out->totalCols = readU32(bytes, 20);
  out->bytes = bytes;
  const size_t expected = kDcm2Header + static_cast<size_t>(out->rows) * out->cols * 8u +
                          out->namesLen;
  if (bytes.size() != expected) {
    *err = "length " + std::to_string(bytes.size()) + " != 24 + " +
           std::to_string(out->rows) + "*" + std::to_string(out->cols) + "*8 + " +
           std::to_string(out->namesLen);
    return false;
  }
  out->names = bytes.substr(out->dataEnd());
  return true;
}

std::string byteAt(const std::string& bytes, size_t offset) {
  if (offset >= bytes.size()) return "end-of-frame";
  char buf[8];
  std::snprintf(buf, sizeof buf, "0x%02x", static_cast<unsigned char>(bytes[offset]));
  return buf;
}

std::string hexWindow(const std::string& bytes, size_t offset) {
  const size_t lo = offset > 8 ? offset - 8 : 0;
  const size_t hi = std::min(bytes.size(), offset + 8);
  std::string out;
  for (size_t i = lo; i < hi; ++i) {
    char buf[8];
    std::snprintf(buf, sizeof buf, "%02x ", static_cast<unsigned char>(bytes[i]));
    out += buf;
  }
  return out;
}

// True when `got` and `want` agree under the lead's rule. `*detail` collects every
// difference (empty on success). Side-effect free on purpose: the comparator is itself
// exercised by selfCheckComparator() below — a differential gate that cannot fail is
// indistinguishable from one that passes.
bool sameFrame(const std::string& gotBytes, const std::string& wantBytes, std::string* detail) {
  Frame got;
  Frame want;
  std::string err;
  if (!parseFrame(gotBytes, &got, &err)) {
    *detail = "the received frame is malformed: " + err;
    return false;
  }
  if (!parseFrame(wantBytes, &want, &err)) {
    // An unparseable expected file is an oracle defect — say so instead of comparing.
    *detail = "expected/ frame is malformed: " + err;
    return false;
  }

  bool ok = true;
  auto note = [detail, &ok](const std::string& line) {
    if (!detail->empty()) *detail += "\n";
    *detail += line;
    ok = false;
  };

  struct Field {
    const char* name;
    uint32_t got;
    uint32_t want;
    size_t headerOffset;
  };
  // magic is checked by parseFrame; namesLen (bytes 12..16) is deliberately absent — it is a
  // function of the names ENCODING, which the ruling exempts. The four fields that describe
  // the matrix must be equal, field by field.
  const Field fields[] = {
      {"rows", got.rows, want.rows, 4},
      {"cols", got.cols, want.cols, 8},
      {"totalRows", got.totalRows, want.totalRows, 16},
      {"totalCols", got.totalCols, want.totalCols, 20},
  };
  for (const Field& f : fields) {
    if (f.got == f.want) continue;
    char line[192];
    std::snprintf(line, sizeof line,
                  "header field %s differs: got %u want %u (header byte offset %zu)", f.name,
                  f.got, f.want, f.headerOffset);
    note(line);
  }

  // Names segment: JSON semantics, not bytes (the exemption). Compared before the data so a
  // shape mismatch above cannot make the offsets below meaningless — but only the fields
  // decide whether the shapes agree; both checks still run so one failure shows everything.
  dc::Json gotNames;
  dc::Json wantNames;
  std::string parseError;
  bool namesParsed = true;
  if (!got.names.empty() && !dc::Json::parse(got.names, &gotNames, &parseError)) {
    note("received names payload is not JSON: " + parseError + " (" + got.names + ")");
    namesParsed = false;
  }
  if (namesParsed && !want.names.empty() &&
      !dc::Json::parse(want.names, &wantNames, &parseError)) {
    note("expected/ names payload is not JSON: " + parseError);
    namesParsed = false;
  }
  if (namesParsed) {
    const std::vector<dc::Json>& gotItems = gotNames.items();
    const std::vector<dc::Json>& wantItems = wantNames.items();
    if (gotItems.size() != wantItems.size()) {
      char line[160];
      std::snprintf(line, sizeof line, "names count differs: got %zu want %zu",
                    gotItems.size(), wantItems.size());
      note(line);
    } else {
      for (size_t i = 0; i < wantItems.size(); ++i) {
        const bool same = gotItems[i].isString() && wantItems[i].isString() &&
                          gotItems[i].asString() == wantItems[i].asString();
        if (same) continue;
        note("names[" + std::to_string(i) + "] differs: got " + gotItems[i].dump() + " want " +
             wantItems[i].dump());
      }
    }
  }

  // Data segment: strict bytes. Only comparable once the shapes agree; when they do not,
  // the header failures above already explain it.
  if (ok && std::memcmp(got.bytes.data() + kDcm2Header, want.bytes.data() + kDcm2Header,
                        got.dataLen()) != 0) {
    size_t offset = kDcm2Header;
    while (offset < kDcm2Header + got.dataLen() && got.bytes[offset] == want.bytes[offset])
      ++offset;
    char line[192];
    std::snprintf(line, sizeof line,
                  "first differing byte at offset %zu of the data segment (got %s want %s)",
                  offset, byteAt(got.bytes, offset).c_str(),
                  byteAt(want.bytes, offset).c_str());
    note(line);
    note("got  [" + std::to_string(offset > 8 ? offset - 8 : 0) + "..] " +
         hexWindow(got.bytes, offset));
    note("want [" + std::to_string(offset > 8 ? offset - 8 : 0) + "..] " +
         hexWindow(want.bytes, offset));
  }
  return ok;
}

// Print + count one frame comparison. A strict success prints one `ok` line; a failure names
// the artifact and the FIRST differing byte offset, because a shifted payload and a wrong
// numbers block look identical in a summary line.
bool compareFrames(const std::string& where, const std::string& gotBytes,
                   const std::string& wantBytes) {
  std::string detail;
  if (sameFrame(gotBytes, wantBytes, &detail)) {
    Frame got;
    std::string err;
    parseFrame(gotBytes, &got, &err);  // already validated by sameFrame
    std::printf("  ok   %s (%ux%u, %zu data bytes, %zu names)\n", where.c_str(), got.rows,
                got.cols, got.dataLen(), got.bytes.size() - got.dataEnd());
    return true;
  }
  std::printf("FAIL %s: %s\n", where.c_str(), detail.c_str());
  ++failures;
  return false;
}

// ── the comparator, checked against itself ─────────────────────────────
//
// The fixture loop below can only prove "these five cases pass"; it cannot prove the
// comparator would NOTICE a change. That gap is exactly the failure mode of a differential
// gate (a `memcmp` weakened to a length check still prints ok). So the rule is exercised on
// synthetic frames: the names encoding must be forgiven, everything else refused.
std::string makeFrame(uint32_t rows, uint32_t cols, uint32_t totalRows, uint32_t totalCols,
                      const std::vector<double>& columnMajor, const std::string& names) {
  std::string out;
  auto u32 = [&out](uint32_t v) {
    char bytes[4];
    bytes[0] = static_cast<char>(v & 0xffu);
    bytes[1] = static_cast<char>((v >> 8) & 0xffu);
    bytes[2] = static_cast<char>((v >> 16) & 0xffu);
    bytes[3] = static_cast<char>((v >> 24) & 0xffu);
    out.append(bytes, 4);
  };
  u32(kDcm2Magic);
  u32(rows);
  u32(cols);
  u32(static_cast<uint32_t>(names.size()));
  u32(totalRows);
  u32(totalCols);
  for (const double value : columnMajor) {
    char bytes[8];
    std::memcpy(bytes, &value, sizeof bytes);
    out.append(bytes, 8);
  }
  out += names;
  return out;
}

void selfCheckComparator() {
  // 2x2: columns [1,2], [3,4]. The Python spelling of the names (space after the comma) is
  // what the fixtures carry; the compact spelling is what encodeDcm2Frame produces.
  const std::string padded = makeFrame(2, 2, 2, 2, {1, 2, 3, 4}, "[\"Pos.1\", \"Pos.2\"]");
  const std::string compact = makeFrame(2, 2, 2, 2, {1, 2, 3, 4}, "[\"Pos.1\",\"Pos.2\"]");
  const std::string flipped = makeFrame(2, 2, 2, 2, {1, 2, 3, 5}, "[\"Pos.1\", \"Pos.2\"]");
  const std::string reordered = makeFrame(2, 2, 2, 2, {1, 2, 3, 4}, "[\"Pos.2\", \"Pos.1\"]");
  const std::string reshaped = makeFrame(2, 2, 3, 2, {1, 2, 3, 4}, "[\"Pos.1\", \"Pos.2\"]");

  struct Case {
    const char* what;
    const std::string* want;  // second frame
    bool expectEqual;
    bool expectByteOffset;    // the message must name the first differing byte offset
  };
  const Case cases[] = {
      {"identical frames are equal", &padded, true, false},
      {"the names encoding is forgiven (the ruling)", &compact, true, false},
      {"a flipped data byte is caught", &flipped, false, true},
      {"a reordered names array is caught", &reordered, false, false},
      {"a changed totalRows field is caught", &reshaped, false, false},
  };

  size_t wrong = 0;
  for (const Case& c : cases) {
    std::string detail;
    const bool equal = sameFrame(padded, *c.want, &detail);
    // Which byte a double flip lands on depends on the host's float byte order, so the
    // self-check pins THAT an offset is reported, not WHICH one.
    const bool offsetPresent =
        !c.expectByteOffset ||
        detail.find("first differing byte at offset ") != std::string::npos;
    if (equal != c.expectEqual || (c.expectEqual && !detail.empty()) || !offsetPresent) {
      std::printf("FAIL comparator self-check: %s (sameFrame=%s detail=%s)\n", c.what,
                  equal ? "true" : "false", detail.c_str());
      ++failures;
      ++wrong;
    }
  }
  if (wrong == 0)
    std::printf("  ok   comparator self-check (%zu synthetic frames: names forgiven, rest "
                "refused)\n",
                sizeof cases / sizeof cases[0]);
}

// ── protocol helpers ──────────────────────────────────────────────────

int64_t numberAt(const dc::Json& object, const char* key, int64_t fallback = -1) {
  const dc::Json* value = object.find(key);
  return value != nullptr && value->isNumber() ? static_cast<int64_t>(value->asNumber())
                                               : fallback;
}

std::string stringAt(const dc::Json& object, const char* key) {
  const dc::Json* value = object.find(key);
  return value != nullptr && value->isString() ? value->asString() : std::string();
}

bool parseOk(const Response& res, dc::Json* json, const std::string& what) {
  std::string err;
  if (!dc::Json::parse(res.body, json, &err)) {
    std::printf("FAIL %s: body is not JSON (%s): %s\n", what.c_str(), err.c_str(),
                res.body.c_str());
    ++failures;
    return false;
  }
  return true;
}

bool postJson(int port, const std::string& path, const dc::Json& body, dc::Json* json,
              const std::string& what) {
  Response res;
  if (!sendRequest(port, buildRequest("POST", path, body.dump(), "application/json"), &res)) {
    std::printf("FAIL %s: transport error\n", what.c_str());
    ++failures;
    return false;
  }
  if (res.status != 200) {
    std::printf("FAIL %s: HTTP %d body=%s\n", what.c_str(), res.status, res.body.c_str());
    ++failures;
    return false;
  }
  return parseOk(res, json, what);
}

// POST /api/matrices/raw takes the DCM2 frame as the raw request body — the fixture file
// bytes travel unchanged, which is the point: the upload route decodes what the runner
// would have read.
bool uploadFrame(int port, const std::string& frame, int64_t* matrixId, const std::string& what) {
  Response res;
  if (!sendRequest(port, buildRequest("POST", "/api/matrices/raw", frame,
                                      "application/octet-stream"),
                   &res)) {
    std::printf("FAIL %s: transport error\n", what.c_str());
    ++failures;
    return false;
  }
  if (res.status != 200) {
    std::printf("FAIL %s: HTTP %d body=%s\n", what.c_str(), res.status, res.body.c_str());
    ++failures;
    return false;
  }
  dc::Json json;
  if (!parseOk(res, &json, what)) return false;
  *matrixId = numberAt(json, "matrixId");
  if (*matrixId < 0) {
    std::printf("FAIL %s: no matrixId in %s\n", what.c_str(), res.body.c_str());
    ++failures;
    return false;
  }
  return true;
}

bool getFrame(int port, const std::string& path, std::string* body, const std::string& what) {
  Response res;
  if (!sendRequest(port, buildRequest("GET", path, std::string(), "application/json"), &res)) {
    std::printf("FAIL %s: transport error\n", what.c_str());
    ++failures;
    return false;
  }
  if (res.status != 200) {
    std::printf("FAIL %s: HTTP %d body=%s\n", what.c_str(), res.status, res.body.c_str());
    ++failures;
    return false;
  }
  // The frame endpoints answer a binary frame, never JSON: a JSON body here means the route
  // fell through to an error envelope with status 200.
  if (res.contentType.find("application/octet-stream") == std::string::npos) {
    std::printf("FAIL %s: content-type is '%s', expected a binary frame\n", what.c_str(),
                res.contentType.c_str());
    ++failures;
    return false;
  }
  *body = res.body;
  return true;
}

// ── one fixture case, end to end over HTTP ─────────────────────────────

void runCase(int httpPort, const std::filesystem::path& fixtures, const std::string& name) {
  const std::filesystem::path caseDir = fixtures / name;
  const std::string tag = name;

  dc::Json ports;
  dc::Json meta;
  std::string err;
  if (!readJsonFile(caseDir / "ports.json", &ports, &err) || !ports.isArray()) {
    std::printf("FAIL %s: ports.json: %s\n", tag.c_str(),
                err.empty() ? "not a JSON array" : err.c_str());
    ++failures;
    return;
  }
  if (!readJsonFile(caseDir / "meta.json", &meta, &err) || !meta.isObject()) {
    std::printf("FAIL %s: meta.json: %s\n", tag.c_str(),
                err.empty() ? "not a JSON object" : err.c_str());
    ++failures;
    return;
  }
  const std::string script = stringAt(meta, "script");
  const dc::Json* outputs = meta.find("outputs");
  if (script.empty() || outputs == nullptr || !outputs->isArray() || outputs->items().empty()) {
    std::printf("FAIL %s: meta.json needs a script and a non-empty outputs array\n",
                tag.c_str());
    ++failures;
    return;
  }

  // ── upload every port frame, remember ids and the Python names ────────
  std::vector<std::string> portNames;
  dc::Json bindings = dc::Json::array();
  for (size_t i = 0; i < ports.items().size(); ++i) {
    const dc::Json& entry = ports.items()[i];
    const std::string portName = stringAt(entry, "port");
    const std::string frameName = stringAt(entry, "frame");
    if (portName.empty() || frameName.empty()) {
      std::printf("FAIL %s: ports.json entry %zu lacks port/frame\n", tag.c_str(), i);
      ++failures;
      return;
    }
    std::string frame;
    if (!readFileBytes(caseDir / frameName, &frame)) {
      std::printf("FAIL %s: cannot read input frame %s\n", tag.c_str(), frameName.c_str());
      ++failures;
      return;
    }
    int64_t matrixId = -1;
    if (!uploadFrame(httpPort, frame, &matrixId, tag + ": upload " + frameName)) return;
    portNames.push_back(portName);
    bindings.push(dc::Json::object({{"portId", dc::Json("port" + std::to_string(i))},
                                    {"varName", dc::Json(portName)},
                                    {"mode", dc::Json("matrix")},
                                    {"sourceMatrixId", dc::Json(matrixId)}}));
  }

  // ── declare the card exactly as the fixture does ─────────────────────
  dc::Json params = dc::Json::object({{"script", dc::Json(script)}});
  dc::Json namesJson = dc::Json::array();
  for (const std::string& portName : portNames) namesJson.push(dc::Json(portName));
  params.set("portNames", std::move(namesJson));
  params.set("outputs", *outputs);
  const int64_t timeoutMs = numberAt(meta, "timeout_ms");
  if (timeoutMs > 0) params.set("timeout_ms", dc::Json(timeoutMs));

  dc::Json created;
  if (!postJson(httpPort, "/api/nodes",
                dc::Json::object({{"signatureId", dc::Json("builtin:python")},
                                  {"inputs", std::move(bindings)},
                                  {"params", std::move(params)}}),
                &created, tag + ": POST /api/nodes"))
    return;
  const int64_t nodeId = numberAt(created, "nodeId");
  if (nodeId < 0) {
    std::printf("FAIL %s: no nodeId in %s\n", tag.c_str(), created.dump().c_str());
    ++failures;
    return;
  }
  // A script card is lazy: creating it must not run the script (that is `explicitCompute`).
  CHECK_MSG(stringAt(created, "state") == "dirty",
            "%s: a freshly declared script card is '%s', expected dirty",
            tag.c_str(), stringAt(created, "state").c_str());

  // ── compute: the one trigger ─────────────────────────────────────────
  dc::Json computed;
  if (!postJson(httpPort, "/api/nodes/" + std::to_string(nodeId) + "/compute", dc::Json::object(),
                &computed, tag + ": POST compute"))
    return;
  if (stringAt(computed, "state") != "done") {
    std::printf("FAIL %s: compute state is '%s', expected done\n", tag.c_str(),
                computed.dump().c_str());
    ++failures;
    return;
  }

  // ── output 0 IS the display matrix ───────────────────────────────────
  const std::filesystem::path expectedDir = caseDir / "expected";
  dc::Json manifest;
  if (!readJsonFile(expectedDir / "out.manifest.json", &manifest, &err) ||
      !manifest.isArray()) {
    std::printf("FAIL %s: expected/out.manifest.json: %s\n", tag.c_str(),
                err.empty() ? "not a JSON array" : err.c_str());
    ++failures;
    return;
  }
  if (manifest.items().size() != outputs->items().size()) {
    std::printf("FAIL %s: manifest has %zu entries, meta declares %zu outputs\n", tag.c_str(),
                manifest.items().size(), outputs->items().size());
    ++failures;
    return;
  }

  std::string expectedPrimary;
  if (!readFileBytes(expectedDir / "out.dcm2", &expectedPrimary)) {
    std::printf("FAIL %s: cannot read expected/out.dcm2\n", tag.c_str());
    ++failures;
    return;
  }
  std::string gotPrimary;
  if (!getFrame(httpPort, "/api/nodes/" + std::to_string(nodeId) + "/result?start=0&count=5000",
                &gotPrimary, tag + ": GET /api/nodes/{id}/result"))
    return;
  compareFrames(tag + ": result frame", gotPrimary, expectedPrimary);

  // The manifest is the runner's own description of what it produced; the display frame has
  // to agree with entry 0 or the two halves of the contract describe different matrices.
  {
    Frame primary;
    std::string frameError;
    if (parseFrame(gotPrimary, &primary, &frameError)) {
      const dc::Json& entry = manifest.items()[0];
      CHECK_MSG(numberAt(entry, "rows") == static_cast<int64_t>(primary.rows),
                "%s: manifest rows=%lld but the result frame is %u rows", tag.c_str(),
                static_cast<long long>(numberAt(entry, "rows")), primary.rows);
      CHECK_MSG(numberAt(entry, "cols") == static_cast<int64_t>(primary.cols),
                "%s: manifest cols=%lld but the result frame is %u cols", tag.c_str(),
                static_cast<long long>(numberAt(entry, "cols")), primary.cols);
    } else {
      std::printf("FAIL %s: result frame unparseable: %s\n", tag.c_str(), frameError.c_str());
      ++failures;
    }
  }

  // ── declared extra outputs: manifest entry <-> extraOutputs <-> window ──
  const dc::Json* extras = computed.find("extraOutputs");
  const size_t extraCount = manifest.items().size() - 1;
  if (extraCount == 0) {
    CHECK_MSG(extras == nullptr || extras->items().empty(),
              "%s: single-output case reported extraOutputs: %s", tag.c_str(),
              extras == nullptr ? "" : extras->dump().c_str());
  } else {
    CHECK_MSG(extras != nullptr && extras->isArray() && extras->items().size() == extraCount,
              "%s: expected %zu extra outputs, response has %s", tag.c_str(), extraCount,
              extras == nullptr ? "none" : extras->dump().c_str());
  }
  for (size_t i = 1; i < manifest.items().size(); ++i) {
    const dc::Json& entry = manifest.items()[i];
    const std::string wantName = stringAt(entry, "name");
    const std::string wantFrame = stringAt(entry, "frame");
    const int64_t wantRows = numberAt(entry, "rows");
    const int64_t wantCols = numberAt(entry, "cols");
    if (wantName.empty() || wantFrame.empty()) {
      std::printf("FAIL %s: manifest entry %zu lacks name/frame\n", tag.c_str(), i);
      ++failures;
      continue;
    }
    // The runtime matrix id is not part of the fixture: match the entry by its NAME, which
    // is what the card declared.
    const dc::Json* extra = nullptr;
    if (extras != nullptr && extras->isArray()) {
      for (const dc::Json& candidate : extras->items())
        if (stringAt(candidate, "name") == wantName) extra = &candidate;
    }
    if (extra == nullptr) {
      std::printf("FAIL %s: extra output '%s' is missing from the compute response\n",
                  tag.c_str(), wantName.c_str());
      ++failures;
      continue;
    }
    const int64_t matrixId = numberAt(*extra, "matrixId");
    CHECK_MSG(numberAt(*extra, "rows") == wantRows, "%s: extra '%s' rows=%lld want %lld",
              tag.c_str(), wantName.c_str(),
              static_cast<long long>(numberAt(*extra, "rows")),
              static_cast<long long>(wantRows));
    CHECK_MSG(numberAt(*extra, "cols") == wantCols, "%s: extra '%s' cols=%lld want %lld",
              tag.c_str(), wantName.c_str(),
              static_cast<long long>(numberAt(*extra, "cols")),
              static_cast<long long>(wantCols));
    if (matrixId < 0) {
      std::printf("FAIL %s: extra '%s' has no matrixId\n", tag.c_str(), wantName.c_str());
      ++failures;
      continue;
    }
    std::string expectedExtra;
    if (!readFileBytes(expectedDir / wantFrame, &expectedExtra)) {
      std::printf("FAIL %s: cannot read expected/%s\n", tag.c_str(), wantFrame.c_str());
      ++failures;
      continue;
    }
    std::string gotExtra;
    if (!getFrame(httpPort,
                  "/api/matrices/" + std::to_string(matrixId) + "/window?start=0&count=5000",
                  &gotExtra, tag + ": GET /api/matrices/{id}/window (" + wantName + ")"))
      continue;
    compareFrames(tag + ": extra '" + wantName + "' frame", gotExtra, expectedExtra);
  }

  // Every file the fixture ships must be consumed by one of the comparisons above. If a
  // future case grows an out.2.dcm2 and this test stops early, that goes unnoticed
  // otherwise — a silent gap in a differential gate is worse than a red one.
  for (const std::string& filename : listFiles(expectedDir)) {
    if (filename == "out.manifest.json" || filename == "out.dcm2") continue;
    bool matched = false;
    for (size_t i = 1; i < manifest.items().size(); ++i)
      matched = matched || stringAt(manifest.items()[i], "frame") == filename;
    CHECK_MSG(matched, "%s: expected/%s is not referenced by the manifest", tag.c_str(),
              filename.c_str());
  }
}

}  // namespace

int main() {
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    std::printf("FAILED: xlayer_fixture_node (winsock init)\n");
    return 1;
  }
#else
  // POSIX-only: on Windows the closed peer shows up as a failed send()/recv() instead.
#ifdef SIGPIPE
  std::signal(SIGPIPE, SIG_IGN);  // a peer closing early must fail a CHECK, not the process
#endif
#endif

  // Before anything that can SKIP: the comparison rule itself is verified here, so a
  // machine without the runtime still checks that the gate would notice a difference.
  selfCheckComparator();

  // The tests judge the checkout's vendored interpreter, so an inherited override must not
  // decide what they measure (same discipline as python_node_test.cpp). The node spawned by
  // the server resolves the runtime again, through the same rule.
#ifdef _WIN32
  _putenv_s("DC_PYRUNTIME", "");
#else
  unsetenv("DC_PYRUNTIME");
#endif
  std::string runtimeNote;
  const dc::PythonRuntime runtime = dc::resolvePythonRuntime(&runtimeNote);
  if (runtime.python.empty()) {
    // runtimeNote already reads "no interpreter at ...", so it is not prefixed again here.
    std::printf("SKIP: xlayer_fixture_node (%s; run scripts/fetch-python-runtime.sh)\n",
                runtimeNote.c_str());
    return 0;
  }

  const std::string repoRoot = dc::findRepoRoot();
  if (repoRoot.empty()) {
    std::printf("SKIP: xlayer_fixture_node (not running out of a source checkout: no "
                "backend/runner/runner.py above the working directory)\n");
    return 0;
  }
  const std::filesystem::path fixtures =
      std::filesystem::path(repoRoot) / "backend" / "tests" / "py" / "fixtures";
  std::error_code ec;
  if (!std::filesystem::is_directory(fixtures, ec)) {
    std::printf("FAILED: xlayer_fixture_node (no fixture directory at %s)\n",
                fixtures.string().c_str());
    return 1;
  }
  const std::vector<std::string> cases = listCases(fixtures);
  if (cases.empty()) {
    std::printf("FAILED: xlayer_fixture_node (no cases under %s)\n", fixtures.string().c_str());
    return 1;
  }

  const int port = pickEphemeralPort();
  if (port == 0) {
    std::printf("FAILED: xlayer_fixture_node (no free port)\n");
    return 1;
  }
  // Leaked on purpose, like script_check_test.cpp: the detached accept loop answers until
  // the process exits, so the server and everything it dereferences must outlive main()'s
  // stack.
  auto* store = new dc::MatrixStore();
  auto* bus = new dc::EventBus();
  auto* nodes = new dc::NodeRegistry(store, bus);
  auto* server = new dc::HttpServer(port, store, nodes, bus);
  std::atomic<bool> bindFailed{false};
  std::thread([server, &bindFailed] {
    if (!server->serve()) bindFailed.store(true);
  }).detach();
  if (!waitForListen(port, bindFailed)) {
    std::printf("FAILED: xlayer_fixture_node (could not listen on 127.0.0.1:%d)\n", port);
    return 1;
  }

  for (const std::string& name : cases) runCase(port, fixtures, name);

  std::printf("%s: xlayer_fixture_node (%zu cases, %d failures)\n",
              failures == 0 ? "PASS" : "FAILED", cases.size(), failures);
  return failures == 0 ? 0 : 1;
}