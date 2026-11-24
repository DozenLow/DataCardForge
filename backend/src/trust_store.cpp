#include "trust_store.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "json.h"

namespace dc {
namespace {

constexpr size_t kMaxEntries = 100;
constexpr const char* kFileName = "trust.json";

std::string lower(std::string text) {
  std::transform(text.begin(), text.end(), text.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return text;
}

bool isWorkspaceHash(const std::string& text) {
  if (text.size() != 64) return false;
  for (const char c : text) {
    if (!std::isxdigit(static_cast<unsigned char>(c))) return false;
  }
  return true;
}

// FNV-1a 64. The environment id only detects "another machine / another install"; it is a
// deterrent, not a security boundary (anything with write access to the record can rewrite
// it). Avoiding a second SHA-256 implementation in C++ is the point.
uint64_t fnv1a64(const std::string& text) {
  uint64_t h = 1469598103934665603ULL;
  for (const unsigned char c : text) {
    h ^= static_cast<uint64_t>(c);
    h *= 1099511628211ULL;
  }
  return h;
}

std::string hex16(uint64_t value) {
  static const char* digits = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) {
    out[static_cast<size_t>(i)] = digits[value & 0xF];
    value >>= 4;
  }
  return out;
}

std::string osName() {
#if defined(_WIN32)
  return "windows";
#elif defined(__APPLE__)
  return "macos";
#else
  return "linux";
#endif
}

std::string hostName() {
#ifdef _WIN32
  char buffer[256];
  DWORD size = static_cast<DWORD>(sizeof(buffer));
  if (GetComputerNameA(buffer, &size) != 0) return std::string(buffer, size);
  return "unknown";
#else
  char buffer[256];
  if (gethostname(buffer, sizeof(buffer)) == 0) {
    buffer[sizeof(buffer) - 1] = '\0';
    return std::string(buffer);
  }
  return "unknown";
#endif
}

std::string readTextFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

bool writeFileAtomic(const std::string& path, const std::string& text) {
  const std::string temp = path + ".tmp";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out << text;
    out.flush();
    if (!out) return false;
  }
  std::error_code ec;
  std::filesystem::rename(temp, path, ec);
  if (ec) {
    // Windows refuses to rename over an existing file; replace explicitly.
    std::filesystem::remove(path, ec);
    ec.clear();
    std::filesystem::rename(temp, path, ec);
  }
  if (ec) {
    std::filesystem::remove(temp, ec);
    return false;
  }
  return true;
}

/** First candidate that exists-or-can-be-created and accepts a probe write. */
std::string resolveDir(const std::string& canonicalExe) {
  std::vector<std::string> candidates;
  if (const char* forced = std::getenv("DC_TRUST_DIR"); forced != nullptr && forced[0] != '\0') {
    candidates.emplace_back(forced);
  }
  if (!canonicalExe.empty()) {
    candidates.push_back(std::filesystem::path(canonicalExe).parent_path().string());
  }
// `path` deliberately never converts to `std::string` implicitly: on Windows its native
// string type is `wstring`, so `.string()` is the only spelling that compiles on all three
// platforms (and the one that decides the encoding).
#if defined(_WIN32)
  if (const char* appdata = std::getenv("APPDATA"); appdata != nullptr) {
    candidates.emplace_back((std::filesystem::path(appdata) / "DataCardForge").string());
  }
#elif defined(__APPLE__)
  if (const char* home = std::getenv("HOME"); home != nullptr) {
    candidates.emplace_back((std::filesystem::path(home) / "Library" / "Application Support" /
                             "DataCardForge")
                                .string());
  }
#else
  if (const char* xdg = std::getenv("XDG_CONFIG_HOME"); xdg != nullptr && xdg[0] != '\0') {
    candidates.emplace_back((std::filesystem::path(xdg) / "datacardforge").string());
  } else if (const char* home = std::getenv("HOME"); home != nullptr) {
    candidates.emplace_back((std::filesystem::path(home) / ".config" / "datacardforge").string());
  }
#endif
  for (const auto& candidate : candidates) {
    if (candidate.empty()) continue;
    std::error_code ec;
    std::filesystem::create_directories(candidate, ec);
    if (ec || !std::filesystem::is_directory(candidate, ec) || ec) continue;
    const std::filesystem::path probe =
        std::filesystem::path(candidate) / ".trust-write-probe";
    {
      std::ofstream out(probe, std::ios::binary | std::ios::trunc);
      if (!out) continue;
      out << "x";
    }
    std::filesystem::remove(probe, ec);
    if (ec) continue;
    return candidate;
  }
  return {};
}

int64_t nowSeconds() { return static_cast<int64_t>(std::time(nullptr)); }

}  // namespace

TrustStore::TrustStore(std::string exePath) {
  std::string canonical;
  if (!exePath.empty()) {
    std::error_code ec;
    const auto absolute = std::filesystem::absolute(exePath, ec);
    if (!ec) canonical = absolute.lexically_normal().string();
  }
  const char* runtime = std::getenv("DC_PYRUNTIME");
  envId_ = "v1-" + hex16(fnv1a64(osName() + "|" + hostName() + "|" + canonical + "|" +
                                 (runtime != nullptr ? runtime : "")));

  dirPath_ = resolveDir(canonical);
  if (dirPath_.empty()) {
    unavailable_ = true;
    return;
  }
  filePath_ = (std::filesystem::path(dirPath_) / kFileName).string();
  load();
}

void TrustStore::load() {
  std::error_code ec;
  if (!std::filesystem::exists(filePath_, ec) || ec) return;  // first run: undecided
  Json parsed;
  std::string error;
  if (!Json::parse(readTextFile(filePath_), &parsed, &error) || !parsed.isObject()) {
    // A record we cannot read is a record we cannot trust: force the confirmation flow.
    unavailable_ = true;
    return;
  }
  decided_ = true;
  const Json* env = parsed.find("envId");
  envChanged_ = !(env != nullptr && env->isString() && env->asString() == envId_);
  const Json* entries = parsed.find("entries");
  if (entries != nullptr && entries->isObject()) {
    for (const auto& member : entries->members()) {
      const Json& entry = member.second;
      if (!isWorkspaceHash(member.first) || !entry.isObject()) continue;
      TrustEntry stored;
      const Json* at = entry.find("at");
      if (at != nullptr && at->isNumber()) stored.at = static_cast<int64_t>(at->asNumber());
      const Json* scripts = entry.find("scripts");
      if (scripts != nullptr && scripts->isArray()) {
        for (const Json& script : scripts->items()) {
          if (script.isString()) stored.scripts.push_back(script.asString());
        }
      }
      entries_[member.first] = stored;
    }
  }
}

bool TrustStore::save() const {
  Json entries = Json::object();
  for (const auto& member : entries_) {
    Json scripts = Json::array();
    for (const auto& script : member.second.scripts) scripts.push(Json(script));
    entries.set(member.first,
                Json::object({{"scripts", std::move(scripts)},
                              {"at", Json(member.second.at)}}));
  }
  const Json root = Json::object({{"version", Json(1)},
                                  {"envId", Json(envId_)},
                                  {"entries", std::move(entries)}});
  return writeFileAtomic(filePath_, root.dump());
}

TrustStatus TrustStore::status() const {
  std::lock_guard<std::mutex> lock(mu_);
  TrustStatus out;
  out.envId = envId_;
  out.envChanged = envChanged_;
  out.entries = entries_.size();
  if (unavailable_) {
    out.persistence = "unavailable";
  } else if (sessionOnly_) {
    out.persistence = "session";
  } else if (decided_) {
    out.persistence = "persistent";
    out.location = filePath_;
  } else {
    out.persistence = "undecided";
  }
  return out;
}

bool TrustStore::decidePersistence(bool persist) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!persist) {
    decided_ = true;
    sessionOnly_ = true;
    return true;
  }
  if (unavailable_ || filePath_.empty()) return false;
  std::error_code ec;
  std::filesystem::create_directories(dirPath_, ec);
  if (ec) {
    unavailable_ = true;
    return false;
  }
  decided_ = true;
  sessionOnly_ = false;
  if (!std::filesystem::exists(filePath_, ec)) {
    if (!save()) {
      unavailable_ = true;
      decided_ = false;
      return false;
    }
  }
  return true;
}

TrustLookup TrustStore::lookup(const std::string& workspaceHash) const {
  std::lock_guard<std::mutex> lock(mu_);
  TrustLookup out;
  out.envMatch = !envChanged_;
  if (!out.envMatch) return out;
  const auto it = entries_.find(workspaceHash);
  if (it != entries_.end()) {
    out.known = true;
    out.scripts = it->second.scripts;
  }
  return out;
}

bool TrustStore::record(const std::string& workspaceHash,
                        const std::vector<std::string>& scripts) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!decided_) return false;
  // Persistent path: keep a rollback copy (the eviction below can drop other entries too).
  // A failed save must not leave the mutation in memory — returning true while nothing was
  // persisted is a 200 answer that lies about trust. The session-only path is unchanged.
  const bool persistent = !sessionOnly_;
  std::map<std::string, TrustEntry> previous;
  if (persistent) previous = entries_;
  TrustEntry& entry = entries_[workspaceHash];
  entry.at = nowSeconds();
  for (const auto& script : scripts) {
    if (std::find(entry.scripts.begin(), entry.scripts.end(), script) == entry.scripts.end()) {
      entry.scripts.push_back(script);
    }
  }
  while (entries_.size() > kMaxEntries) {
    auto oldest = entries_.begin();
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (it->second.at < oldest->second.at) oldest = it;
    }
    entries_.erase(oldest);
  }
  if (persistent && !save()) {
    entries_ = std::move(previous);
    unavailable_ = true;
    return false;
  }
  return true;
}

bool TrustStore::revoke(const std::string& workspaceHash) {
  std::lock_guard<std::mutex> lock(mu_);
  const auto erased = entries_.erase(workspaceHash);
  if (erased > 0 && !sessionOnly_ && decided_ && !save()) unavailable_ = true;
  return erased > 0;
}

}  // namespace dc
