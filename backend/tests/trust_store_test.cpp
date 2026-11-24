// Workspace trust records: the first-run decision, per-file script lists, the environment
// binding, the session-only path and the entry cap. No HTTP here — the redirects and the
// error envelopes are the HTTP layer's business (route()), the record rules are this file's.
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

#include "trust_store.h"

namespace fs = std::filesystem;

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

namespace {

void setTrustDir(const std::string& dir) {
#ifdef _WIN32
  _putenv_s("DC_TRUST_DIR", dir.c_str());
#else
  setenv("DC_TRUST_DIR", dir.c_str(), 1);
#endif
}

std::string readText(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return text;
}

std::string hashOf(char c) { return std::string(64, c); }

}  // namespace

int main() {
  std::error_code ec;
  const fs::path persistentDir = fs::temp_directory_path() / "dc_trust_store_test";
  const fs::path sessionDir = fs::temp_directory_path() / "dc_trust_session_test";
  fs::remove_all(persistentDir, ec);
  fs::remove_all(sessionDir, ec);

  const std::string hashA = hashOf('a');
  const std::string hashB = hashOf('b');

  // ── first run: undecided, and nothing is recorded before the decision ──
  setTrustDir(persistentDir.string());
  {
    dc::TrustStore store("dc_probe_exe");
    const dc::TrustStatus status = store.status();
    CHECK(status.persistence == "undecided");
    CHECK(status.entries == 0);
    CHECK(status.envId.rfind("v1-", 0) == 0);
    CHECK(!store.record(hashA, {"1"}));
  }

  // ── persistent: record, merge, dedupe ──
  {
    dc::TrustStore store("dc_probe_exe");
    CHECK(store.decidePersistence(true));
    CHECK(store.record(hashA, {"1", "2"}));
    CHECK(store.record(hashA, {"2", "3"}));
    const dc::TrustLookup found = store.lookup(hashA);
    CHECK(found.known);
    CHECK(found.envMatch);
    CHECK(found.scripts.size() == 3);
    CHECK(fs::exists(persistentDir / "trust.json"));
    CHECK(store.status().persistence == "persistent");
    CHECK(store.status().location == (persistentDir / "trust.json").string());
  }

  // ── reload: the record survives, and an unknown hash stays unknown ──
  {
    dc::TrustStore store("dc_probe_exe");
    const dc::TrustStatus status = store.status();
    CHECK(status.persistence == "persistent");
    CHECK(status.entries == 1);
    CHECK(!status.envChanged);
    CHECK(store.lookup(hashA).known);
    CHECK(store.lookup(hashA).scripts.size() == 3);
    CHECK(!store.lookup(hashB).known);
    CHECK(store.revoke(hashA));
    CHECK(!store.lookup(hashA).known);
  }

  // ── another environment: the record is ignored and reported as such ──
  {
    setTrustDir(persistentDir.string());
    dc::TrustStore seed("dc_probe_exe");
    CHECK(seed.record(hashB, {"7"}));
  }
  {
    std::string text = readText(persistentDir / "trust.json");
    const std::string marker = "\"envId\":\"";
    const size_t at = text.find(marker);
    CHECK(at != std::string::npos);
    if (at != std::string::npos) {
      const size_t begin = at + marker.size();
      const size_t end = text.find('"', begin);
      text.replace(begin, end - begin, "v1-0000000000000000");
      std::ofstream(persistentDir / "trust.json", std::ios::binary | std::ios::trunc) << text;
    }
    setTrustDir(persistentDir.string());
    dc::TrustStore store("dc_probe_exe");
    CHECK(store.status().envChanged);
    const dc::TrustLookup found = store.lookup(hashB);
    CHECK(!found.known);
    CHECK(!found.envMatch);
  }

  // ── session only: the record works for the process and never touches the disk ──
  {
    setTrustDir(sessionDir.string());
    dc::TrustStore store("dc_probe_exe");
    CHECK(store.decidePersistence(false));
    CHECK(store.record(hashA, {"5"}));
    CHECK(store.lookup(hashA).known);
    CHECK(store.status().persistence == "session");
    CHECK(!fs::exists(sessionDir / "trust.json"));
  }

  // ── cap: never more than 100 workspace records ──
  {
    setTrustDir(sessionDir.string());
    dc::TrustStore store("dc_probe_exe");
    CHECK(store.decidePersistence(false));
    for (int i = 0; i < 105; ++i) {
      char suffix[4];
      std::snprintf(suffix, sizeof(suffix), "%03d", i);
      CHECK(store.record(std::string(61, 'c') + suffix, {"1"}));
    }
    CHECK(store.status().entries == 100);
  }

  // ── save failure: record() must roll back and return false, not a false success ──
  {
    const fs::path failDir = fs::temp_directory_path() / "dc_trust_savefail_test";
    fs::remove_all(failDir, ec);
    setTrustDir(failDir.string());
    dc::TrustStore store("dc_probe_exe");
    CHECK(store.decidePersistence(true));
    CHECK(store.record(hashA, {"1"}));
    // Turn the record file into a NON-EMPTY directory: the atomic rename can neither
    // replace nor remove it, so save() fails even when the test runs privileged.
    fs::remove(failDir / "trust.json", ec);
    fs::create_directory(failDir / "trust.json", ec);
    std::ofstream(failDir / "trust.json" / "blocker") << "x";
    CHECK(!store.record(hashB, {"9"}));
    CHECK(!store.lookup(hashB).known);
    CHECK(!store.record(hashA, {"2"}));
    const dc::TrustLookup rolledBack = store.lookup(hashA);
    CHECK(rolledBack.known);
    CHECK(rolledBack.scripts.size() == 1 && rolledBack.scripts[0] == "1");
    CHECK(store.status().persistence == "unavailable");
    fs::remove_all(failDir, ec);
  }

  if (failures == 0) {
    std::printf("trust_store: all checks passed\n");
    return 0;
  }
  std::printf("trust_store: %d check(s) failed\n", failures);
  return 1;
}
