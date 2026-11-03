#!/usr/bin/env python3
"""Compose a bilingual release body.

The release page must be readable in both languages by default, so the body is two
collapsed sections: Chinese first (the project's original language), English second. Each
section carries that language's CHANGELOG entry for the release plus that language's asset
guide, so a reader never has to jump between halves.

Sources:
  CHANGELOG.md / CHANGELOG.zh-CN.md   — per-version notes (the `## [x.y.z]` section)
  .github/release-assets.md           — one file holding both halves as <details> blocks

Usage:
  compose-release-notes.py --version 0.1.1 --en-changelog CHANGELOG.md \
      --zh-changelog CHANGELOG.zh-CN.md --assets .github/release-assets.md --out body.md
"""

from __future__ import annotations

import argparse
import re
import sys


def changelog_section(path: str, version: str) -> str:
    """The body of `## [version] …` up to the next `## [` heading."""
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:  # a missing file is a broken build, not an empty release
        raise SystemExit(f"compose-release-notes: cannot read {path}: {exc}")

    heading = re.search(r"^(## \[" + re.escape(version) + r"\][^\n]*)\n?", text, re.M)
    if not heading:
        raise SystemExit(f"compose-release-notes: {path} has no '## [{version}]' section")
    rest = text[heading.end():]
    nxt = re.search(r"^## \[", rest, re.M)
    body = (rest[: nxt.start()] if nxt else rest).strip("\n")
    return heading.group(1) + "\n\n" + body


def asset_halves(path: str) -> dict[str, str]:
    """Split the combined asset guide into {summary text: body}."""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    blocks = re.findall(r"<details>\s*<summary>(.*?)</summary>(.*?)</details>", text, re.S)
    out: dict[str, str] = {}
    for summary, body in blocks:
        out[summary.strip()] = body.strip("\n")
    if not out:
        raise SystemExit(f"compose-release-notes: {path} has no <details> blocks")
    return out


def pick(halves: dict[str, str], needle: str) -> str:
    for summary, body in halves.items():
        if needle in summary:
            return body
    raise SystemExit(f"compose-release-notes: no <details> block matching {needle!r}")


def section(summary: str, parts: list[str]) -> str:
    body = "\n\n".join(part for part in parts if part)
    return f"<details>\n<summary>{summary}</summary>\n\n{body}\n\n</details>"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="version without the leading v")
    parser.add_argument("--en-changelog", required=True)
    parser.add_argument("--zh-changelog", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    halves = asset_halves(args.assets)
    zh = section(
        "中文",
        [changelog_section(args.zh_changelog, args.version), pick(halves, "中文")],
    )
    en = section(
        "English",
        [changelog_section(args.en_changelog, args.version), pick(halves, "English")],
    )

    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(zh + "\n\n" + en + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
