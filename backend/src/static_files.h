// Static file serving for the packaged, single-binary experience.
//
// The backend normally speaks only `/api/*`; when a web root is supplied it also serves the
// built front end from the same loopback origin. Same origin matters: the Pages demo is
// https and cannot call http://127.0.0.1 (mixed content / private-network rules), so
// opening a browser at the Pages URL can never reach a local backend.
//
// This file is deliberately split from http_server.cpp: the path rules are pure string +
// filesystem logic, so tests can hammer them without a socket.
#pragma once

#include <string>

namespace dc {

// Resolve a URL path (already percent-decoded by the HTTP layer) to a file under `root`.
// Returns "" when the request must NOT be served:
//   - empty root, empty/`/` path is mapped to index.html (if it exists)
//   - NUL byte, backslash, or any `..` segment (traversal)
//   - an extension outside the allow-list
//   - a path that escapes `root` after canonicalisation, or does not exist
std::string resolveStaticPath(const std::string& root, const std::string& urlPath);

// True when the extension of `path` is on the allow-list.
bool isAllowedStaticExtension(const std::string& path);

// True when the path contains no traversal, NUL or backslash — independent of what exists on
// disk. Used to answer a traversal probe with a 404 instead of the SPA fallback's index.html:
// a probe should never look like a successful page load.
bool isSafeUrlPath(const std::string& urlPath);

// Content-Type for `path`, or "" when the extension is not allowed.
std::string contentTypeFor(const std::string& path);

// Read a whole file. False on any error (missing, not a regular file, read failure).
bool readFileBinary(const std::string& path, std::string* out);

// <root>/index.html exists and is a regular file.
bool hasIndex(const std::string& root);

}  // namespace dc
