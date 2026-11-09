#!/usr/bin/env python3
"""docs-check.py — docs/ 的护栏（导航覆盖、死链、字符画残留、图孤儿、中英配对、SVG 合法性）。

本仓库的文档是长期维护的设计记录，靠"记得去改"会锈；把能机械判定的部分交给这个脚本：

  1. 导航覆盖：git 追踪的 docs/**/*.md（README 自身除外）都必须能从 docs/README.md 链到；
  2. 死链：docs/ 与根目录产品文档里的相对链接 / 图片目标必须存在；
  3. 字符画残留：.md 里不许再出现框线字符（示意图一律 SVG，见 docs/README.md 「图」一节）；
  4. 图引用：docs/diagrams/*.svg 每个都被至少一篇 .md 引用，且被引用的图确实存在；
  5. 中英配对：X.zh.svg <-> X.en.svg、双语规范 X.md <-> X.en.md；
  6. SVG 合法性：可解析、有 viewBox 与 <title>、无 <script>、不引外部资源。

用法：python3 scripts/docs-check.py [--root <repo>]
退出码：0 全绿；1 发现问题；2 环境问题（不在仓库里、git 不可用）。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# 框线字符：出现即说明有人又画了一张字符画（`──` 这种代码注释分隔线不在集合里）。
BOX_CHARS = set("┌└├│▼▲►◄┐┘┤┌┐┬┴┼═║╔╗╚╝")

# 必须有英文版的规范类文档（语言策略见 docs/README.md）。
BILINGUAL_MD = [
    "docs/README.md",
    "docs/history.md",
    "docs/architecture/backend-protocol-v1.md",
    "docs/architecture/port-semantics-v1.md",
    "docs/architecture/frontend-imgui-vs-web.md",
]

# 参与死链检查的根目录产品文档（docs/ 之外的入口文档）。
ROOT_DOCS = [
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "CONTRIBUTING.zh-CN.md",
    "SECURITY.md",
    "SECURITY.zh-CN.md",
    "CHANGELOG.md",
    "CHANGELOG.zh-CN.md",
    "PROVENANCE.md",
    "AGENTS.md",
    "web/README.md",
    "web/docs/screenshots/README.md",
]

LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
# 「某篇 .md 的 §N」——跨文件小节引用。指错了，读者就找不到那一节。
SECREF_RE = re.compile(r"([\w./-]+\.md)`?[^\n§]{0,60}?§\s*(\d+(?:\.\d+)?)")


class Report:
    def __init__(self) -> None:
        self.problems: list[str] = []

    def fail(self, where: str, msg: str) -> None:
        self.problems.append(f"{where}: {msg}")

    def ok(self) -> bool:
        for p in self.problems:
            print(f"  ✗ {p}")
        return not self.problems


def tracked_files(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True, capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:  # pragma: no cover
        print(f"docs-check: 无法运行 git ls-files（{exc}）——请在仓库里跑。", file=sys.stderr)
        raise SystemExit(2)
    return [p for p in out.decode("utf-8").split("\0") if p]


def local_target(source: Path, raw: str) -> Path | None:
    """把 markdown 链接目标解析成本地路径；外链 / 纯锚点返回 None。"""
    target = raw.strip()
    if not target or target.startswith(("http://", "https://", "mailto:", "tel:", "#")):
        return None
    target = target.split("#", 1)[0]
    if not target:
        return None
    target = target.replace("%20", " ")
    return (source.parent / target).resolve()


def check_links(root: Path, files: list[str], rep: Report) -> None:
    for rel in files:
        path = root / rel
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            rep.fail(rel, "不是 UTF-8 文本")
            continue
        for m in LINK_RE.finditer(text):
            resolved = local_target(path, m.group(1))
            if resolved is None:
                continue
            if not resolved.exists():
                line = text.count("\n", 0, m.start()) + 1
                rep.fail(rel, f"第 {line} 行死链 → {m.group(1)}")


def check_nav(root: Path, docs_md: list[str], rep: Report) -> None:
    nav = root / "docs/README.md"
    if not nav.exists():
        rep.fail("docs/README.md", "导航文件不存在")
        return
    text = nav.read_text(encoding="utf-8")
    linked = set()
    for m in LINK_RE.finditer(text):
        resolved = local_target(nav, m.group(1))
        if resolved is None:
            continue
        try:
            linked.add(resolved.relative_to(root.resolve()).as_posix())
        except ValueError:
            continue
    for rel in docs_md:
        if rel == "docs/README.md":
            continue
        if rel not in linked:
            rep.fail("docs/README.md", f"导航里没有 {rel}")


def check_ascii_art(root: Path, md_files: list[str], rep: Report) -> None:
    for rel in md_files:
        text = (root / rel).read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            hits = sorted({c for c in line if c in BOX_CHARS})
            if hits:
                rep.fail(rel, f"第 {lineno} 行还有字符画（{''.join(hits)}）——示意图请用 SVG")


def check_diagrams(root: Path, md_files: list[str], svgs: list[str], rep: Report) -> None:
    referenced: dict[str, list[str]] = {}
    for rel in md_files:
        text = (root / rel).read_text(encoding="utf-8", errors="replace")
        for m in LINK_RE.finditer(text):
            resolved = local_target(root / rel, m.group(1))
            if resolved is None or resolved.suffix != ".svg":
                continue
            try:
                key = resolved.relative_to(root.resolve()).as_posix()
            except ValueError:
                continue
            referenced.setdefault(key, []).append(rel)

    for svg in svgs:
        if svg not in referenced:
            rep.fail(svg, "没有被任何 .md 引用（孤儿图）——要么挂进正文，要么删掉")

    for svg in svgs:
        check_svg(root / svg, svg, rep)

    # 成对：.zh.svg <-> .en.svg
    for svg in svgs:
        if svg.endswith(".zh.svg"):
            pair = svg[: -len(".zh.svg")] + ".en.svg"
        elif svg.endswith(".en.svg"):
            pair = svg[: -len(".en.svg")] + ".zh.svg"
        else:
            continue
        if not (root / pair).exists():
            rep.fail(svg, f"缺少成对的 {Path(pair).name}")


def check_svg(path: Path, rel: str, rep: Report) -> None:
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        rep.fail(rel, f"不是合法 XML（{exc}）")
        return
    root = tree.getroot()
    if not root.tag.endswith("svg"):
        rep.fail(rel, f"根元素不是 <svg>（{root.tag}）")
        return
    if "viewBox" not in root.attrib:
        rep.fail(rel, "缺少 viewBox（<img> 引用时无法自适应缩放）")

    tags = [el.tag.rsplit("}", 1)[-1] for el in root.iter()]
    if "script" in tags:
        rep.fail(rel, "含 <script>：作为 <img> 引用时会被浏览器拒绝执行，交互请放 HTML")
    if "foreignObject" in tags:
        rep.fail(rel, "含 <foreignObject>：GitHub / Obsidian 的渲染路径不可靠")
    if "title" not in tags:
        rep.fail(rel, "缺少 <title>（无障碍与悬停提示都需要）")
    if "desc" not in tags:
        rep.fail(rel, "缺少 <desc>")

    for el in root.iter():
        for attr in ("href", "{http://www.w3.org/1999/xlink}href"):
            value = el.attrib.get(attr)
            if value and not value.startswith(("#", "data:")):
                rep.fail(rel, f"引用了外部资源（{attr}={value}）——图必须自包含")
        if el.tag.rsplit("}", 1)[-1] == "style" and el.text and "@import" in el.text:
            rep.fail(rel, "<style> 里 @import 了外部样式")


def heading_numbers(path: Path) -> set[str]:
    """收集一篇文档里出现过的小节编号（##/###/#### 开头的阿拉伯数字）。"""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return set()
    return {
        m.group(1)
        for m in re.finditer(r"(?m)^#{2,4}\s+(\d+(?:\.\d+)?)[.、\s]", text)
    }


def check_section_refs(root: Path, files: list[str], rep: Report) -> None:
    """`foo.md §N` 里的 N 必须是 foo.md 真实存在的小节编号。"""
    cache: dict[Path, set[str]] = {}
    for rel in files:
        path = root / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(text.split("\n"), 1):
            for m in SECREF_RE.finditer(line):
                target_raw, num = m.group(1), m.group(2)
                if target_raw.isdigit():
                    continue
                target = (path.parent / target_raw).resolve()
                if target == path.resolve() or not target.exists():
                    continue  # 同文件引用与死链交给别的检查
                if target not in cache:
                    cache[target] = heading_numbers(target)
                heads = cache[target]
                top = num.split(".")[0]
                if num in heads or top in heads:
                    continue
                where = f"第 {lineno} 行引用 {target_raw} §{num}"
                if not heads:
                    rep.fail(rel, f"{where}，但该文件没有编号小节——按小节标题引用")
                else:
                    rep.fail(rel, f"{where}，该文件里没有这一节")


def check_bilingual(root: Path, rep: Report) -> None:
    for rel in BILINGUAL_MD:
        en = rel[: -len(".md")] + ".en.md"
        for pair in (rel, en):
            if not (root / pair).exists():
                rep.fail(pair, "双语规范文档缺失（见 docs/README.md 语言策略）")


def main() -> int:
    ap = argparse.ArgumentParser(description="docs/ 护栏")
    ap.add_argument("--root", default=".", help="仓库根目录（默认当前目录）")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not (root / "docs").is_dir():
        print("docs-check: 这里没有 docs/ 目录——请在仓库根跑。", file=sys.stderr)
        return 2

    files = tracked_files(root)
    docs_md = sorted(f for f in files if f.startswith("docs/") and f.endswith(".md"))
    svgs = sorted(f for f in files if f.startswith("docs/diagrams/") and f.endswith(".svg"))
    root_md = [f for f in ROOT_DOCS if f in files]
    if not docs_md:
        print("docs-check: git 里没有 docs/**/*.md——是不是在子模块或裸目录里跑？", file=sys.stderr)
        return 2

    rep = Report()
    check_nav(root, docs_md, rep)
    check_links(root, docs_md + root_md, rep)
    check_ascii_art(root, docs_md + root_md, rep)
    check_diagrams(root, docs_md + root_md, svgs, rep)
    check_section_refs(root, docs_md + root_md, rep)
    check_bilingual(root, rep)

    checked = (
        f"{len(docs_md)} 篇 docs 文档 / {len(root_md)} 篇根目录文档 / "
        f"{len(svgs)} 张图"
    )
    if rep.ok():
        print(f"docs-check: 全绿（{checked}）")
        return 0
    print(f"\ndocs-check: {len(rep.problems)} 个问题（{checked}）", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
