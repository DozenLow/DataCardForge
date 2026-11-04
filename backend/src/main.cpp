#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

#include "build_sha.h"  // generated at build time (see CMakeLists)
#include "http_server.h"
#include "matrix_store.h"
#include "nodes.h"
#include "static_files.h"
#include "ui_launch.h"

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

// DC_OPEN / DC_NO_OPEN: set to anything but "" or "0" to turn the behaviour on. Documented as
// =1 in the release notes; accepting 0 keeps "DC_NO_OPEN=0" meaning off instead of surprising.
bool envFlag(const char* name) {
  const char* v = std::getenv(name);
  if (v == nullptr) return false;
  return v[0] != '\0' && std::strcmp(v, "0") != 0;
}

}  // namespace

int main(int argc, char** argv) {
  // Line-buffered from the first byte on: the console may be created a few lines below, and a
  // block-buffered stdout would hold the status back until exit — which for this program is
  // never. stderr stays unbuffered so an error cannot end up behind the banner.
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  std::setvbuf(stderr, nullptr, _IONBF, 0);

  const char* self = (argc > 0 && argv[0] != nullptr && argv[0][0] != '\0') ? argv[0] : "datacardforge";

  int port = 37811;
  std::string webRootArg;
  bool openRequested = true;  // --no-open
  bool forceOpen = false;     // --open
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--port" && i + 1 < argc) {
      port = std::atoi(argv[++i]);
      if (port <= 0 || port > 65535) {
        std::fprintf(stderr, "invalid --port (expected 1..65535)\n");
        return 2;
      }
    } else if (a == "--web-root" && i + 1 < argc) {
      webRootArg = argv[++i];
    } else if (a == "--no-open") {
      openRequested = false;
    } else if (a == "--open") {
      forceOpen = true;
    } else if (a == "--help" || a == "-h") {
      std::printf(
          "usage: %s [--port N] [--web-root DIR] [--open | --no-open]\n"
          "  --port N        listen port on 127.0.0.1 (default 37811)\n"
          "  --web-root DIR  built front end to serve (default: auto-detect ./web next to the binary)\n"
          "  --open          open the browser even when stdout is not an interactive console\n"
          "  --no-open       never open a browser (also: DC_NO_OPEN=1)\n",
          self);
      return 0;
    } else {
      std::fprintf(stderr, "warning: ignoring unknown option '%s' (see --help)\n", a.c_str());
    }
  }

  // A GUI-launched process has no console at all, so every line below would be written into a
  // dead handle and the window the user expects would never appear. Create it before the first
  // status line; on POSIX there is nothing to create and this is a no-op.
  const bool consoleCreated = dc::launch::ensureConsole();

  const std::string webRoot = findWebRoot(webRootArg, argc > 0 ? argv[0] : nullptr);
  const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/";

  dc::launch::Signals signals;
  signals.openRequested = openRequested;
  signals.forceOpen = forceOpen || envFlag("DC_OPEN");
  signals.envNoOpen = envFlag("DC_NO_OPEN");
  signals.ci = std::getenv("CI") != nullptr;
  signals.haveUi = !webRoot.empty();
  signals.stdoutIsTty = dc::launch::stdoutIsTty();
  signals.consoleCreated = consoleCreated;

  const bool openBrowser = dc::launch::shouldOpenBrowser(signals);
  const char* suppressed = openBrowser ? nullptr : dc::launch::browserSuppressedReason(signals);

  dc::MatrixStore store;
  dc::EventBus bus;
  dc::NodeRegistry nodes(&store, &bus);
  dc::HttpServer server(port, &store, &nodes, &bus, webRoot);

  // ASCII only: an existing console may still be a legacy code page, and a mojibake banner is
  // worse than a plain one.
  std::printf("DataCardForge - compute backend + web UI   (build %s, protocol 1)\n", DC_BUILD_SHA);
  std::printf("  address    %s\n", url.c_str());
  if (webRoot.empty()) {
    // The packaged layout is "datacardforge + web/ in the same folder", so the usual way to
    // get here with a release archive is running the exe from inside the zip preview (it is
    // expanded to a temp folder that holds only the exe) — say that, do not just say "API only".
    std::printf("  ui         not found - no web/index.html next to the binary\n"
                "             - release archive: extract the whole zip first; web/ belongs beside the exe\n"
                "             - source checkout: `cd web && npm run build`, or pass --web-root <dir>\n");
  } else {
    std::printf("  ui         %s\n", webRoot.c_str());
  }
  if (openBrowser) {
    std::printf("  browser    opening it once the port is up   (--no-open disables)\n");
  } else {
    std::printf("  browser    not opened: %s\n"
                "             open %s yourself\n",
                suppressed, url.c_str());
  }
  std::printf("  runtime    data lives in memory only; Ctrl+C or closing this window stops it\n");
  std::fflush(stdout);
  dc::launch::setConsoleTitle("DataCardForge - " + url);

  // Opened only after the listening socket is ready, so the tab never lands on a refused
  // connection. A browser that refuses to launch is reported rather than swallowed: the
  // address is on screen anyway.
  if (openBrowser) {
    server.setOnReady([url] {
      if (!dc::launch::openInBrowser(url)) {
        std::printf("  browser    could not launch one - open %s yourself\n", url.c_str());
        std::fflush(stdout);
      }
    });
  }

  if (!server.serve()) {
    const int retryPort = port > 1 ? port - 1 : port + 1;
    std::fprintf(stderr,
                 "\n[!] could not listen on %s\n"
                 "    the port is probably taken; only one process can serve it.\n"
                 "    - if DataCardForge is already running, just open the address above\n"
                 "    - otherwise use a free port:  %s --port %d\n",
                 url.c_str(), self, retryPort);
    std::fflush(stderr);
    // A double-clicked failure would otherwise close this window in ~50 ms and leave the user
    // with exactly the report this fixes: "nothing happened, no browser, no terminal".
    dc::launch::waitBeforeExit(!signals.ci);
    return 1;
  }
  return 0;
}
