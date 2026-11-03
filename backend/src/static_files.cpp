#include "static_files.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <system_error>

namespace dc {
namespace {

constexpr size_t kMaxStaticFileBytes = 64u * 1024u * 1024u;  // 64 MiB: refuse anything absurd

std::string toLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string extensionOf(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  const size_t dot = path.find_last_of('.');
  if (dot == std::string::npos) return {};
  if (slash != std::string::npos && dot < slash) return {};
  return toLower(path.substr(dot));
}

// Normalise to "/a/b/c": collapse runs of '/', drop '.', reject '..' outright. Rejecting rather
// than resolving keeps the rule auditable — no legitimate front-end asset has '..' in its path.
bool normalisePath(const std::string& urlPath, std::string* out) {
  if (urlPath.find('\0') != std::string::npos) return false;
  if (urlPath.find('\\') != std::string::npos) return false;  // no Windows separator bypasses
  std::string norm = "/";
  size_t i = 0;
  while (i < urlPath.size()) {
    while (i < urlPath.size() && urlPath[i] == '/') ++i;
    if (i >= urlPath.size()) break;
    const size_t j = std::min(urlPath.find('/', i), urlPath.size());
    const std::string seg = urlPath.substr(i, j - i);
    if (seg == "..") return false;
    if (seg != ".") {
      if (norm.size() > 1) norm.push_back('/');
      norm += seg;
    }
    i = j;
  }
  if (norm == "/") norm = "/index.html";
  *out = std::move(norm);
  return true;
}

}  // namespace

bool isSafeUrlPath(const std::string& urlPath) {
  std::string ignored;
  return normalisePath(urlPath, &ignored);
}

bool isAllowedStaticExtension(const std::string& path) {
  const std::string ext = extensionOf(path);
  if (ext.empty()) return false;
  // Allow-list, not deny-list: a file the front end never emits cannot be served even if
  // somebody drops it next to the binary later.
  static const char* kAllowed[] = {".html", ".htm", ".js", ".mjs", ".css", ".svg", ".png",
                                   ".jpg",  ".jpeg", ".webp", ".gif", ".ico", ".woff2",
                                   ".woff", ".json", ".map", ".txt", ".wasm"};
  for (const char* a : kAllowed)
    if (ext == a) return true;
  return false;
}

std::string contentTypeFor(const std::string& path) {
  const std::string ext = extensionOf(path);
  if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
  if (ext == ".js" || ext == ".mjs") return "text/javascript; charset=utf-8";
  if (ext == ".css") return "text/css; charset=utf-8";
  if (ext == ".svg") return "image/svg+xml";
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".webp") return "image/webp";
  if (ext == ".gif") return "image/gif";
  if (ext == ".ico") return "image/x-icon";
  if (ext == ".woff2") return "font/woff2";
  if (ext == ".woff") return "font/woff";
  if (ext == ".json" || ext == ".map") return "application/json";
  if (ext == ".txt") return "text/plain; charset=utf-8";
  if (ext == ".wasm") return "application/wasm";
  return {};
}

std::string resolveStaticPath(const std::string& root, const std::string& urlPath) {
  if (root.empty()) return {};

  std::string norm;
  if (!normalisePath(urlPath, &norm)) return {};
  if (!isAllowedStaticExtension(norm)) return {};

  std::error_code ec;
  const std::filesystem::path rootAbs = std::filesystem::weakly_canonical(root, ec);
  if (ec) return {};
  const std::filesystem::path candidate =
      std::filesystem::weakly_canonical(rootAbs / norm.substr(1), ec);
  if (ec) return {};

  // Canonicalisation resolves symlinks, so this also refuses a link inside the web root
  // that points somewhere else on disk.
  const std::filesystem::path rel = candidate.lexically_relative(rootAbs);
  if (rel.empty() || rel.native().rfind("..", 0) == 0) return {};
  if (!std::filesystem::is_regular_file(candidate, ec) || ec) return {};
  return candidate.string();
}

bool readFileBinary(const std::string& path, std::string* out) {
  if (!out) return false;
  std::error_code ec;
  const auto size = std::filesystem::file_size(path, ec);
  if (ec || size > kMaxStaticFileBytes) return false;
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  out->assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  return in.good() || in.eof();
}

bool hasIndex(const std::string& root) {
  if (root.empty()) return false;
  std::error_code ec;
  return std::filesystem::is_regular_file(std::filesystem::path(root) / "index.html", ec) && !ec;
}

}  // namespace dc
