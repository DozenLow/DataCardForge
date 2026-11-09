# docs/ — Design records (Obsidian vault)

English | [中文](README.md)

This directory holds the project's **design records**: why things are the way they are, and which roads
were considered and dropped. Three entrances, each answering one question:

| Question | Where |
|---|---|
| **What is it, how do I use it** | repository root [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) |
| **Where the project is now, what to verify next** | repository root `STATE.md` — the only authority; when docs and code disagree, it wins |
| **Why is it like this, what did we give up** | this directory |

- **Last reviewed**: 2026-11-04 (the HEAD at review time is in `STATE.md`)
- Ownership, data provenance and the AI-usage statement: [`PROVENANCE.md`](../PROVENANCE.md) (Chinese only)

> Optional: in Obsidian, "Open folder as vault" → pick this `docs/` directory.

## How to read

- **5 minutes**: [history](history.md) §1 (one sentence) + §2 (decision flow diagram)
- **Half an hour**: add §4 "four eras", then the three decisions marked ← below
- **Before changing anything**: `history.md` §5 (four spirals) and §6 (lesson list), then the
  specifications under `architecture/`
- **To replay the traps**: `log/` by date, `lessons/` by topic, `audits/` for one whole review

## Navigation

- 🧭 **Project history** (`history.md`) — the decisions, logs, lessons and audits chained into one
  causal history: four eras, four spirals, a lesson list and the current state
  - [Project history (DataCardForge)](history.en.md) ← **read this one before the individual volumes**
- 📌 **Decision records** (`decisions/`) — settled, direction-setting conclusions
  - [Regression card renamed to "relation enumeration": picking a column is a port binding, headers carry X : Y](decisions/2026-10-31-relation-enum-card.md) ← **latest: cards can finally pick columns; horizontal table-scroll alignment fixed too**
  - [Data cards can replace their file: replacing follows automatically, switching still re-points explicitly](decisions/2026-10-31-file-replacement.md) ← **a saved workspace finally works as a template**
  - [Result preview: DCM2 frames for dense matrices (24-byte header + full table shape)](decisions/2026-10-29-result-preview.md) ← large results are no longer shipped whole
  - [Connection anchors land on port centres, not on card-edge midpoints](decisions/2026-10-29-connection-center-anchors.md) ← wires finally point where the data flows
  - [Engine-level performance gate: 12 cases, p50×3 budget, 1.3× regression guard](decisions/2026-10-29-perf-gate.md) ← turns "it got slower" into an executable number
  - [Three real defects in function-card output binding: local id · upload race · entry points vanishing with an empty result table](decisions/2026-10-28-function-card-output-binding.md) ← the root cause of "No result yet"
  - [Expression column-reference syntax: names, qualification, full-width punctuation](decisions/2026-10-28-expression-reference-syntax.md) ← formula cards work again on files with headers
  - [Port-level connections: edges carry portId, endpoints land on ports](decisions/2026-10-28-port-level-connections.md) ← connections return to full dependency visualisation (same day)
  - [Summary (`builtin:summary`) v1: statistic catalogue, lazy evaluation, numbers stay in the backend](decisions/2026-10-27-summary-builtin.md) ← the first lazy signature; the catalogue *is* the row order
  - [The three contracts of a function card (column count · parameter ownership · single-column ports)](decisions/2026-10-27-card-contracts.md) ← pinned down three ambiguities during implementation
  - [Card data structure v2 (dependencies promoted to the envelope, function card = one node, K outputs)](decisions/2026-10-26-card-schema-v2.md) ← **implemented**, the foundation of function cards
  - [Canvas becomes an unbounded plane (pan, no zoom)](decisions/2026-10-21-infinite-canvas.md) ← **current view model: a workflow is no longer limited to one screen**
  - [The backend owns data and compute](decisions/2026-10-17-backend-owns-compute.md) ← current layering ruling: the browser is pure interaction, revising the T1 baseline
  - [Headroom principle (maximum headroom)](decisions/2026-10-15-max-headroom-principle.md) ← **core architecture principle** (the tier table was revised by the 10-17 decision; the contracts still hold)
  - [Qt implementation removed entirely](decisions/2026-10-15-qt-implementation-removed.md) ← **current repository shape**
  - [Frontend choice settled on Web](decisions/2026-10-14-frontend-web-chosen.md) ← **current frontend plan**
  - [Chart library stays ECharts](decisions/2026-10-14-chart-library-audit.md) ← audit of statistical chart types and vector export
  - [Backend first, frontend paused](decisions/2026-08-07-backend-first-frontend-paused.md) (the "frontend paused" part was superseded above; "backend first" was revived and extended by the 10-17 decision)
  - [Connection subordination principle](decisions/2026-08-07-connection-subordination.md)
- 📐 **Specifications** (`architecture/`) — finalised contracts the implementation must obey
  (changing one = change this file before the code)
  - [Backend protocol v1](architecture/backend-protocol-v1.en.md) · [中文](architecture/backend-protocol-v1.md) ← transport / resource / error / fixture contract for backend compute; stages 1–2 were implemented against it, and this document is authoritative for endpoints and frame formats
  - [Port semantics v1](architecture/port-semantics-v1.en.md) · [中文](architecture/port-semantics-v1.md) ← contract for port identity, binding and cross-tier semantics
- ⚖️ **Architecture trade-offs** (`architecture/`) — historical comparison documents; most conclusions
  have since been superseded by decision records. Read only to understand "why not the other side"
  - [Frontend choice: ImGui vs Web](architecture/frontend-imgui-vs-web.en.md) · [中文](architecture/frontend-imgui-vs-web.md)
    (✅ converged → Web, see the 10-14 decision; the comparison table is still reusable)
- 📊 **Audits** (`audits/`) — a complete adversarial review with numbered defects and re-verification
  - [2026-10-15 UI/chart defect audit](audits/2026-10-15-ui-chart-defect-audit.md) ← 34 defects in the first pass, 11 in the second, each re-checked
- 🕳️ **Lessons** (`lessons/`) — traps hit in practice and how to avoid them
  - [ImPlot v1.1 API overhaul](lessons/implot-v1.1-api.md)
  - [PushStyleColor under ImGui Docking](lessons/imgui-docking-pushstylecolor.md)
- 🧾 **Task briefs** (`tasks/`) — execution slices that fit in one session: preconditions, contract red
  lines, acceptance commands
  - [Summary panel P2 (frontend)](tasks/2026-10-29-summary-p2-panel.md) ← not started, blocked by
    "result preview / dense frames"
- 🗃 **Sample data** (`sampleData/`) — synthetic data for demos and manual checks; the generator reproduces it
  - [`1.txt`](sampleData/1.txt) · [`2.txt`](sampleData/2.txt) · [`generate_matrix.py`](sampleData/generate_matrix.py)
- 🖼 **Diagrams** (`diagrams/`) — every diagram as SVG plus the interactive page, see [Diagrams](#diagrams)
- 📅 **Development log** (`log/`) — progress by date (**latest 2026-11-04**)
  - [2026-11-04](log/2026-11-04.md) (docs rework: ASCII diagrams replaced with SVG + interactive page · navigation and facts · docs-check in CI)
  - [2026-10-31](log/2026-10-31.md) (data cards can replace files: replace follows · the 409 ordering problem · closeAllCards releases backend resources)
  - [2026-10-28](log/2026-10-28.md) (two user complaints → three real defects: pointer capture swallowing click · no usable column name on files with headers · the formula area squeezed to 0 by the result table)
  - [2026-10-27](log/2026-10-27.md) (function cards from spec to working: v2 landed · re-point confirmation · column-count contract · results plottable/chainable · the regression signature disproves generality)
  - [2026-10-21](log/2026-10-21.md) (stage 3: formula-card compute authority moves to the backend · differential fuzz gate · canvas becomes an unbounded plane)
  - [2026-10-17](log/2026-10-17.md) (backend-owned compute decided + toolchain verified + stage 0: decisions/protocol/cross-tier fixtures)
  - [2026-10-15](log/2026-10-15.md) (repository governance + Qt removed + fixes A/B/D/E/F)
  - [2026-10-14](log/2026-10-14.md) (frontend settled on Web + `web/` implemented)
  - [2026-08-07](log/2026-08-07.md)

## Diagrams

- [Decision flow](diagrams/decision-flow.en.svg) ← `history.md` §2
- [Port projection map](diagrams/port-projection.en.svg) ← `architecture/port-semantics-v1.md`
- [Current architecture](diagrams/architecture.en.svg) ← the same image is used in the root README "Architecture" section
- Interactive: [`interactive.html`](diagrams/interactive.html) — click a stage or component for its reasoning
  and sources; language and theme toggles. **It is a reading aid, not authoritative content**; opened over
  `file://` it degrades to a static image (the click-to-inspect needs HTTP).

When adding a diagram:

1. **SVG only** — no more ASCII art: it depends on monospace alignment and falls apart with another font
   or a narrow screen.
2. **Chinese/English pairs**: `X.zh.svg` is the original, `X.en.svg` the translation; each document links its own language.
3. **Self-describing**: `viewBox`, `<title>`, `<desc>`; colours go through CSS variables
   (`var(--x, #fallback)`) with dark values under `@media (prefers-color-scheme: dark)` — that way GitHub
   and Obsidian, which reference the file as an `<img>`, get the right palette too.
4. **Pure SVG**: no external fonts or scripts, text as `<text>` (selectable, searchable), no `<foreignObject>`.
5. **Caption and source in prose**: the image carries structure; the argument stays in the document. An
   image never replaces a decision record.
6. **Check it**: `python3 scripts/docs-check.py` validates navigation coverage, dead links, leftover ASCII
   art, orphaned diagrams, language pairing and SVG well-formedness.

## Ground rules

1. **Three entrances, three jobs**: what → root `README.md`; where the project is now → `STATE.md`; why → this
   directory. When they disagree, that is the order of precedence.
2. **User perspective first, technical plan second**: every architecture discussion starts from "how does
   the user think about this", technical analysis comes after ([decision background](decisions/2026-08-07-backend-first-frontend-paused.md)).
3. Every decision record should contain: background → options → conclusion → affected modules → future impact.
4. **Publishable content only**: design records are written for readers. `private/` is a machine-local
   directory (excluded by `.gitignore`), **not published with the repository**, and never linked from public docs.
5. **Where the behavioural rules come from**: the Qt implementation was deleted from the workspace on
   2026-10-15 (see the [decision](decisions/2026-10-15-qt-implementation-removed.md)). The earlier rule
   "a document must name the corresponding `src/widgets/` file" died with it — the **only authoritative
   definition** of connection geometry, the red/blue/grey palette, close protection and similar rules is
   now the TypeScript source and its tests. C++ file names left in historical documents no longer point
   at openable files; they are kept as citations of "where this rule came from".
6. **History is not rewritten**: decisions and logs record the judgement of that day. To update a conclusion,
   annotate in place and point at the newer document instead of editing the old judgement.
7. **Codenames resolve in place**: any number or codename in the prose (option A/B/C, T1/T2/T3,
   P0/P2…) must be defined in the same document or glossed on the spot, and retired codenames are never
   reused. The test: could someone reading only that sentence, a year from now, follow it?
8. **Neutral register**: state facts, mechanisms, evidence and cost. No evaluation ("the most expensive",
   "obviously", "actually", "precisely"), no self-narration ("we thought" → "the judgement at the time"),
   no commentary ("the irony is…"). Quotes of the user's words stay verbatim.

## Language policy

- **Specifications are bilingual**: `docs/README.md`, the three files under `architecture/` and
  `history.md` all have an English version — Chinese is `X.md`, English is `X.en.md` in the same
  directory. The two correspond one-to-one, and **Chinese is the original**; if they disagree, `X.md`
  wins and `X.en.md` should be fixed.
- **Diagrams are bilingual**: `X.zh.svg` / `X.en.svg`; the interactive page toggles language in place, so
  there is no `.en.html`.
- **Historical records are Chinese-only**: `decisions/`, `log/`, `lessons/`, `audits/` and `tasks/`
  record "the judgement of that day". Back-translating them adds little, so no English version is
  provided; translate on demand.
- **Requirement for new documents**: new specification documents must ship `X.en.md` alongside; new
  decision records and logs need not; new diagrams must ship the `.en.svg`.
- **Root-level product docs use the opposite convention**: English `README.md` / `CONTRIBUTING.md` /
  `SECURITY.md` / `CHANGELOG.md`, Chinese `README.zh-CN.md` etc. (suffix `.zh-CN.md`, the mirror image
  of `.en.md` here).
