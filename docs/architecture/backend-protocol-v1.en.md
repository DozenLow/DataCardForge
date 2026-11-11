# Backend protocol v1 (backend-protocol-v1)

[中文](backend-protocol-v1.md) | English

- **Date**: 2026-10-17 · **Status**: **v1 specification (stages 1–2 were implemented against it)**; change this document before changing the implementation — it is authoritative for endpoints and frame formats
- **Origin**: [backend-owns-compute decision](../decisions/2026-10-17-backend-owns-compute.md)
- **Principle**: the server emits structured data and error codes only; copy, layout and rendering all live in the browser.

## Transport shape

- **HTTP/1.1, a local service on `127.0.0.1`** (default port 37811, configurable).
- Control messages = JSON (`application/json`); matrix payloads = binary frames (see "Payload encoding").
- Node-state push = long poll `GET /api/events?since=<seq>` (the server holds the request until a new event arrives or 25 s elapse).
  A WebSocket upgrade is deferred until lower latency is needed and **does not change message semantics**.
- No authentication (single-user local tool). A token must be added before any cross-machine deployment; that is a known gap.

## Handshake and version

```
GET /api/hello
→ { "protocol": 1, "build": "<git-sha>",
    "capabilities": ["expr.v1", "matrix.v1", "signature.v1", "card.v2"],
    "limits": { "maxWindowRows": 5000 } }
```

The frontend calls this on page load. **A protocol mismatch ⇒ an explicit banner "backend version
incompatible", and entry into the workspace is refused**; a connection failure ⇒ an explicit banner
"compute backend unreachable + retry button", never a blank screen (this is contract 1 made concrete).

## Resource model

| Resource | Authority | Notes |
|---|---|---|
| Matrix | server | `{id, revision, rows, cols, columns:[{name,annotation}]}`; `revision` increments on every content change |
| Node | server | compute node: `{id, kind:"function", inputs:[{varName, mode:"cell"\|"matrix", source:{matrixId}\|{nodeId}}], formula, resultMatrixId, state}` |
| Card | browser | geometry / stacking / title, aligned with a Node via `nodeId` |
| Event | server | monotonic `seq` state stream |

`mode` is decided by the variable declaration (initialised from the first letter's case by default,
visible and editable in the UI — the A/a display details are still under discussion; the protocol only
guarantees that `mode` is an explicit field and never a guess).

## Endpoints

### Matrices
- `POST /api/matrices` (JSON: column names + data; small tables / parsed uploads) → `{matrixId, revision}`
- `POST /api/matrices/raw` (binary frame, see "payload encoding") → same as above
- `GET /api/matrices/{id}/window?start=&count=` → binary frame (visible-row window)
- `PATCH /api/matrices/{id}` `{cells:[{row, col, value}]}` → `{matrixId, revision}`
  - Cell edits from the browser are persisted (`value` also accepts the `"NaN"|"Infinity"|"-Infinity"` sentinels).
  - Any out-of-range coordinate ⇒ `400 {code:"shapeMismatch"}` and **nothing in the batch is written** (no partial update).
- `DELETE /api/matrices/{id}` — while nodes still read it, or when it *is* some node's result matrix
  ⇒ `409 {code:"hasDependents"}`; on success ⇒ `{deleted: id}`

### Nodes
- `POST /api/nodes` `{kind, inputs, formula}` → `{nodeId, resultMatrixId}`
  - Input bindings that form a cycle ⇒ `409 {code:"cycle", path:[...]}`, **the whole batch is rejected atomically** (N edges either all register or none).
- `GET /api/nodes/{id}` → `{nodeId, state, resultMatrixId, code?, params?, reason?}`
  - Added in stage 3: reads the authoritative state snapshot of one node. The event stream is bounded and
    transient, so after a reconnect or a workspace restore the frontend rebuilds the four-state lamps and
    error codes from here, without replaying history. When `state === "error"` it carries structured
    `code` + `params`.
  - When `state === "dirty"` it carries `reason` (2026-10-27, purely additive):
    `notRequested` (created but never asked to compute) / `upstreamChanged` (an upstream matrix or node
    changed) / `definitionChanged` (parameters or edges were edited). The four-state lamp is unchanged;
    `reason` makes the two kinds of "grey" distinguishable.
- `GET /api/nodes` → `{nodes: [id, …]}`
  - Added in stage 3: lists every compute-node id the server currently holds, so the frontend can align
    restored formula cards with the server's authoritative set.
- `PATCH /api/nodes/{id}` `{formula?, inputs?}` → schedules a recompute
  - 2026-10-27: for `explicitCompute` signatures (`builtin:summary`), PATCH **only marks dirty and does
    not compute** (`definitionChanged`) and the old result is cleared — "changing the definition" is not
    "asking for a computation".
- `POST /api/nodes/{id}/compute` → `{nodeId, state, resultMatrixIds, code?, params?}`
  - Added 2026-10-27. The **only** trigger for `explicitCompute` signatures; for ordinary nodes it is
    equivalent to "recompute now". It is not folded into `PATCH` (changing a definition ≠ asking for a
    computation), and it never goes into `GET` (a read path must have no side effects: reconnects,
    polling and workspace restores all read).
- `DELETE /api/nodes/{id}` — `409 {code:"hasDependents"}` when something depends on it (server side of close protection)
  - On success the node's result matrix is released as well (the frontend gate also drops the server-side copy backing its display cache).
- `POST /api/nodes/{id}/cancel` — cancel a long-running task

### Events
- `GET /api/events?since=<seq>&timeout=25` → `[{seq, nodeId?, matrixId?, state, code?, params?}]`
  - `state ∈ dirty | computing | done | error` (frontend lamps: grey / yellow / green / red)

## Payload encoding (binary frame · dense-matrix display protocol)

Matrix display has exactly one frame format. `GET /api/matrices/{id}/window`,
`GET /api/nodes/{id}/result` and the request body of `POST /api/matrices/raw` all use it — data files
and function-card results have no second format.

```
magic      u32 = 0x44434D32 ("DCM2")
rows       u32                    number of rows in this window
cols       u32                    number of columns
namesLen   u32                    byte length of the names JSON
totalRows  u32                    total rows of the matrix (independent of the window)
totalCols  u32                    total columns of the matrix
data       f64[rows*cols]         column-major, little-endian
names      namesLen bytes of a JSON array (UTF-8); elements are labels of the form "Pos.1 annotation"
```
The frame length is always `24 + rows*cols*8 + namesLen`, little-endian. `rows`/`cols` describe the
**window**, `totalRows`/`totalCols` describe the **whole matrix** — this is the only source for "fetch
the first 100 rows yet know the table has 165 000", which is what lets the frontend show "showing the
first 100 rows · 165 000 total" without downloading everything.

The request body of `POST /api/matrices/raw` is this frame exactly (no HTTP chunking); the server
decodes it and stores it identically to the JSON endpoint. NaNs travel unchanged (IEEE 754); the
existing convention of rendering them as `—` in the frontend is unchanged.

The old `DCM1` frame (magic `0x44434D31`, 16-byte header, no total fields) is still **accepted**:
`POST /api/matrices/raw` recognises both magics, and a missing `total*` defaults to the window size.
The server only ever emits DCM2.

**Response write-back**: the server sets `TCP_NODELAY` on every connection and merges header and body
into a **single** `send`. Writing them separately lets Nagle sit on the second segment until the peer's
delayed ACK — a probe measured a flat 40 ms of extra latency per request, and function-card results are
paged window by window, so that stall multiplies by the page count (see the
[result-preview decision](../decisions/2026-10-29-result-preview.md)).

## v2 additions (card schema v2 / function signatures)

Every field below is **purely additive**: a v1 client that only sends `varName` behaves as before.

- `PortBinding` gains `portId` (stable identity, falling back to `varName`) and `sourceOutputIndex`
  (which output of a K-output node is referenced; v1 data is always 0).
- `POST /api/nodes` gains `signatureId` + `params` (object):

  ```json
  { "signatureId": "builtin:expression-columns",
    "inputs": [{ "portId": "src", "varName": "src", "mode": "matrix", "sourceMatrixId": 7 }],
    "params": { "formulas": [{ "name": "double", "expression": "A * 2" }] } }
  ```

  An unknown signature ⇒ `400 {code:"unknownSignature"}`; missing or invalid signature parameters ⇒
  the node enters error with `code:"badSignatureParams"`. `params` neither creates nor deletes any edge
  (parameters are not data flow).
- Node responses (`POST` / `GET /api/nodes/{id}`) gain `resultMatrixIds` (array in signature output
  order, K fixed by the signature); the single `resultMatrixId` is kept as output 0 for backward
  compatibility.
- `PATCH /api/nodes/{id}` accepts `params` (replaces the whole parameter bundle and marks dirty).
- `builtin:expression-columns`: one node, one wide-table output, one column per expression (the name
  becomes the annotation); replaces v1's "one node per formula column". The column count changing with
  the number of expressions is **data**; K stays 1.
- **Port binding `mode`**: `"matrix"` binds the whole table; `"cell"` + `columnIndex` binds that
  single column (out of range ⇒ `unknownColumn`). In v1 `mode` was decorative — marking `cell` still
  bound the whole table — but two-input signatures need exactly "port = one column", so it now carries semantics.
- `builtin:linear-regression`: ports `x` / `y` (one column each), no parameters, output `fit` fixed by
  the signature at 1 row × 5 columns (slope/intercept/r/r2/n). It has no expression shape — its reason
  for existing is to prove the signature model generalises.
- `builtin:summary` (2026-10-27): port `src` (**matrix**), output `result`. Shape is
  **rows = statistic catalogue, columns = input variables**; row order is catalogue order
  (`summaryStatCatalog()` in `backend/src/signature.cpp`), and row identity never changes with the
  data; column labels are inherited from the source columns (headerless columns are `Pos.N`).
  Parameters: `params.stats` (a subset of catalogue ids, filtering only, never reordering),
  `params.columns` (pick variables by column name). Semantics and conventions:
  [decision record](../decisions/2026-10-27-summary-builtin.md).
  **It is the first lazy signature** (`compute: "explicit"`): creating it does not compute;
  `POST /api/nodes/{id}/compute` is the only trigger; an upstream change ⇒ `dirty` +
  `reason:"upstreamChanged"` and the result matrix is cleared.
- `GET /api/signatures` → `{signatures:[{id, version, displayName, compute, inputs:[{portId,
  displayName, required}], outputs:[{outputId}]}]}`: every function signature the backend can
  evaluate. `compute` is `"auto"` (compute on creation) or `"explicit"` (must be triggered).
  The frontend currently creates only one kind of card, but this is the discovery interface for the
  **function picker and plugin tooling** — per the port-semantics spec, built-ins and plugins register
  into the same table.
- **Capability negotiation**: `signature.v1` / `card.v2` are **required** by a v2 client. The protocol
  number is still 1 (all fields are additive), but an old backend that does not understand
  `signatureId` will ignore it and evaluate an empty `formula` — it looks alive while computing
  nothing. Missing capability ⇒ the frontend raises the existing "backend version incompatible" banner
  and refuses to enter the workspace.

## Structured errors

```
HTTP 4xx/5xx + { "code": "...", "params": {...}, "position"?: number }
```

Reusing the existing `expression.ts` code table, extended:
`unexpectedChar unknownFunction expectedCloseAfterArgs badArgCount unknownColumn
expectedClose unexpectedToken trailingToken shapeMismatch singular matrixRequired
notImplemented backendUnavailable hasDependents cycle badFrame payloadTooLarge
internalError upstreamError`

**The server never sends user-facing sentences**; the frontend renders them with the i18n keys
`formula.error.<code>` / `backend.error.<code>`. An unknown code ⇒ the frontend shows a generic
fallback sentence plus the raw code (visible, never silent).

## Differential-testing contract

`web/tests/fixtures/xlayer/*.json` is the single judge format; the TypeScript reference implementation
and the C++ engine must run the same set:

```json
{ "name": "zscore", "columns": [{"name":"A","data":[1,2,3,4]}],
  "expression": "(A - AVG(A)) / STD(A)",
  "expect": [-1.3416407865, -0.4472135955, 0.4472135955, 1.3416407865],
  "tol": 1e-9 }
```

Error cases replace `expect` with `"error": {"code": "...", "position": N}`.
CI gate: the fixtures must be green on both sides.
