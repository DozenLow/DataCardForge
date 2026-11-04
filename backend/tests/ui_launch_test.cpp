// The launch rule that decides whether the packaged binary opens a browser.
//
// This is the half of "double-click opens neither a browser nor a terminal" that can be
// pinned down without Windows: the old code required `isatty(stdout)`, and a process launched
// from Explorer (or any launcher) has no console at all, so the answer was always "no".
// The rule now counts "we created the console ourselves" as interactive.
//
// The other half — AllocConsole, ShellExecuteW, waiting before the window closes — is
// platform API and is only compiled on Windows; the truth table below is what has to stay
// correct, so it is exercised from an ordinary ctest entry on every platform.
#include <cstdio>
#include <string>

#include "ui_launch.h"

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

namespace {

using dc::launch::browserSuppressedReason;
using dc::launch::shouldOpenBrowser;
using dc::launch::Signals;

// A normal interactive run: a terminal, a web root, nothing asking for suppression.
Signals interactive() {
  Signals s;
  s.haveUi = true;
  s.stdoutIsTty = true;
  return s;
}

bool reason(const Signals& s, const std::string& expected) {
  const char* why = browserSuppressedReason(s);
  return why != nullptr && std::string(why).find(expected) != std::string::npos;
}

}  // namespace

int main() {
  // ── opens ─────────────────────────────────────────────────────────────
  {
    const Signals s = interactive();
    CHECK(shouldOpenBrowser(s));
    CHECK(browserSuppressedReason(s) == nullptr);
  }
  {
    // Explorer double-click on a GUI-launched process: no TTY, but ensureConsole() gave the
    // user a window, so there is someone to see the browser open.
    Signals s = interactive();
    s.stdoutIsTty = false;
    s.consoleCreated = true;
    CHECK(shouldOpenBrowser(s));
  }
  {
    // DC_OPEN=1 / --open: an explicit "yes" outranks the non-interactive guess (a .cmd
    // wrapper that redirects its own output to a log is the case this exists for).
    Signals s = interactive();
    s.stdoutIsTty = false;
    s.forceOpen = true;
    CHECK(shouldOpenBrowser(s));
  }

  // ── stays closed, with a reason the user can act on ───────────────────
  {
    // Nothing interactive anywhere: a service, a scheduled task in a session without a
    // desktop. Keep running headless instead of opening a tab nobody asked for.
    Signals s = interactive();
    s.stdoutIsTty = false;
    CHECK(!shouldOpenBrowser(s));
    CHECK(reason(s, "not an interactive console"));
  }
  {
    // --no-open outranks --open: an explicit "no" is the last word.
    Signals s = interactive();
    s.openRequested = false;
    s.forceOpen = true;
    CHECK(!shouldOpenBrowser(s));
    CHECK(reason(s, "--no-open"));
  }
  {
    Signals s = interactive();
    s.envNoOpen = true;
    CHECK(!shouldOpenBrowser(s));
    CHECK(reason(s, "DC_NO_OPEN"));
  }
  {
    // CI: the stress gates spawn this binary; a browser window per run would be a bug.
    Signals s = interactive();
    s.ci = true;
    CHECK(!shouldOpenBrowser(s));
    CHECK(reason(s, "CI"));
  }
  {
    // API-only run: nothing to show, so do not open a tab onto a 404.
    Signals s = interactive();
    s.haveUi = false;
    CHECK(!shouldOpenBrowser(s));
    CHECK(reason(s, "web/"));
  }
  {
    // ...even when the user forces it, and even from a GUI launch.
    Signals s = interactive();
    s.haveUi = false;
    s.forceOpen = true;
    s.consoleCreated = true;
    CHECK(!shouldOpenBrowser(s));
    CHECK(reason(s, "web/"));
  }
  {
    // CI still wins over a force flag: tests are not allowed to pop a browser.
    Signals s = interactive();
    s.ci = true;
    s.forceOpen = true;
    s.envNoOpen = false;
    CHECK(!shouldOpenBrowser(s));
  }

  // ── the two entry points can never disagree ───────────────────────────
  {
    // Every flag combination, including the ones the scenarios above do not happen to pair:
    // `shouldOpenBrowser` is defined as "there is no reason to suppress", and this pins that
    // definition down instead of trusting it.
    int combinations = 0;
    for (int bits = 0; bits < (1 << 7); ++bits) {
      Signals s;
      s.openRequested = (bits & 1) != 0;
      s.forceOpen = (bits & 2) != 0;
      s.envNoOpen = (bits & 4) != 0;
      s.ci = (bits & 8) != 0;
      s.haveUi = (bits & 16) != 0;
      s.stdoutIsTty = (bits & 32) != 0;
      s.consoleCreated = (bits & 64) != 0;
      const char* why = browserSuppressedReason(s);
      CHECK(shouldOpenBrowser(s) == (why == nullptr));
      // A closed browser always carries a reason; an open one never does.
      if (!shouldOpenBrowser(s)) CHECK(why != nullptr && why[0] != '\0');
      ++combinations;
    }
    CHECK(combinations == 128);
  }

  std::printf("%s: ui_launch rule (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
