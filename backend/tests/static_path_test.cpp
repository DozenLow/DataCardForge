// Path rules for the packaged UI. No sockets, no HTTP: the interesting failures here are
// traversal and extension rules, and those are decided before anything touches a file
// descriptor.
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

#include "static_files.h"

namespace fs = std::filesystem;

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

int main() {
  const fs::path root = fs::temp_directory_path() / "dc_static_paths_test";
  std::error_code ec;
  fs::remove_all(root, ec);
  fs::create_directories(root / "assets", ec);
  std::ofstream(root / "index.html") << "<!doctype html>";
  std::ofstream(root / "app.js") << "console.log(1)";
  std::ofstream(root / "assets" / "x.css") << "body{}";
  std::ofstream(root / "secret.exe") << "MZ";

  // ── served ────────────────────────────────────────────────────────────
  CHECK(dc::hasIndex(root.string()));
  CHECK(!dc::hasIndex((root / "assets").string()));
  CHECK(!dc::resolveStaticPath(root.string(), "/").empty());
  CHECK(!dc::resolveStaticPath(root.string(), "/app.js").empty());
  CHECK(!dc::resolveStaticPath(root.string(), "/assets/x.css").empty());
  CHECK(!dc::resolveStaticPath(root.string(), "/./app.js").empty());
  CHECK(!dc::resolveStaticPath(root.string(), "//app.js").empty());

  // ── refused: traversal, stray separators, NUL, missing, disallowed extension ─
  CHECK(dc::resolveStaticPath(root.string(), "/../etc/passwd").empty());
  CHECK(dc::resolveStaticPath(root.string(), "/assets/../../index.html").empty());
  CHECK(dc::resolveStaticPath(root.string(), "..").empty());
  CHECK(dc::resolveStaticPath(root.string(), "/..\\..\\index.html").empty());
  CHECK(dc::resolveStaticPath(root.string(), std::string("/app.js\0.png", 12)).empty());
  CHECK(dc::resolveStaticPath(root.string(), "/secret.exe").empty());
  CHECK(dc::resolveStaticPath(root.string(), "/missing.js").empty());
  CHECK(dc::resolveStaticPath("", "/app.js").empty());

  // ── safety predicate (drives 404 vs SPA fallback) ─────────────────────
  CHECK(dc::isSafeUrlPath("/app.js"));
  CHECK(dc::isSafeUrlPath("/"));
  CHECK(dc::isSafeUrlPath("/some/deep/link"));
  CHECK(!dc::isSafeUrlPath("/../etc/passwd"));
  CHECK(!dc::isSafeUrlPath("/assets/../../index.html"));
  CHECK(!dc::isSafeUrlPath("/a\\b"));
  CHECK(!dc::isSafeUrlPath(std::string("/a\0b", 4)));

  // ── content types ─────────────────────────────────────────────────────
  CHECK(dc::contentTypeFor("a.html").rfind("text/html", 0) == 0);  CHECK(dc::contentTypeFor("a.JS").rfind("text/javascript", 0) == 0);
  CHECK(dc::contentTypeFor("a.svg") == "image/svg+xml");
  CHECK(dc::contentTypeFor("a.exe").empty());
  CHECK(dc::isAllowedStaticExtension("x.woff2"));
  CHECK(!dc::isAllowedStaticExtension("x.sh"));

  // ── reading ───────────────────────────────────────────────────────────
  std::string body;
  CHECK(dc::readFileBinary((root / "app.js").string(), &body));
  CHECK(body == "console.log(1)");
  CHECK(!dc::readFileBinary((root / "nope.js").string(), &body));

  fs::remove_all(root, ec);
  std::printf("%s: static_paths (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
