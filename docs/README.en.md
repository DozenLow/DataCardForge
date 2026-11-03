# docs/ — Design records (Obsidian vault)

English | [中文](README.md)

This directory holds the project's **design records**, not the entry point of the product
documentation. It records *why* and *which roads were considered*; the product docs record *what*:

- Product docs and quick start: repository root [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md)
- Ownership, data provenance and the AI-usage statement: [`PROVENANCE.md`](../PROVENANCE.md) (Chinese only)

> Optional: in Obsidian, "Open folder as vault" → pick this `docs/` directory.

## Navigation

- 🧭 **Project history** (`history.md`) — the decisions, logs, lessons and audits chained into one
  causal history: four eras, four spirals, a list of lessons and an inventory of doc inconsistencies
  - [Project history (DataCardForge)](history.en.md) ← **read this one before the individual volumes**
- 📌 **Decision records** (`decisions/`) — settled, direction-setting conclusions
  - [Regression card renamed to "relation enumeration": picking a column is a port binding, headers carry X : Y](decisions/2026-10-31-relation-enum-card.md) ← **latest: cards can finally pick columns; horizontal table-scroll alignment fixed too**
  - [Data cards can replace their file: replacing follows automatically, switching still re-points explicitly](decisions/2026-10-31-file-replacement.md) ← **a saved workspace finally works as a template**
  - [Engine-level performance gate: 12 cases, p50×3 budget, 1.3× regression guard](decisions/2026-10-29-perf-gate.md) ← turns "it got slower" into an executable number
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
- 🕳️ **Lessons** (`lessons/`) — traps hit in practice and how to avoid them
  - [ImPlot v1.1 API overhaul](lessons/implot-v1.1-api.md)
  - [PushStyleColor under ImGui Docking](lessons/imgui-docking-pushstylecolor.md)
- 🧾 **Task briefs** (`tasks/`) — execution slices that fit in one session: preconditions, contract red
  lines, acceptance commands
  - [Summary panel P2 (frontend)](tasks/2026-10-29-summary-p2-panel.md) ← not started, blocked by
    "result preview / dense frames"
- 📅 **Development log** (`log/`) — progress by date
  - [2026-10-31](log/2026-10-31.md) (data cards can replace files: replace follows · the 409 ordering problem · closeAllCards releases backend resources)
  - [2026-10-28](log/2026-10-28.md) (two user complaints → three real defects: pointer capture swallowing click · no usable column name on files with headers · the formula area squeezed to 0 by the result table)
  - [2026-10-27](log/2026-10-27.md) (function cards from spec to working: v2 landed · re-point confirmation · column-count contract · results plottable/chainable · the regression signature disproves generality)
  - [2026-10-21](log/2026-10-21.md) (stage 3: formula-card compute authority moves to the backend · differential fuzz gate · canvas becomes an unbounded plane)
  - [2026-10-17](log/2026-10-17.md) (backend-owned compute decided + toolchain verified + stage 0: decisions/protocol/cross-tier fixtures)
  - [2026-10-15](log/2026-10-15.md) (repository governance + Qt removed + fixes A/B/D/E/F)
  - [2026-10-14](log/2026-10-14.md) (frontend settled on Web + `web/` implemented)
  - [2026-08-07](log/2026-08-07.md)

## Ground rules

1. The **authoritative document** is `README.zh-CN.md` at the repository root; this directory records
   "why" and the thinking process, the README records "what".
2. **User perspective first, technical plan second**: every architecture discussion starts from "how
   does the user think about this", technical analysis comes after
   ([decision background](decisions/2026-08-07-backend-first-frontend-paused.md)).
3. Every decision record should contain: background → options → conclusion → affected modules →
   future impact.
4. **Publishable content only**: design records are written for readers; notes about personal working
   habits do not belong here.
5. **Where the behavioural rules come from**: the Qt implementation was deleted from the workspace on
   2026-10-15 (see the [decision](decisions/2026-10-15-qt-implementation-removed.md)). The earlier rule
   "a document must name the corresponding `src/widgets/` file" died with it — the **only authoritative
   definition** of connection geometry, the red/blue/grey palette, close protection and similar rules is
   now the TypeScript source and its tests. C++ file names left in historical documents no longer point
   at openable files; they are kept as citations of "where this rule came from".

## Language policy

- **Specifications are bilingual**: `docs/README.md`, the three files under `architecture/` and
  `history.md` all have an English version — Chinese is `X.md`, English is `X.en.md` in the same
  directory. The two correspond one-to-one, and **Chinese is the original**; if they disagree, `X.md`
  wins and `X.en.md` should be fixed.
- **Historical records are Chinese-only**: `decisions/`, `log/`, `lessons/`, `audits/` and `tasks/`
  record "what we thought on that day". Back-translating them adds little, so no English version is
  provided; translate on demand.
- **Requirement for new documents**: new specification documents must ship `X.en.md` alongside; new
  decision records and logs need not.
- **Root-level product docs use the opposite convention**: English `README.md` / `CONTRIBUTING.md` /
  `SECURITY.md` / `CHANGELOG.md`, Chinese `README.zh-CN.md` etc. (suffix `.zh-CN.md`, the mirror image
  of `.en.md` here).
