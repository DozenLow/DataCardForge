// Platform half of the launch story (see ui_launch.h for why it exists): make sure a console
// window is visible, put the status in it, and open the browser on the address it reports.
//
// Kept out of main.cpp because all of it is platform API — and because the rule it serves is
// a pure truth table that the test target can exercise without any of this compiling.
#include "ui_launch.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#  include <shellapi.h>
#  include <io.h>
#else
#  include <unistd.h>
#endif

namespace dc::launch {

namespace {

#ifdef _WIN32
bool g_consoleCreated = false;

// How many processes share this console. A console created for a double-click contains only
// us; one that belongs to cmd.exe / PowerShell contains the shell as well. Used to decide
// whether the window would vanish with us (pause) or stay (leave it alone).
DWORD consoleProcessCount() {
  DWORD pids[8];
  return GetConsoleProcessList(pids, 8);
}

// Whether a stdio stream already has somewhere to go. A windowless (GUI) launch has none,
// while a redirected run — a log file, a test harness pipe — does, and that redirection must
// survive: sending it into the new console would silently move a CI log into a window nobody
// reads.
bool streamIsUsable(FILE* stream) {
  const int fd = _fileno(stream);
  if (fd < 0) return false;
  const intptr_t raw = _get_osfhandle(fd);
  if (raw == -1) return false;  // no handle at all: this stream never had a destination
  const DWORD type = GetFileType(reinterpret_cast<HANDLE>(raw));
  if (type != FILE_TYPE_UNKNOWN) return true;  // char device, pipe or disk
  return GetLastError() == NO_ERROR;           // "unknown device", but a live handle
}

// Windows has no std::wstring ctor from std::string iterators with a locale-free widening
// guarantee, but every string here is either ASCII or a path we do not want to transcode:
// a plain byte-to-wchar copy is the behaviour the console APIs expect for UTF-8 sources.
std::wstring widen(const std::string& s) { return std::wstring(s.begin(), s.end()); }
#endif

}  // namespace

bool stdoutIsTty() {
#ifdef _WIN32
  return _isatty(_fileno(stdout)) != 0;
#else
  return isatty(fileno(stdout)) != 0;
#endif
}

bool ensureConsole() {
#ifdef _WIN32
  if (GetConsoleWindow() != nullptr) return false;  // started from a shell: already visible
  if (!AllocConsole()) {
    // A process started with CREATE_NO_WINDOW is attached to a console that has no window
    // at all, which is why AllocConsole refuses: detach that one and take a real one.
    FreeConsole();
    if (!AllocConsole()) return false;  // no interactive desktop (a service): stay headless
  }
  g_consoleCreated = true;
  // The stdio streams were bound to the (invalid) inherited handles before the console
  // existed; point the dead ones at the new console or every printf below still goes nowhere.
  // Redirected ones are left alone — see streamIsUsable().
  if (!streamIsUsable(stdout)) std::freopen("CONOUT$", "w", stdout);
  if (!streamIsUsable(stderr)) std::freopen("CONOUT$", "w", stderr);
  if (!streamIsUsable(stdin)) std::freopen("CONIN$", "r", stdin);
  SetConsoleOutputCP(CP_UTF8);  // so a non-ASCII install path prints as itself, not as mojibake
  return true;
#else
  return false;
#endif
}

void setConsoleTitle(const std::string& title) {
#ifdef _WIN32
  SetConsoleTitleW(widen(title).c_str());
#else
  // Same idea via the terminal's OSC title sequence, only when something is listening.
  if (stdoutIsTty()) std::printf("\033]0;%s\007", title.c_str());
#endif
}

bool openInBrowser(const std::string& url) {
#ifdef _WIN32
  // ShellExecuteW hands the URL straight to the shell's default-browser handler: no cmd.exe,
  // no quoting rules and no COMSPEC lookup. The old `system("start \"\" \"url\"")` route goes
  // through cmd.exe and simply does nothing when COMSPEC/PATH are unusual — which is exactly
  // how "it never opens the browser" was reported. `start` stays as the fallback.
  const INT_PTR rc = reinterpret_cast<INT_PTR>(
      ShellExecuteW(nullptr, L"open", widen(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL));
  if (rc > 32) return true;  // ShellExecute's documented success range
  const std::string cmd = "start \"\" \"" + url + "\"";
  return std::system(cmd.c_str()) == 0;
#elif defined(__APPLE__)
  if (std::system("command -v open >/dev/null 2>&1") != 0) return false;
  return std::system(("open \"" + url + "\" >/dev/null 2>&1 &").c_str()) == 0;
#else
  if (std::system("command -v xdg-open >/dev/null 2>&1") != 0) return false;
  return std::system(("xdg-open \"" + url + "\" >/dev/null 2>&1 &").c_str()) == 0;
#endif
}

void waitBeforeExit(bool allowed, int timeoutMs) {
#ifdef _WIN32
  if (!allowed) return;
  // Only when the window is ours: a shell keeps its own window open, and pausing there would
  // block a script that merely ran a failing command.
  if (!g_consoleCreated && consoleProcessCount() != 1) return;
  std::printf("\nPress Enter to close this window...\n");
  std::fflush(stdout);
  const HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  if (in == nullptr || in == INVALID_HANDLE_VALUE) return;
  // Bounded: a double-clicked failure keeps its message readable, an unattended run still exits.
  if (WaitForSingleObject(in, static_cast<DWORD>(timeoutMs > 0 ? timeoutMs : 0)) != WAIT_OBJECT_0) {
    return;
  }
  char line[8];
  (void)std::fgets(line, sizeof line, stdin);
#else
  (void)allowed;
  (void)timeoutMs;
#endif
}

}  // namespace dc::launch
