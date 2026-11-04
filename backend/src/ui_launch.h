// How the packaged binary introduces itself to a human: a console window that reports where
// it is listening, and a browser tab pointed at that address.
//
// Both halves were reported missing at once — "clicking the exe opens neither a browser nor
// a terminal" — and they share one root cause: the old code only opened a browser when
// `isatty(stdout)` said yes, and a Windows process that was *not* started from a shell has
// no console at all. There is then no TTY to detect and no window to print into, so both
// behaviours disappeared together while the server itself was running fine.
//
// The rule below therefore treats "we had to create the console ourselves" as interactive,
// and the platform layer (ui_launch.cpp) creates one when it is missing. The decision is a
// pure truth table so it can be tested without a terminal, a desktop session or Windows;
// AllocConsole / ShellExecuteW only compile on Windows.
#pragma once

#include <string>

namespace dc::launch {

// Everything the "open a browser?" answer depends on, as plain booleans.
struct Signals {
  bool openRequested = true;   // false for --no-open
  bool forceOpen = false;      // --open or DC_OPEN=1: open through the non-TTY case
  bool envNoOpen = false;      // DC_NO_OPEN=1
  bool ci = false;             // CI is set: never spawn a browser from a test run
  bool haveUi = false;         // a web root was found, so there is something to open
  bool stdoutIsTty = false;    // isatty(stdout)
  bool consoleCreated = false; // we had to create the console: a human can see it after all
};

// Why the UI is not opened, or nullptr when it should be. Precedence matters: an explicit
// --no-open must beat DC_OPEN, and CI must beat everything except the explicit flags —
// otherwise the stress gates would pop a browser on every run.
inline const char* browserSuppressedReason(const Signals& s) {
  if (!s.openRequested) return "--no-open was passed";
  if (s.envNoOpen) return "DC_NO_OPEN is set";
  if (s.ci) return "CI is set";
  if (!s.haveUi) return "no web/ directory was found (API only)";
  if (s.forceOpen || s.stdoutIsTty || s.consoleCreated) return nullptr;
  return "stdout is not an interactive console (use --open to force)";
}

inline bool shouldOpenBrowser(const Signals& s) { return browserSuppressedReason(s) == nullptr; }

// True when stdout is a terminal (POSIX) / an attached console (Windows).
bool stdoutIsTty();

// Makes sure the status lines have somewhere visible to go. On Windows a GUI-launched
// process (Explorer, a launcher using CREATE_NO_WINDOW, a scheduled task) has no console, so
// printf writes into a dead handle and the window the user expects never appears; this
// allocates one and rebinds stdin/stdout/stderr to it. Returns true when it created the
// console (POSIX: always false — there is no console to create).
bool ensureConsole();

// Puts the product name (and, once known, the address) in the console title, so the window
// is recognisable in the task bar instead of reading "datacardforge.exe". No-op on POSIX.
void setConsoleTitle(const std::string& title);

// Hands the URL to the platform's default browser. Returns false when the launch clearly
// failed, so the caller can print the address for a manual open instead of staying silent.
bool openInBrowser(const std::string& url);

// Keeps the console window from closing before the last line is read: on Windows a
// double-clicked console app owns a console that dies with the process, so a startup failure
// flashes by in ~50 ms — the "no terminal to report the status" half of the report.
//
// It pauses only when the console belongs to this process (we created it, or no shell is
// attached to it) and never longer than `timeoutMs`, so an unattended run still ends; the
// caller passes `allowed=false` for CI. No-op on POSIX, where the terminal already persists.
void waitBeforeExit(bool allowed, int timeoutMs = 15000);

}  // namespace dc::launch
