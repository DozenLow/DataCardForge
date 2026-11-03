#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

#ifdef _WIN32
#  include <io.h>
#  define dc_isatty _isatty
#  define dc_fileno _fileno
#else
#  include <unistd.h>
#  define dc_isatty isatty
#  define dc_fileno fileno
#endif

#include "build_sha.h"  // generated at build time (see CMakeLists)
#include "http_server.h"
#include "matrix_store.h"
#include "nodes.h"
#include "static_files.h"

namespace {

// First candidate that actually contains index.html wins. Ordered so that a package
// (binary + ./web) and a source checkout (<repo>/web/dist) both work with no flags.
std::string findWebRoot(const std::string& explicitRoot, const char* argv0) {
  std::error_code ec;
  std::vector<std::string> candidates;
  if (!explicitRoot.empty()) candidates.push_back(explicitRoot);
  if (const char* env = std::getenv("DC_WEB_ROOT")) candidates.push_back(env);

  const std::filesystem::path cwd = std::filesystem::current_path(ec);
  candidates.push_back((cwd / "web" / "dist").string());

  // argv[0] is the simplest approximation of "next to the binary" without platform-specific
  // executable-path calls; it is only a fallback, so a PATH lookup simply yields no hit.
  if (argv0 != nullptr && argv0[0] != '\0') {
    const std::filesystem::path exe = std::filesystem::absolute(argv0, ec);
    if (!ec) {
      candidates.push_back((exe.parent_path() / "web").string());
      candidates.push_back((exe.parent_path() / ".." / "web" / "dist").string());
    }
  }
  for (const auto& c : candidates) {
    if (dc::hasIndex(c)) return c;
  }
  return {};
}

void openInBrowser(const std::string& url) {
#ifdef _WIN32
  const std::string cmd = "start \"\" \"" + url + "\"";
#elif defined(__APPLE__)
  const std::string cmd = "open \"" + url + "\" >/dev/null 2>&1 &";
#else
  const std::string cmd = "xdg-open \"" + url + "\" >/dev/null 2>&1 &";
#endif
  // Best effort: a headless box, no default browser or a missing xdg-open must not turn a
  // successful start into a failure.
  const int rc = std::system(cmd.c_str());
  (void)rc;
}

}  // namespace

int main(int argc, char** argv) {
  int port = 37811;
  std::string webRootArg;
  bool openUi = true;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--port" && i + 1 < argc) {
      port = std::atoi(argv[++i]);
    } else if (a == "--web-root" && i + 1 < argc) {
      webRootArg = argv[++i];
    } else if (a == "--no-open") {
      openUi = false;
    } else if (a == "--help" || a == "-h") {
      std::printf(
          "usage: dc_backend [--port N] [--web-root DIR] [--no-open]\n"
          "  --port N        listen port on 127.0.0.1 (default 37811)\n"
          "  --web-root DIR  built front end to serve (default: auto-detect ./web/dist)\n"
          "  --no-open       never open a browser (also: DC_NO_OPEN=1)\n");
      return 0;
    }
  }

  const std::string webRoot = findWebRoot(webRootArg, argc > 0 ? argv[0] : nullptr);
  const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/";

  dc::MatrixStore store;
  dc::EventBus bus;
  dc::NodeRegistry nodes(&store, &bus);
  dc::HttpServer server(port, &store, &nodes, &bus, webRoot);

  std::printf("dc_backend protocol=1 build=%s listening on http://127.0.0.1:%d\n", DC_BUILD_SHA, port);
  if (webRoot.empty()) {
    std::printf("  ui: not found (API only) — build the front end with `cd web && npm run build`\n"
                "      or pass --web-root <dir>\n");
  } else {
    std::printf("  ui: serving %s\n", webRoot.c_str());
    if (openUi) std::printf("  opening %s   (--no-open disables)\n", url.c_str());
  }
  std::fflush(stdout);

  // A browser is only useful (and only safe to spawn) on an interactive terminal: CI, ctest
  // and `nohup` all fail this test, so no run of the test suite ever pops a window.
  const bool interactive = dc_isatty(dc_fileno(stdout)) != 0 && std::getenv("CI") == nullptr &&
                           std::getenv("DC_NO_OPEN") == nullptr;
  if (openUi && interactive && !webRoot.empty()) {
    server.setOnReady([url] { openInBrowser(url); });
  }

  if (!server.serve()) {
    std::fprintf(stderr, "failed to bind 127.0.0.1:%d\n", port);
    return 1;
  }
  return 0;
}

