// Workspace trust records: which workspace FILES (by the SHA-256 of their bytes) the user has
// blessed, and which scripts inside them were individually confirmed.
//
// This is the backend's first persistent state, so the rules are explicit: the file lives in a
// directory the process can write with ordinary user rights (the executable's own directory
// first, because a packaged release is portable), it is written atomically, and the whole
// record is bound to a local environment id so a copied file cannot carry trust to another
// machine. SHA-256 is not computed here: the workspace file never reaches the backend, so the
// browser hashes it and this store keeps that hex string as an opaque key.
#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace dc {

/** The scripts one workspace file's user confirmed, keyed by the card id inside that file. */
struct TrustEntry {
  std::vector<std::string> scripts;
  int64_t at = 0;
};

struct TrustStatus {
  /** "undecided" (first run), "persistent", "session" (declined / not writable), or
      "unavailable" (no writable location, or a corrupt record — trust nothing). */
  std::string persistence;
  std::string location;   // the record file, when persistence == "persistent"
  std::string envId;      // hex; a different value means "another machine/environment"
  bool envChanged = false;
  size_t entries = 0;
};

struct TrustLookup {
  bool known = false;
  bool envMatch = true;
  std::vector<std::string> scripts;
};

class TrustStore {
 public:
  /** `exePath` decides the default record directory (the executable's own directory). */
  explicit TrustStore(std::string exePath = std::string());

  TrustStatus status() const;

  /**
   * Answer the first-run question: keep the records on disk, or this session only?
   *
   * Returns false only when persistence was requested and cannot be provided; the caller then
   * offers the session-only path instead.
   */
  bool decidePersistence(bool persist);

  TrustLookup lookup(const std::string& workspaceHash) const;

  /** Merge `scripts` into the hash's entry. False until a persistence decision exists, and
      false when a persistent save fails — the in-memory mutation is then rolled back. */
  bool record(const std::string& workspaceHash, const std::vector<std::string>& scripts);

  bool revoke(const std::string& workspaceHash);

 private:
  void load();
  bool save() const;

  std::string dirPath_;
  std::string filePath_;
  std::string envId_;
  bool unavailable_ = false;
  bool decided_ = false;
  bool sessionOnly_ = false;
  bool envChanged_ = false;
  std::map<std::string, TrustEntry> entries_;
  mutable std::mutex mu_;
};

}  // namespace dc
