/**
 * Backend transport client (docs/decisions/2026-10-17-backend-owns-compute.md).
 *
 * The browser is a pure interaction surface; every number is computed server-side.
 * This module speaks protocol v1 (docs/architecture/backend-protocol-v1.md):
 * JSON control messages over HTTP plus DCM1 binary frames for matrix windows.
 *
 * Availability contract: the backend being unreachable is VISIBLE, never silent.
 * `hello()` resolves with `{ ok: false }` instead of throwing so callers can show the
 * banner and retry; nothing here ever falls back to local compute.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Capabilities this frontend needs from the backend.
 *
 * `protocol` stayed 1 because every v2 field is additive on the wire — but a backend that
 * does not know `signatureId` would ignore it and evaluate an empty formula, i.e. create a
 * node that looks alive and computes nothing. Capabilities are how a client refuses that
 * combination up front instead of discovering it as an empty table.
 */
export const REQUIRED_CAPABILITIES = ['signature.v1'] as const;
const DEFAULT_BASE = '/api';

export interface HelloInfo {
  ok: boolean;
  protocol?: number;
  build?: string;
  capabilities?: string[];
  maxWindowRows?: number;
  /** Human-diagnosable reason for failure (code-style detail, not user prose). */
  error?: string;
}

export interface MatrixRegisterResult {
  ok: boolean;
  matrixId?: number;
  revision?: number;
  code?: string;
}

export interface NodeCreateResult {
  ok: boolean;
  nodeId?: number;
  /** Output 0 (legacy field). */
  resultMatrixId?: number;
  /** Every declared output, indexed by the signature's output ordinal. */
  resultMatrixIds?: number[];
  /** Echoes the signature the server created the node with (v2). */
  signatureId?: string;
  state?: NodeStateName;
  /** Present when creation left the node lazy and uncomputed (e.g. builtin:summary). */
  reason?: DirtyReasonName;
  /** Structured refusal data when ok=false (cycle path etc.). Never user prose. */
  code?: string;
  cyclePath?: number[];
}

/** A compute node as the server reports it (`GET /api/nodes/{id}`). */
/** One function signature as the backend advertises it. */
export interface SignatureDto {
  id: string;
  version: number;
  displayName: string;
  inputs: Array<{ portId: string; displayName: string; required: boolean }>;
  outputs: Array<{ outputId: string }>;
  /** "auto" computes right after creation; "explicit" needs POST /nodes/{id}/compute. */
  compute?: 'auto' | 'explicit';
}

export type TrustPersistenceName = 'undecided' | 'persistent' | 'session' | 'unavailable';

/** `GET /api/trust/status` — persistence state, record location and the environment id. */
export interface TrustStatusDto {
  ok: boolean;
  persistence: TrustPersistenceName;
  location: string;
  envId: string;
  envChanged: boolean;
  entries: number;
}

/** `GET /api/trust/{hash}` — is this workspace file known, and which scripts were confirmed. */
export interface TrustLookupDto {
  ok: boolean;
  hash: string;
  known: boolean;
  envMatch: boolean;
  scripts: string[];
  persistence: TrustPersistenceName;
}

export interface NodeStatusDto {
  nodeId: number;
  state: NodeStateName;
  resultMatrixId: number;
  /** Present only while `state === "dirty"`: why the node has not computed yet. */
  reason?: DirtyReasonName;
  /** Structured error identity, present only while `state === "error"`. */
  code?: string;
  params?: Record<string, unknown>;
}

export type NodeStateName = 'dirty' | 'computing' | 'done' | 'error';

/** Why a dirty node has not computed yet; present only while `state === "dirty"`. */
export type DirtyReasonName = 'notRequested' | 'upstreamChanged' | 'definitionChanged';

export interface NodeEvent {
  seq: number;
  nodeId?: number;
  matrixId?: number;
  state?: NodeStateName;
  /** Present on a `dirty` push: why the node has not computed (backend nodes.cpp). */
  reason?: DirtyReasonName;
  code?: string;
  params?: Record<string, unknown>;
}

export interface MatrixWindow {
  ok: boolean;
  /** Rows in THIS window (never the whole table). */
  rows?: number;
  columns?: number;
  names?: string[];
  /**
   * Full matrix shape. The dense-matrix frame carries it on every window, so a card that
   * only pulled the first 100 rows still knows the table is 165 000 rows tall.
   * Absent only for a legacy DCM1 frame (where the window was assumed to be everything).
   */
  totalRows?: number;
  totalCols?: number;
  /** column-major Float64 view into `buffer`. */
  data?: Float64Array[];
  buffer?: ArrayBuffer;
  code?: string;
}

export interface PortBindingDto {
  /** Stable port identity (v2); the server falls back to `varName` when omitted. */
  portId?: string;
  varName: string;
  mode: 'cell' | 'matrix';
  sourceMatrixId?: number;
  sourceNodeId?: number;
  /** Which output of a K-output upstream node (v1 data is always 0). */
  sourceOutputIndex?: number;
  /** Required when `mode === 'cell'`: which column of the source to bind. */
  columnIndex?: number;
}

/**
 * Why a script check did not produce a verdict.
 *
 * `syntaxError` and `runtimeMissing` come from the endpoint itself; `internalError` means the
 * backend tried and failed; `backendUnavailable` is added HERE when the request never got an
 * answer (the server is down, or the body did not parse). They are deliberately one union:
 * every consumer shows "the authoritative layer could not answer" for all but `syntaxError`,
 * and it must be impossible to mistake that for "the script compiles".
 */
export type ScriptCheckErrorCode =
  | 'syntaxError'
  | 'runtimeMissing'
  | 'internalError'
  | 'backendUnavailable';

/**
 * Verdict of `POST /api/script/check` — the editor's authoritative layer.
 *
 * The endpoint has its OWN envelope (`{ok:true,...}` / `{ok:false,error:{...}}`), not the
 * global `{code:...}` error body: "your script does not compile" is a verdict about the
 * script, not a failure of the request. `line`/`col` are the SCRIPT's coordinates (1-based),
 * produced by the same CPython that will compile the run — which is why they are the numbers
 * the editor shows once this answer lands.
 */
export interface ScriptCheckResult {
  ok: boolean;
  /**
   * Present when `ok`: the runner's self-describing impurity labels (e.g. `"open()"`,
   * `"random.* without seed()"`). Empty ⇒ the script is reproducible. Empty as well when
   * `ok` is false: a script that does not compile has no impurity verdict to report.
   */
  impure: string[];
  error?: { code: ScriptCheckErrorCode; line?: number; col?: number; message?: string };
}

async function jsonRequest<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`bad JSON from ${path}: ${text.slice(0, 80)}`);
  }
  if (!res.ok) {
    const p = parsed as { code?: string; params?: Record<string, unknown> };
    const err = new Error(p.code ?? `http ${res.status}`) as Error & { code?: string; params?: Record<string, unknown> };
    err.code = p.code ?? `http ${res.status}`;
    err.params = p.params;
    throw err;
  }
  return parsed as T;
}

export class BackendClient {
  private base: string;

  constructor(base = DEFAULT_BASE) {
    this.base = base;
  }

  /** Handshake. Never throws: failure shape is { ok:false, error } for the banner. */
  async hello(): Promise<HelloInfo> {
    try {
      const info = await jsonRequest<{
        protocol: number;
        build: string;
        capabilities: string[];
        limits: { maxWindowRows: number };
      }>(this.base, '/hello');
      if (info.protocol !== PROTOCOL_VERSION) {
        return { ok: false, error: `protocol-mismatch:${info.protocol}` };
      }
      return {
        ok: true,
        protocol: info.protocol,
        build: info.build,
        capabilities: info.capabilities,
        maxWindowRows: info.limits.maxWindowRows,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Register a freshly parsed table. Non-finite cells travel as string sentinels. */
  async registerMatrix(name: string, columns: Array<{ posName: string; annotation: string; data: number[] }>): Promise<MatrixRegisterResult> {
    const payload = {
      name,
      columns: columns.map((c) => ({
        posName: c.posName,
        annotation: c.annotation,
        data: c.data.map((v) =>
          Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v,
        ),
      })),
    };
    try {
      const r = await jsonRequest<{ matrixId: number; revision: number }>(this.base, '/matrices', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return { ok: true, matrixId: r.matrixId, revision: r.revision };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'backendUnavailable' };
    }
  }

  /**
   * Push browser cell edits into the server-side copy (revision bumps on the server).
   * Non-finite values travel as string sentinels, like registerMatrix.
   */
  async patchCells(
    matrixId: number,
    cells: Array<{ row: number; col: number; value: number }>,
  ): Promise<{ ok: boolean; code?: string }> {
    try {
      await jsonRequest(this.base, `/matrices/${matrixId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          cells: cells.map((c) => ({
            row: c.row,
            col: c.col,
            value: Number.isNaN(c.value)
              ? 'NaN'
              : c.value === Infinity
                ? 'Infinity'
                : c.value === -Infinity
                  ? '-Infinity'
                  : c.value,
          })),
        }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'backendUnavailable' };
    }
  }

  /** Drop a stored matrix. The server refuses while a compute node still reads it. */
  async deleteMatrix(matrixId: number): Promise<{ ok: boolean; code?: string }> {
    try {
      await jsonRequest(this.base, `/matrices/${matrixId}`, { method: 'DELETE' });
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'backendUnavailable' };
    }
  }

  /**
   * Create a compute node.
   *
   * v1 shape: `{inputs, formula}` for a single expression. v2 shape: `{inputs, signatureId,
   * params}` for a signature-driven node with K declared outputs.
   */
  /**
   * Every signature this backend can evaluate.
   *
   * The card UI hard-codes the one signature it creates today; this call is the seam that
   * lets a future function picker (and plugin tooling) ask instead of assume.
   */
  async signatures(): Promise<SignatureDto[]> {
    try {
      const r = await jsonRequest<{ signatures: SignatureDto[] }>(this.base, '/signatures');
      return Array.isArray(r.signatures) ? r.signatures : [];
    } catch {
      return [];
    }
  }

  async createNode(
    inputs: PortBindingDto[],
    arg: string | { signatureId: string; params: Record<string, unknown> },
  ): Promise<NodeCreateResult> {
    const body = typeof arg === 'string'
      ? { inputs, formula: arg }
      : { inputs, signatureId: arg.signatureId, params: arg.params };
    try {
      const r = await jsonRequest<{
        nodeId: number;
        resultMatrixId: number;
        resultMatrixIds?: number[];
        signatureId?: string;
        state: NodeStateName;
      }>(this.base, '/nodes', { method: 'POST', body: JSON.stringify(body) });
      return { ok: true, ...r };
    } catch (e) {
      const err = e as { code?: string; params?: { path?: number[] } };
      return { ok: false, code: err.code ?? 'backendUnavailable', cyclePath: err.params?.path };
    }
  }

  async patchNode(
    nodeId: number,
    patch: {
      formula?: string;
      inputs?: PortBindingDto[];
      params?: Record<string, unknown>;
    },
  ): Promise<NodeCreateResult> {
    try {
      const r = await jsonRequest<{ nodeId: number; state: NodeStateName }>(this.base, `/nodes/${nodeId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      return { ok: true, ...r };
    } catch (e) {
      const err = e as { code?: string; params?: { path?: number[] } };
      return { ok: false, code: err.code ?? 'backendUnavailable', cyclePath: err.params?.path };
    }
  }

  async deleteNode(nodeId: number): Promise<{ ok: boolean; code?: string }> {
    try {
      await jsonRequest(this.base, `/nodes/${nodeId}`, { method: 'DELETE' });
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'backendUnavailable' };
    }
  }

  /**
   * Read one node's authoritative status. Used to reconcile after a reconnect or a
   * restored workspace, where the live event stream no longer describes the node.
   */
  async getNode(nodeId: number): Promise<NodeStatusDto | null> {
    try {
      return await jsonRequest<NodeStatusDto>(this.base, `/nodes/${nodeId}`);
    } catch {
      return null;
    }
  }

  // ── workspace trust (2026-11-17) ──────────────────────────────────────
  //
  // The browser hashes the workspace FILE and asks whether that hash is known. The backend
  // only stores the answer; it never reads the file. Every method resolves to `null`/`false`
  // on transport failure so the UI can fall back to "untrusted, offer confirmation" instead
  // of treating an unreachable trust service as permission.

  /** Persistence state and the local environment id. */
  async trustStatus(): Promise<TrustStatusDto | null> {
    try {
      return await jsonRequest<TrustStatusDto>(this.base, '/trust/status');
    } catch {
      return null;
    }
  }

  /** Answer the first-run question: keep records on disk, or this session only? */
  async trustDecidePersistence(persist: boolean): Promise<TrustStatusDto | null> {
    try {
      return await jsonRequest<TrustStatusDto>(this.base, '/trust/persistence', {
        method: 'POST',
        body: JSON.stringify({ persist }),
      });
    } catch {
      return null;
    }
  }

  async trustLookup(hash: string): Promise<TrustLookupDto | null> {
    try {
      return await jsonRequest<TrustLookupDto>(this.base, `/trust/${hash}`);
    } catch {
      return null;
    }
  }

  /** Record confirmed script card ids for one workspace hash. */
  async trustRecord(hash: string, scripts: string[]): Promise<boolean> {
    try {
      await jsonRequest(this.base, '/trust', {
        method: 'POST',
        body: JSON.stringify({ hash, scripts }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async trustRevoke(hash: string): Promise<boolean> {
    try {
      await jsonRequest(this.base, `/trust/${hash}`, { method: 'DELETE' });
      return true;
    } catch {
      return false;
    }
  }

  /** 显式请求一次计算（惰性签名 builtin:summary 的唯一触发入口）。 */
  async computeNode(nodeId: number): Promise<{
    ok: boolean;
    state?: NodeStateName;
    reason?: DirtyReasonName;
    resultMatrixIds?: number[];
    code?: string;
  }> {
    try {
      const r = await jsonRequest<{ nodeId: number; state: NodeStateName; resultMatrixIds?: number[] }>(
        this.base,
        `/nodes/${nodeId}/compute`,
        { method: 'POST' },
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'backendUnavailable' };
    }
  }

  /**
   * On-demand accuracy diagnosis. Never changes the result, the node state or the event
   * stream: it asks the server to re-run the same node with its rows in another order and
   * report the jitter. Returns {} when the backend cannot answer.
   */
  async checkAccuracy(nodeId: number): Promise<{
    status?: 'ok' | 'degraded' | 'unsupported';
    digits?: number;
    relativeGap?: number;
    reason?: string;
  }> {
    try {
      return await jsonRequest(this.base, `/nodes/${nodeId}/accuracy`, { method: 'POST' });
    } catch {
      return {};
    }
  }

  /**
   * Compile-only check for a script card's editor (POST /api/script/check).
   *
   * The backend spawns `runner.py --check`, which compiles the text and statically scans the
   * AST for non-reproducible reads — it NEVER executes the script, so this call cannot publish
   * anything and is safe to fire while the user types.
   *
   * Never throws: a transport/parse failure becomes `{ok:false,error:{code:'backendUnavailable'}}`
   * so the editor can say the authoritative layer is off instead of silently implying that the
   * script compiled.
   */
  async checkScript(script: string): Promise<ScriptCheckResult> {
    let raw: {
      ok?: unknown;
      lint?: { impure?: unknown };
      error?: { code?: unknown; line?: unknown; col?: unknown; message?: unknown };
    } = {};
    try {
      raw = await jsonRequest(this.base, '/script/check', {
        method: 'POST',
        body: JSON.stringify({ script }),
      });
    } catch {
      return { ok: false, impure: [], error: { code: 'backendUnavailable' } };
    }
    const impure = Array.isArray(raw.lint?.impure)
      ? raw.lint.impure.filter((item): item is string => typeof item === 'string')
      : [];
    if (raw.ok === true && !Array.isArray(raw.lint?.impure)) {
      // A backend that says "ok" without the lint list is broken, not clean: reporting an
      // empty list here would print a "reproducible" verdict nobody computed.
      return { ok: false, impure: [], error: { code: 'internalError' } };
    }
    if (raw.ok === true) return { ok: true, impure };
    const error: NonNullable<ScriptCheckResult['error']> = {
      code:
        typeof raw.error?.code === 'string'
          ? (raw.error.code as ScriptCheckErrorCode)
          : 'backendUnavailable',
    };
    if (typeof raw.error?.line === 'number') error.line = raw.error.line;
    if (typeof raw.error?.col === 'number') error.col = raw.error.col;
    if (typeof raw.error?.message === 'string') error.message = raw.error.message;
    return { ok: false, impure, error };
  }

  /** All node ids the server currently holds (for reconciling a restored workspace). */
  async listNodes(): Promise<number[]> {    try {
      const r = await jsonRequest<{ nodes: number[] }>(this.base, '/nodes');
      return Array.isArray(r.nodes) ? r.nodes : [];
    } catch {
      return [];
    }
  }

  /**
   * Pull a node's result matrix through the documented window endpoint. The result is a
   * stored matrix (`resultMatrixId`), so `GET /api/matrices/{id}/window` serves it — no
   * protocol extension needed. `count` is clamped to the server's maxWindowRows (5000).
   */
  async nodeResult(resultMatrixId: number, count = 5000): Promise<MatrixWindow> {
    return this.window(resultMatrixId, 0, count);
  }

  /** Long-poll node events newer than `since`. Resolves empty on timeout. */
  async events(since: number, signal?: AbortSignal): Promise<NodeEvent[]> {
    try {
      return await jsonRequest<NodeEvent[]>(this.base, `/events?since=${since}&timeout=25`, { signal });
    } catch {
      return [];
    }
  }

  /** Fetch a row window as a decoded DCM1 frame. */
  async window(matrixId: number, start: number, count: number): Promise<MatrixWindow> {
    try {
      const res = await fetch(`${this.base}/matrices/${matrixId}/window?start=${start}&count=${count}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        return { ok: false, code: body.code ?? `http ${res.status}` };
      }
      const buffer = await res.arrayBuffer();
      return decodeMatrixFrame(buffer);
    } catch {
      return { ok: false, code: 'backendUnavailable' };
    }
  }
}

/**
 * Dense-matrix display frame.
 *
 *   DCM2: magic u32, rows u32, cols u32, namesLen u32, totalRows u32, totalCols u32,
 *         f64[rows*cols] column-major, names JSON
 *   DCM1: the same without totalRows/totalCols (legacy; window == whole matrix)
 *
 * `rows`/`cols` describe the WINDOW that was asked for; `totalRows`/`totalCols` describe
 * the stored matrix, which is what lets a client show "100 of 165 000 rows" and fetch the
 * rest on demand.
 */
export function decodeMatrixFrame(buffer: ArrayBuffer): MatrixWindow {
  const view = new DataView(buffer);
  if (buffer.byteLength < 16) return { ok: false, code: 'badFrame' };
  const magic = view.getUint32(0, true);
  const isV2 = magic === 0x44434d32;
  if (magic !== 0x44434d31 && !isV2) return { ok: false, code: 'badFrame' };
  const headerLen = isV2 ? 24 : 16;
  const rows = view.getUint32(4, true);
  const cols = view.getUint32(8, true);
  const namesLen = view.getUint32(12, true);
  const totalRows = isV2 ? view.getUint32(16, true) : rows;
  const totalCols = isV2 ? view.getUint32(20, true) : cols;
  const expected = headerLen + cols * rows * 8 + namesLen;
  if (buffer.byteLength < expected) return { ok: false, code: 'truncatedFrame' };
  const data: Float64Array[] = [];
  let offset = headerLen;
  for (let c = 0; c < cols; c++) {
    const col = new Float64Array(rows);
    for (let r = 0; r < rows; r++) col[r] = view.getFloat64(offset + r * 8, true);
    data.push(col);
    offset += rows * 8;
  }
  const namesJson = new TextDecoder('utf-8').decode(new Uint8Array(buffer, offset, namesLen));
  let names: string[] = [];
  try {
    names = JSON.parse(namesJson) as string[];
  } catch {
    /* keep names empty rather than failing the whole frame */
  }
  return { ok: true, rows, columns: cols, totalRows, totalCols, names, data, buffer };
}
