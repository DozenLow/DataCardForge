# Architecture trade-off: frontend choice, ImGui vs Web

[中文](frontend-imgui-vs-web.md) | English

- **Status**: ✅ converged — the conclusion is **Web**, see [frontend choice settled on Web](../decisions/2026-10-14-frontend-web-chosen.md) (2026-10-14)
- **Tags**: `#architecture #frontend-choice #trade-off`

> **Postscript (2026-10-14)**: the comparison table below is still valid, but the **weights were
> reversed**, which is why the conclusion became Web. Key changes: ① "vector export" was promoted from
> a "possible requirement" to a **hard requirement** (the end goal in science/industry is a figure);
> ② the "large-table performance" worry was disproved by measurement — under virtual scrolling a
> 10 000-row table renders only 23 row nodes, and ECharts downsamples 10⁵ points with LTTB;
> ③ the whole "embed ImGui in a WebView" complexity source **disappeared** (there is no host any more;
> the browser is the host). This document keeps the original reasoning as a record of "why the choice was paused
> back then".

## The two routes

### A. ImGui (+ ImPlot + GLFW)

- **Strengths**: performance (large tables + high-frequency redraw + zero-copy matrices), connections /
  free drawing (ImDrawList), native C++, layered plugins
- **Weaknesses**: vector export (ImPlot explicitly has none, not publication grade), SVG WYSIWYG
  editing (you would build an editor), Chinese IME pain, no official plugin system

### B. Web (Tauri / plain Web)

- **Strengths**: SVG native (vector export for free), mature WebView embedding, HTML/CSS ecosystem,
  good IME, WYSIWYG-class features are a natural strength
- **Weaknesses**: lower performance ceiling than native (large tables / high frequency need extra
  optimisation), bundle size (Tauri small / Electron large)

## Key trade-off table

| Requirement | ImGui | Web |
|------|:--:|:--:|
| Large tables + high-frequency charts | ✅ strong | ⚠️ needs optimisation |
| Connections between windows | ✅ strong | 🟡 feasible |
| Vector export (publication grade) | ❌ weak (build an export pipeline) | ✅ native |
| SVG / WYSIWYG editing | ❌ very hard | ✅ native |
| Chinese IME | ⚠️ needs special handling | ✅ free |
| Plugin development | 🟡 medium (no ecosystem tooling) | 🟡 medium (npm, but weak isolation) |

## Established conclusions (do not re-litigate)

1. Under the **connection-subordination principle**, embedding a WebView as a card inside ImGui only
   needs **child-window mode**, no OSR (see [connection subordination](../decisions/2026-08-07-connection-subordination.md))
2. **If "vector export + SVG editing" is confirmed as a high-frequency requirement** → the Web weight
   should rise a lot (this is ImGui's largest relative weakness)
3. ImPlot ecosystem: healthy but small, v1.1 is mid API rewrite (see
   [ImPlot v1.1 API overhaul](../lessons/implot-v1.1-api.md)); the ImGui ecosystem is large and very healthy
4. The export pipeline should be **separated from interactive display** (ImGui/ImPlot for interaction,
   a matplotlib bridge or data-driven SVG for export) — true on either route

## Triggers for re-evaluation

- [ ] Backend Eigen + formula compute lands
- [ ] Strong vector-export demand appears (user submissions / papers)
- [ ] 3D plotting needed (ImPlot3D maturity assessment)
- [ ] SVG/WYSIWYG-style editing needed

## Related

- Decision: [backend first, frontend paused](../decisions/2026-08-07-backend-first-frontend-paused.md)
- Experiment: `imguitest/` (ImGui validation demo)
