/**
 * Python script card — the body of a `builtin:python` function card.
 * (docs/decisions/2026-11-15-python-script-card.md)
 *
 * The card is NOT a new kind of card. It is one `FunctionCardModel` with a script signature:
 * the same node, the same `inputs[]` envelope, the same `outputs[]`, the same display cache.
 * That is why everything here is either *declaration UI* (ports and outputs the user names)
 * or *run UI* (the two buttons, the panel, the environment stamp) — no graph, no close
 * protection, no bindings logic is re-implemented, and none of those modules knows this
 * component exists (decision §十, the zero-special-case gate).
 *
 * Integration: the render dispatch belongs in the component-selection layer (CardCanvas),
 * where `isFormulaCard(card)` already branches:
 *
 *     if (isScriptCard(card)) return <ScriptCard key={card.id} card={card} ... />;
 *     if (isFormulaCard(card)) return <FormulaCard ... />;
 *
 * Everything the card needs (sources, run state, actions) it reads from the store itself, so
 * the dispatch is those two lines and nothing else.
 *
 * v1 notes that are deliberately visible in the UI rather than hidden:
 *   - 调试运行 uses the clean-room path (a session kernel is the next stage); its RESULT is
 *     already kept out of the DAG, so "debugging never publishes" holds from day one.
 *   - The environment stamp is the pinned toolchain (`scripts/fetch-python-runtime.sh`) plus
 *     this browser's measured duration — the backend exposes no version field yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { basicSetup } from 'codemirror';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import {
  BackendClient,
  type ScriptCheckErrorCode,
  type ScriptCheckResult,
} from '../../backend/client.ts';
import type { Locale } from '../i18n.ts';
import {
  SCRIPT_PREVIEW_ROWS,
  checkScriptName,
  countScriptOccurrences,
  emptyScriptRun,
  outputMatrixId,
  useTranslator,
  useWorkspace,
  type ScriptNameCheck,
  type ScriptNameProblem,
  type ScriptPreview,
  type ScriptRunState,
} from '../workspaceStore.ts';
import { portVarName } from '../bindings.ts';
import { scriptTrusted } from '../workspaceTrust.ts';
import {
  invalidateLayout,
  registerPort,
  unregisterPort,
  type AnchorSide,
} from '../cardMetrics.ts';
import {
  cancelOperation,
  flushOperations,
  settleOperation,
} from '../operationSettle.ts';
import {
  isFormulaCard,
  isMatrixCard,
  scriptParams,
  workspaceEnvPackageVersion,
  type FunctionCardModel,
} from '../types.ts';
import { CardShell } from './CardShell.tsx';
import { SidePanel } from './SidePanel.tsx';
import {
  ChartTypeItems,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSub,
} from './ContextMenu.tsx';

// ── prose ─────────────────────────────────────────────────────────────────────────────
//
// The card's strings live here, not in `i18n.ts`, because the script card is developed in a
// lane that owns only its own files. Moving this table into the shared dictionary is a
// mechanical follow-up (`'script.*'` keys) and changes nothing else.

interface ScriptLabels {
  cardTitle: string;
  run: string;
  runTitle: string;
  debug: string;
  debugTitle: string;
  ports: string;
  outputs: string;
  addPort: string;
  addOutput: string;
  removeOutput: string;
  /** `{name}` is the human output name, `{id}` its stable `out:N`. */
  buildTitle: string;
  /** Shown at the top of the build menu while the output has no rows yet. */
  outputEmpty: string;
  buildUnavailable: string;
  noPorts: string;
  noPreview: string;
  previewToggle: string;
  debugInfo: string;
  debugEmpty: string;
  replaceCount: string;
  replaceNone: string;
  renameHint: string;
  running: string;
  envPending: string;
  /** Red-state band: the backend could not find a Python runtime at all. */
  runtimeMissingTitle: string;
  runtimeMissingHint: string;
  /** Auto-rerun toggle (tri-state: hidden until the first clean run arms the card). */
  autoOn: string;
  autoOff: string;
  autoHint: string;
  /** The script came from a workspace file whose user has not confirmed it yet. */
  trustLocked: string;
  trustLockedHint: string;
  trustConfirm: string;
  warnings: Record<'caseTwin' | 'keyword', string>;
  errors: Record<string, string>;
  status: Record<ScriptNameProblem['code'], string>;
  failure: Record<string, string>;
  runMode: { clean: string; debug: string };
  runSummary: string;
  traceJump: string;
  /** Two-layer diagnostics (lezer now, CPython after the 200 ms settle). */
  diagnostics: string;
  diagnosticLocal: string;
  diagnosticBackend: string;
  diagnosticLocalSyntax: string;
  /** Title-bar stamp for a script whose reads/writes make it non-reproducible. */
  impureStamp: string;
  /** `{items}` is the runner's own list of triggers, joined by `impureSeparator`. */
  impureTitle: string;
  impureSeparator: string;
}

const LABELS: Record<Locale, ScriptLabels> = {
  zh: {
    cardTitle: 'Python 脚本',
    run: '▶ 净室运行',
    runTitle: '新建子进程跑一次，结果进入卡片并触发下游',
    debug: '⟳ 调试运行',
    debugTitle: '同一条后端路径，但结果只留在本卡（不写显示表、不触发下游）',
    ports: '输入端口',
    outputs: '输出声明',
    addPort: '+ 端口',
    addOutput: '+ 输出',
    removeOutput: '删除此输出',
    buildTitle: '{name}（{id}）· 从这里建卡',
    outputEmpty: '该输出还没有数据，先运行一次',
    buildUnavailable: '这个输出还不能建卡',
    noPorts: '没有输入端口 — 脚本只靠自己的常量计算',
    noPreview: '尚未运行 — 运行后这里显示前几行',
    previewToggle: '展开预览前 5 行',
    debugInfo: '调试信息',
    debugEmpty: '没有调试信息',
    replaceCount: '将替换 {n} 处',
    replaceNone: '脚本里没有出现这个名字，改名的同时不会改动脚本',
    renameHint: '回车确认，Esc 取消',
    running: '运行中…',
    envPending: '运行后显示耗时',
    runtimeMissingTitle: '未检测到 Python 运行时',
    autoOn: '自动 ●',
    autoOff: '自动 ○',
    autoHint: '首次成功运行后，输入或定义变化时自动重跑；关闭后只在你点击时运行',
    trustLocked: '此脚本来自未信任的工作区',
    trustLockedHint: '确认前不会运行（自动运行也不会）',
    trustConfirm: '信任此脚本',
    runtimeMissingHint:
      '后端找不到钉死的 Python 解释器或运行器。请先执行 scripts/fetch-python-runtime.sh 取回运行时，再回来手动运行本卡；卡片其余部分仍可编辑，本次不会自动重试。',
    warnings: {
      caseTwin: '与「{name}」只差大小写，读起来容易混（已放行）',
      keyword: '「{name}」是 Python 关键字，脚本里无法引用（已放行）',
    },
    errors: {
      invalidParams: '输出/端口声明不合法（后端拒绝运行）',
      syntaxError: '语法错误',
      invalidOutput: '输出取值不合法',
      scriptTimeout: '运行超时',
      runtimeMissing: '未找到 Python 运行时',
      untrusted: '脚本来自未信任的工作区：先确认信任',
      upstreamPending: '上游还没有可读的结果，等一下再运行',
      backendUnavailable: '计算后端不可达',
      internalError: '内部错误',
    },
    status: {
      empty: '名字不能为空',
      notIdentifier: '只能是 Python 标识符：字母或下划线开头，只含字母、数字、下划线',
      reserved: '「{name}」是运行器保留名（names_* / shape_* / meta）',
      duplicate: '与{panel}「{name}」重名',
      caseTwin: '',
      keyword: '',
      notFound: '这个端口或输出已经不存在了',
    },
    failure: {
      portNames: '端口名必须覆盖全部绑定端口、彼此不重复，且是 ASCII 标识符',
      outputs: '输出声明不能为空，且名字不能重复',
      name: '声明字段：{name}',
      line: '第 {line} 行',
      timeout: '超过 {ms} ms',
      detail: '详情',
      stderr: 'traceback',
      name2: '出错的输出：{name}',
    },
    runMode: { clean: '净室', debug: '调试' },
    runSummary: '{mode}运行 · {ms} ms · {outputs} 个输出',
    traceJump: '跳到第 {line} 行',
    diagnostics: '诊断',
    diagnosticLocal: '本地',
    diagnosticBackend: '后端',
    diagnosticLocalSyntax: '这里不是合法的 Python（本地即时检查）',
    impureStamp: '不可复现',
    impureTitle: '不可复现：{items}',
    impureSeparator: '、',
  },
  en: {
    cardTitle: 'Python script',
    run: '▶ Clean run',
    runTitle: 'Run once in a fresh child process; results land in the card and feed dependents',
    debug: '⟳ Debug run',
    debugTitle: 'Same backend path, but results stay in this card (no display write, no dependents)',
    ports: 'Inputs',
    outputs: 'Outputs',
    addPort: '+ port',
    addOutput: '+ output',
    removeOutput: 'Remove this output',
    buildTitle: '{name} ({id}) · build from this output',
    outputEmpty: 'No data yet — run the card first',
    buildUnavailable: 'This output cannot be built from yet',
    noPorts: 'No input ports — the script only uses its own constants',
    noPreview: 'Not run yet — the first rows appear here after a run',
    previewToggle: 'Show the first 5 rows',
    debugInfo: 'Debug info',
    debugEmpty: 'Nothing to report',
    replaceCount: 'Rewrites {n} occurrence(s)',
    replaceNone: 'The name does not appear in the script, so only the declaration changes',
    renameHint: 'Enter to apply, Esc to cancel',
    running: 'Running…',
    envPending: 'duration appears after a run',
    runtimeMissingTitle: 'No Python runtime found',
    autoOn: 'Auto ●',
    autoOff: 'Auto ○',
    autoHint:
      'After the first successful run, rerun whenever the inputs or the definition change; off means manual only',
    trustLocked: 'This script came from an untrusted workspace',
    trustLockedHint: 'It runs only after you confirm (never automatically)',
    trustConfirm: 'Trust this script',
    runtimeMissingHint:
      'The backend cannot locate the pinned Python interpreter or the runner. Run scripts/fetch-python-runtime.sh to fetch the runtime, then run this card by hand; the rest of the card stays editable and nothing is retried automatically.',
    warnings: {
      caseTwin: 'Differs from "{name}" only by case — easy to misread (allowed)',
      keyword: '"{name}" is a Python keyword and cannot be referenced (allowed)',
    },
    errors: {
      invalidParams: 'The port/output declaration is invalid (the backend refused to run)',
      syntaxError: 'Syntax error',
      invalidOutput: 'An output value is not acceptable',
      scriptTimeout: 'The run timed out',
      runtimeMissing: 'No Python runtime found',
      untrusted: 'The script came from an untrusted workspace: confirm it first',
      upstreamPending: 'The upstream has no readable result yet — try again in a moment',
      backendUnavailable: 'The compute backend is unreachable',
      internalError: 'Internal error',
    },
    status: {
      empty: 'The name cannot be empty',
      notIdentifier: 'Must be a Python identifier: letters/underscore first, then letters, digits, underscore',
      reserved: '"{name}" is reserved by the runner (names_* / shape_* / meta)',
      duplicate: 'Already the name of {panel} "{name}"',
      caseTwin: '',
      keyword: '',
      notFound: '这个端口或输出已经不存在了',
    },
    failure: {
      portNames: 'Port names must cover every bound port, be unique, and be ASCII identifiers',
      outputs: 'The output declaration cannot be empty and its names must be unique',
      name: 'declaration field: {name}',
      line: 'line {line}',
      timeout: 'exceeded {ms} ms',
      detail: 'Detail',
      stderr: 'traceback',
      name2: 'Failing output: {name}',
    },
    runMode: { clean: 'Clean', debug: 'Debug' },
    runSummary: '{mode} run · {ms} ms · {outputs} output(s)',
    traceJump: 'Jump to line {line}',
    diagnostics: 'Diagnostics',
    diagnosticLocal: 'Local',
    diagnosticBackend: 'Backend',
    diagnosticLocalSyntax: 'Not valid Python (immediate local check)',
    impureStamp: 'Not reproducible',
    impureTitle: 'Not reproducible: {items}',
    impureSeparator: ', ',
  },
};

function fill(template: string, params: Record<string, string | number>): string {
  let text = template;
  for (const [key, value] of Object.entries(params)) {
    text = text.split(`{${key}}`).join(String(value));
  }
  return text;
}

/** Human sentence for one name problem, naming the conflicting declaration. */
export function describeScriptNameProblem(
  problem: ScriptNameProblem,
  labels: ScriptLabels,
): string {
  switch (problem.code) {
    case 'duplicate':
      return fill(labels.status.duplicate, {
        panel: problem.panel === 'port' ? labels.ports : labels.outputs,
        name: problem.name,
      });
    case 'reserved':
      return fill(labels.status.reserved, { name: problem.name });
    case 'notIdentifier':
      return labels.status.notIdentifier;
    case 'empty':
      return labels.status.empty;
    case 'caseTwin':
      return fill(labels.warnings.caseTwin, { name: problem.name });
    case 'keyword':
      return fill(labels.warnings.keyword, { name: problem.name });
    case 'notFound':
      return labels.status.notFound;
  }
}

// ── traceback ────────────────────────────────────────────────────────────────────────

/** One line of a traceback, plus the script line it points at when it names one. */
export interface TracebackLine {
  text: string;
  /** 1-based script line, from `File "<脚本卡>", line 7`; `null` for prose lines. */
  line: number | null;
}

/**
 * Split the backend's `stderr` tail into lines and pull out the script line each one blames.
 *
 * The runner compiles the user's text with NO wrapper (decision §二), so a traceback's line
 * numbers are exactly what the editor shows — which is what makes them clickable instead of
 * merely informative.
 */
export function tracebackLines(stderr: string): TracebackLine[] {
  if (stderr.length === 0) return [];
  return stderr
    .split(/\r?\n/)
    .filter((text) => text.length > 0)
    .map((text) => {
      const match = /\bline\s+(\d+)/.exec(text);
      return { text, line: match ? Number(match[1]) : null };
    });
}

// ── two-layer diagnostics ────────────────────────────────────────────────────────────
//
// The editor diagnoses in two layers, and they exist for different reasons:
//
//   1. LOCAL (lezer, zero latency) — the parser CodeMirror already runs for highlighting flags
//      unparsable regions. It answers while the user is still typing, but it is NOT the
//      authority: it is a different implementation of "Python" from the one that will run.
//   2. AUTHORITATIVE (POST /api/script/check, debounced) — the backend compiles the text with
//      the pinned CPython and statically scans the AST for non-reproducible reads. Its line
//      and column are the ones a later traceback will use, so when its verdict is for the
//      text on screen it REPLACES the local guess instead of sitting next to it.
//
// The merge is a pure function so the rule is testable without a DOM. Backend verdict for the
// current text wins; anything else (pending, stale, unavailable) falls back to the local layer,
// so the editor never has a silent window — and "could not check" is itself a visible note,
// because it must not look like "checked and clean".

/** One diagnostic line in the card, whichever layer produced it. */
export interface ScriptDiagnostic {
  source: 'local' | 'backend';
  /**
   * `localSyntax` is lezer's guess; `syntaxError` is CPython's verdict; every other code means
   * the authoritative layer could not answer, and those are notes, never errors.
   */
  code: 'localSyntax' | ScriptCheckErrorCode;
  /** 1-based; 0 when the problem has no position (a note, or a compile-level refusal). */
  line: number;
  col: number;
  /** CPython's own message for a syntax error; empty otherwise. */
  detail: string;
}

/** A completed authoritative check, remembered together with the text it judged. */
export interface CompletedScriptCheck {
  text: string;
  result: ScriptCheckResult;
}

/**
 * The instant layer: parse `source` with the same lezer grammar the editor highlights with and
 * report the first unparsable region. `null` when the tree has none.
 */
export function localSyntaxDiagnostic(source: string): ScriptDiagnostic | null {
  const tree = pythonLanguage.parser.parse(source);
  let found: ScriptDiagnostic | null = null;
  tree.iterate({
    enter: (node) => {
      if (found !== null) return false;  // one error is the headline; the rest are its cascade
      if (!node.type.isError) return undefined;
      let line = 1;
      let lineStart = 0;
      for (let index = 0; index < node.from; index += 1) {
        if (source.charCodeAt(index) === 10) {
          line += 1;
          lineStart = index + 1;
        }
      }
      found = {
        source: 'local',
        code: 'localSyntax',
        line,
        col: node.from - lineStart + 1,
        detail: '',
      };
      return false;
    },
  });
  return found;
}

/**
 * What the editor shows: one merged list.
 *
 * A verdict is only applied to the text it was produced for (`check.text === text`); a stale
 * answer must never overwrite a diagnostic about what the user is looking at now.
 */
export function mergeScriptDiagnostics(
  local: ScriptDiagnostic | null,
  check: CompletedScriptCheck | null,
  text: string,
): ScriptDiagnostic[] {
  const known = check !== null && check.text === text ? check.result : null;
  if (known !== null) {
    if (known.ok) return [];  // authoritative: the script compiles
    const error = known.error;
    if (error?.code === 'syntaxError') {
      return [
        {
          source: 'backend',
          code: 'syntaxError',
          line: typeof error.line === 'number' ? error.line : 0,
          col: typeof error.col === 'number' ? error.col : 0,
          detail: error.message ?? '',
        },
      ];
    }
    // The check ran into the MACHINE, not into the script: keep the local layer and say why
    // the authoritative one is quiet.
    const entries: ScriptDiagnostic[] =
      local !== null ? [local] : [];
    entries.push({
      source: 'backend',
      code: error?.code ?? 'internalError',
      line: 0,
      col: 0,
      detail: '',
    });
    return entries;
  }
  return local !== null ? [local] : [];
}

/**
 * Transport for the authoritative layer. `checkScript` is stateless (one POST, no session), so
 * a per-card client would only create objects; the card never needs the store's singleton.
 */
const CHECK_CLIENT = new BackendClient();

// ── inline name editor ──────────────────────────────────────────────────────────────

interface NameFieldProps {
  /** The declared name the card currently uses. */
  value: string;
  /** Accessible label ("input port" / "output"). */
  ariaLabel: string;
  labels: ScriptLabels;
  /** Judge a candidate name (the caller supplies the other declarations). */
  check: (candidate: string) => ScriptNameCheck;
  /** Identifier occurrences of `value` in the script — what a rename would rewrite. */
  occurrences: number;
  onCommit: (candidate: string) => void;
}

/**
 * Inline name input with a LIVE preview, shared by both panels.
 *
 * The preview is the point: renaming an injected variable rewrites the user's script, so the
 * tool says how many identifier occurrences are about to change (a name that only appears in
 * a comment rewrites nothing — that difference is invisible without the count).
 */
function NameField({ value, ariaLabel, labels, check, occurrences, onCommit }: NameFieldProps) {
  const [draft, setDraft] = useState(value);

  // A rename from the other side (or from the store) must win over a stale draft.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const result = draft === value ? null : check(draft);
  const error = result?.error ?? null;
  const warning = result?.warning ?? null;

  const commit = () => {
    if (draft === value) return;
    // The store judges again with the same rule: the preview is a preview, the action is
    // the authority, and they cannot disagree because it is one function.
    if (check(draft).error) return;
    onCommit(draft);
  };

  return (
    <span className="script-card__name-field">
      <input
        className={`script-card__name${error ? ' script-card__name--invalid' : ''}`}
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={error !== null}
        spellCheck={false}
        title={labels.renameHint}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
      {result ? (
        <span className="script-card__name-hint" role={error ? 'alert' : 'status'}>
          {error
            ? describeScriptNameProblem(error, labels)
            : occurrences === 0
              ? labels.replaceNone
              : fill(labels.replaceCount, { n: occurrences })}
        </span>
      ) : null}
      {!error && warning ? (
        <span className="script-card__name-warn" role="status">
          {describeScriptNameProblem(warning, labels)}
        </span>
      ) : null}
    </span>
  );
}

// ── output preview ──────────────────────────────────────────────────────────────────

function OutputPreview({
  preview,
  labels,
  onLayoutChange,
}: {
  preview: ScriptPreview | undefined;
  labels: ScriptLabels;
  /** Fired after the toggle commits, because the row it lives in just changed height. */
  onLayoutChange: () => void;
}) {
  const [open, setOpen] = useState(false);

  /**
   * The preview grows INSIDE the row card, so expanding it moves every row below without a
   * drag or a resize for anything else to notice. The effect (not the click handler) runs
   * after the commit, which is the first moment the new height is measurable.
   */
  useEffect(() => {
    onLayoutChange();
  }, [open, onLayoutChange]);

  if (!preview || preview.head.length === 0) {
    return <span className="script-card__preview-empty">{labels.noPreview}</span>;
  }
  return (
    <div className="script-card__preview">
      <button
        type="button"
        className="script-card__preview-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {labels.previewToggle}
      </button>
      {open ? (
        <table className="script-card__preview-table">
          <thead>
            <tr>
              {preview.columns.map((name, index) => (
                <th key={`${name}-${index}`}>{name || `Pos.${index + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.head.slice(0, SCRIPT_PREVIEW_ROWS).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    {Number.isFinite(cell) ? Number(cell.toPrecision(6)) : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

// ── debug panel ─────────────────────────────────────────────────────────────────────

interface DebugPanelProps {
  run: ScriptRunState | null;
  labels: ScriptLabels;
  onJumpToLine: (line: number) => void;
}

/** Open when there is something to say, collapsed when empty (decision §六's "空时收起"). */
function DebugPanel({ run, labels, onJumpToLine }: DebugPanelProps) {
  const state = run ?? emptyScriptRun();
  const hasContent =
    state.status === 'error' || state.status === 'done' || state.code !== null;
  const [open, setOpen] = useState(hasContent);

  // A new error opens the panel even if the user closed it after the previous run.
  useEffect(() => {
    if (state.status === 'error' && state.code !== null) setOpen(true);
  }, [state.status, state.code]);

  if (!hasContent) return null;

  const params = state.params ?? {};
  const stderr = typeof params.stderr === 'string' ? params.stderr : '';
  const trace = tracebackLines(stderr);
  const headline = state.code ? (labels.errors[state.code] ?? state.code) : null;

  return (
    <section className="script-card__debug" aria-label={labels.debugInfo}>
      <button
        type="button"
        className="script-card__debug-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="script-card__debug-title">{labels.debugInfo}</span>
        {headline ? <span className="script-card__debug-headline">{headline}</span> : null}
      </button>
      {open ? (
        <div className="script-card__debug-body">
          {state.elapsedMs !== null ? (
            <p className="script-card__debug-line">
              {fill(labels.runSummary, {
                mode: labels.runMode[state.mode ?? 'clean'],
                ms: state.elapsedMs,
                outputs: Object.keys(state.previews).length,
              })}
            </p>
          ) : null}
          {typeof params.name === 'string' ? (
            <p className="script-card__debug-line">
              {state.code === 'invalidParams'
                ? (labels.failure[params.name] ?? fill(labels.failure.name, { name: params.name }))
                : fill(labels.failure.name2, { name: params.name })}
            </p>
          ) : null}
          {typeof params.msg === 'string' ? (
            <p className="script-card__debug-line">
              {params.msg}
              {typeof params.line === 'number' ? (
                <button
                  type="button"
                  className="script-card__trace-jump"
                  title={fill(labels.traceJump, { line: params.line })}
                  onClick={() => onJumpToLine(params.line as number)}
                >
                  {fill(labels.failure.line, { line: params.line })}
                </button>
              ) : null}
            </p>
          ) : null}
          {typeof params.reason === 'string' ? (
            <p className="script-card__debug-line">{params.reason}</p>
          ) : null}
          {typeof params.timeout_ms === 'number' ? (
            <p className="script-card__debug-line">
              {fill(labels.failure.timeout, { ms: params.timeout_ms })}
            </p>
          ) : null}
          {typeof params.detail === 'string' ? (
            <p className="script-card__debug-line">
              {labels.failure.detail}: {params.detail}
            </p>
          ) : null}
          {trace.length > 0 ? (
            <div className="script-card__trace">
              <div className="script-card__trace-title">{labels.failure.stderr}</div>
              {trace.map((entry, index) => (
                <div className="script-card__trace-line" key={index}>
                  {entry.line === null ? (
                    <span>{entry.text}</span>
                  ) : (
                    <button
                      type="button"
                      className="script-card__trace-jump"
                      title={fill(labels.traceJump, { line: entry.line })}
                      onClick={() => onJumpToLine(entry.line as number)}
                    >
                      {entry.text}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ── the card ────────────────────────────────────────────────────────────────────────

export interface ScriptCardProps {
  card: FunctionCardModel;
  active: boolean;
  closeBlocked: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseBlocked: () => void;
  /**
   * Observer hook fired when a traceback line is clicked (the embedded editor is scrolled
   * first). Production passes nothing; a host that opens the script in a larger editor — or
   * the DOM test — can use it to see which line was asked for.
   */
  onJumpToLine?: (line: number) => void;
}

/** Source line of one input port, resolved from the cards the port reads. */
interface PortView {
  portId: string;
  varName: string;
  mode: 'matrix' | 'cell';
  label: string;
  rows: number;
  cols: number;
  missing: boolean;
}

export function ScriptCard({
  card,
  active,
  closeBlocked,
  onActivate,
  onClose,
  onCloseBlocked,
  onJumpToLine,
}: ScriptCardProps) {
  const { t, locale } = useTranslator();
  const labels = LABELS[locale];
  const cards = useWorkspace((state) => state.cards);
  const matrices = useWorkspace((state) => state.matrices);
  const run = useWorkspace((state) => state.scriptRuns[card.id] ?? null);
  /**
   * The WORKSPACE's environment stamp, not this build's pinned constants.
   *
   * A workspace saved on another machine must keep printing the versions it was saved with;
   * the global banner is what says the two disagree (and the store never rewrites the block).
   */
  const workspaceEnv = useWorkspace((state) => state.workspaceEnv);

  const setScriptText = useWorkspace((state) => state.setScriptText);
  const runScriptCard = useWorkspace((state) => state.runScriptCard);
  const debugScriptCard = useWorkspace((state) => state.debugScriptCard);
  const renameScriptPort = useWorkspace((state) => state.renameScriptPort);
  const renameScriptOutput = useWorkspace((state) => state.renameScriptOutput);
  const addScriptPort = useWorkspace((state) => state.addScriptPort);
  const addScriptOutput = useWorkspace((state) => state.addScriptOutput);
  const removeScriptOutput = useWorkspace((state) => state.removeScriptOutput);
  /**
   * The creation verbs an output can feed. They are read from the store like every other
   * action here, and none of them is told to `select` the new card: the store already does
   * that for all three, so a second call would only duplicate the rule.
   */
  const addChartCard = useWorkspace((state) => state.addChartCard);
  const addFormulaCard = useWorkspace((state) => state.addFormulaCard);
  const addScriptCard = useWorkspace((state) => state.addScriptCard);
  const setFunctionPanelOpen = useWorkspace((state) => state.setFunctionPanelOpen);
  const setScriptAutoRun = useWorkspace((state) => state.setScriptAutoRun);
  const trust = useWorkspace((state) => state.trust);
  const confirmTrustedScript = useWorkspace((state) => state.confirmTrustedScript);
  /** A script restored from an untrusted file runs nothing until the user confirms it. */
  const trusted = scriptTrusted(trust, card.id);
  const trustedRef = useRef(trusted);
  trustedRef.current = trusted;
  /**
   * Anchor of the open build menu, in VIEWPORT coordinates.
   *
   * The anchor is measured from the button's own rect instead of being derived from the
   * card's bounds because `Popup` portals into `document.body`: a card is a transformed
   * react-rnd window, so anything positioned inside it is relative to the card and clipped
   * by `overflow: hidden`.
   */
  const [buildMenu, setBuildMenu] = useState<{
    x: number;
    y: number;
    outputId: string;
    ordinal: number;
  } | null>(null);

  const params = scriptParams(card);
  const scriptText = params.script;
  // Fold state is presentation, persisted with the card (absent = expanded, the old look).
  const inputsOpen = card.inputsPanelOpen ?? true;
  const outputsOpen = card.outputsPanelOpen ?? true;
  const portNames = card.inputs.map((input, index) => portVarName(card, input, index));
  const outputNames = card.outputs.map((_, ordinal) => params.outputs[ordinal] ?? '');

  // ── sources (left panel) ──
  const ports: PortView[] = useMemo(
    () =>
      card.inputs.map((input, index) => {
        const matrix = matrices.get(input.target.matrixId);
        const owner = cards.find((other) => other.id === input.target.cardId);
        const sourceName =
          owner && isMatrixCard(owner)
            ? owner.sources.find((source) => source.matrixId === input.target.matrixId)?.name
            : owner && isFormulaCard(owner)
              ? t('formula.outputLabel', { n: owner.id })
              : undefined;
        const column = input.target.type === 'cell' ? input.target.column : undefined;
        const label = [
          sourceName ?? `#${input.target.matrixId}`,
          column !== undefined
            ? (matrix?.columnLabel(column) || matrix?.column(column).posName || `col ${column + 1}`)
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          portId: input.portId,
          varName: portVarName(card, input, index),
          mode: input.target.type === 'cell' ? 'cell' : 'matrix',
          label,
          rows: matrix?.rowCount() ?? 0,
          cols: matrix?.columnCount() ?? 0,
          missing: !matrix,
        };
      }),
    [card, cards, matrices, t],
  );

  // ── diagnostics: local layer now, authoritative layer after the 200 ms settle ──
  //
  // `localDiagnostic` is recomputed from the editor's own document on every keystroke (below),
  // so it never waits for the store's 200 ms settle. `check` remembers which text the
  // last authoritative verdict was about — applying a stale verdict to newer text is the one
  // bug this state shape is designed to make impossible.
  const [localDiagnostic, setLocalDiagnostic] = useState<ScriptDiagnostic | null>(() =>
    localSyntaxDiagnostic(scriptText),
  );
  /**
   * The document as the EDITOR has it, not as the store has it.
   *
   * The store's `scriptText` lags by the 200 ms operation settle, so merging diagnostics
   * against it would pair a fresh local error with an old authoritative verdict and show the
   * wrong layer for the wrong text. This state is updated in the same listener that computes
   * the local layer, i.e. at the speed of typing.
   */
  const [documentText, setDocumentText] = useState(scriptText);
  const [check, setCheck] = useState<CompletedScriptCheck | null>(null);
  const checkSequence = useRef(0);

  const runCheck = useCallback((text: string) => {
    const sequence = ++checkSequence.current;
    void CHECK_CLIENT.checkScript(text).then(
      (result) => {
        // A newer edit already asked a newer question: this answer is about old text.
        if (sequence !== checkSequence.current) return;
        setCheck({ text, result });
      },
      () => {
        // checkScript itself never throws; this is belt and braces for a transport that
        // violates its own contract. Either way the local layer stays visible.
        if (sequence !== checkSequence.current) return;
        setCheck({
          text,
          result: { ok: false, impure: [], error: { code: 'backendUnavailable' } },
        });
      },
    );
  }, []);

  // Opening a card is a moment the user is looking at the script without having typed
  // anything, so the authoritative pass runs once up front: an already-impure script must be
  // stamped before the first edit. Later text changes come through the editor's update
  // listener — including external rewrites, which the sync effect below dispatches into the
  // view — so scheduling from `scriptText` here would double every edit's request.
  useEffect(() => {
    if (scriptText.trim().length > 0) runCheck(scriptText);
    return () => {
      // A pending definition edit for this card must not land after the card is gone.
      cancelOperation(`script:${card.id}`);
      ++checkSequence.current;  // a reply landing after unmount must not set state
    };
  }, [runCheck]);  // mount/unmount only; `scriptText` is read as the opening value on purpose

  // ── editor ──
  const editorHost = useRef<HTMLDivElement | null>(null);
  const editorView = useRef<EditorView | null>(null);
  // Callbacks the editor is created with are reached through refs: re-creating the view on
  // every render would throw away the cursor, the undo history and the user's selection.
  const changeRef = useRef(setScriptText);
  const checkRef = useRef(runCheck);
  const debugRef = useRef(debugScriptCard);
  changeRef.current = setScriptText;
  checkRef.current = runCheck;
  debugRef.current = debugScriptCard;

  /**
   * Drop this card's pending definition edit.
   *
   * Used when an EXTERNAL rewrite (a rename) replaces the document: the pending task holds the
   * pre-rename text, and letting it land would undo the rename. The rename path itself flushes
   * first instead of cancelling — there the pending text is the newer intent and must be
   * committed before the rewrite.
   */
  const cancelPendingEdit = useCallback(() => {
    cancelOperation(`script:${card.id}`);
  }, [card.id]);

  useEffect(() => {
    const host = editorHost.current;
    if (!host) return undefined;
    const view = new EditorView({
      state: EditorState.create({
        doc: scriptText,
        extensions: [
          basicSetup,
          python(),
          EditorView.editorAttributes.of({ class: 'script-card__cm' }),
          keymap.of([
            {
              key: 'Ctrl-Enter',
              mac: 'Cmd-Enter',
              run: () => {
                // An untrusted script has no shortcut either: the gate is the same one the
                // buttons sit behind.
                if (!trustedRef.current) return true;
                // Ctrl+Enter is the run the user is inspecting with, so it is the DEBUG run:
                // inspecting must never publish into the graph. Flush the pending text first:
                // a shortcut is a finished operation, not a pause.
                flushOperations();
                debugRef.current(card.id);
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            setDocumentText(text);
            // Layer 1, synchronously: lezer's own parse of what is in the document NOW. No
            // timer, no request — this is what makes the first diagnostic feel instant.
            setLocalDiagnostic(localSyntaxDiagnostic(text));
            // Both remaining layers wait for the same workspace-wide 200 ms settle: the
            // authoritative CPython verdict and the definition PATCH leave in one wave, so a
            // burst of typing costs one process and one store update — and the graph advances
            // immediately after (the backend evaluates the subtree, nothing per-card waits).
            settleOperation(`script:${card.id}`, () => {
              changeRef.current(card.id, text);
              checkRef.current(text);
            });
          }),
        ],
      }),
      parent: host,
    });
    editorView.current = view;
    return () => {
      view.destroy();
      editorView.current = null;
    };
    // Created ONCE per card, on purpose: re-creating the view on every render would throw
    // away the cursor, the undo history and the scroll position. The document is kept in
    // sync by the effect below, and the callbacks are read through refs.
  }, [card.id]);

  // An external rewrite (a rename rewrites identifiers) replaces the document, keeping the
  // caret at the same offset. A stale debounce must be cancelled first, or the pre-rename
  // text would land again and undo the rename.
  useEffect(() => {
    const view = editorView.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === scriptText) return;
    cancelPendingEdit();
    const anchor = Math.min(view.state.selection.main.head, scriptText.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: scriptText },
      selection: { anchor },
    });
  }, [scriptText, cancelPendingEdit]);

  useEffect(() => cancelPendingEdit, [cancelPendingEdit]);

  const jumpToLine = useCallback(
    (line: number) => {
      const view = editorView.current;
      if (view && line >= 1 && line <= view.state.doc.lines) {
        const position = view.state.doc.line(line).from;
        view.dispatch({
          selection: { anchor: position },
          effects: EditorView.scrollIntoView(position, { y: 'center' }),
        });
        view.focus();
      }
      onJumpToLine?.(line);
    },
    [onJumpToLine],
  );

  // ── rename plumbing ──
  const checkForPanel = useCallback(
    (panel: 'port' | 'output', ordinal: number) => (candidate: string) =>
      checkScriptName({
        name: candidate,
        panel,
        portNames: portNames.filter((_, index) => panel !== 'port' || index !== ordinal),
        outputNames: outputNames.filter((_, index) => panel !== 'output' || index !== ordinal),
      }),
    [portNames, outputNames],
  );

  const running = run?.status === 'running';
  const state = running ? 'computing' : (card.node?.state ?? 'idle');
  const displayRows = matrices.get(card.displayMatrixId)?.rowCount() ?? 0;
  const displayCols = matrices.get(card.displayMatrixId)?.columnCount() ?? 0;
  const badge = `${card.outputs.length} ${labels.outputs} · ${displayRows}×${displayCols}`;
  /**
   * The stamp: the workspace's python + pinned package versions, then this browser's last
   * duration when there is one. Read from the workspace so a mismatched save file keeps its
   * own numbers visible on every script card instead of quietly printing the local ones.
   */
  const numpyVersion = workspaceEnvPackageVersion(workspaceEnv, 'numpy');
  const stamp =
    numpyVersion === ''
      ? `python ${workspaceEnv.python}`
      : `python ${workspaceEnv.python} · numpy ${numpyVersion}`;
  const env =
    run?.elapsedMs !== null && run?.elapsedMs !== undefined
      ? `${stamp} · ${run.elapsedMs} ms`
      : stamp;
  /**
   * The backend reached the compute path and found no usable interpreter
   * (`runtimeMissing`). This is a STATE OF THE MACHINE, not a defect of the script, so it
   * gets a plain red explanation and nothing is hidden: the declaration panels and the
   * editor stay exactly as usable as they were, and no retry is started behind the user.
   */
  const runtimeMissing = run?.status === 'error' && run?.code === 'runtimeMissing';

  // ── two-layer diagnostics, merged for display ──
  const diagnostics = mergeScriptDiagnostics(localDiagnostic, check, documentText);
  /**
   * The "not reproducible" stamp: the runner's own list of non-reproducible reads, taken from
   * the last authoritative check — and only while that check still describes the text on
   * screen. A stamp on text it never saw is the one thing a label must not do, so an edit
   * clears it until the next verdict lands. It is a LABEL, never a gate: both run buttons keep
   * working (the decision doc: the consequence belongs to the user, the tool's job is to show it).
   */
  const impure =
    check !== null && check.result.ok && check.text === documentText ? check.result.impure : [];
  const impureTitle = fill(labels.impureTitle, {
    items: impure.join(labels.impureSeparator),
  });
  /**
   * The stamp lives in the title bar. CardShell renders `title` as both the visible text and
   * the native tooltip, so the trigger list travels with the stamp itself — hovering the
   * truncated title is how a user finds out which read made the card impure.
   */
  const titleBase = outputNames[0] ? `${labels.cardTitle} — ${outputNames[0]}` : labels.cardTitle;
  const title = impure.length === 0 ? titleBase : `${titleBase} · ${impureTitle}`;

  /**
   * What the open build menu reads: the width of the output it was opened from.
   *
   * Taken from the run's previews rather than from the slot matrix because a declared but
   * never-run output has a slot but no rows — "0 columns" and "not run yet" are the same
   * thing to this menu, and the hint says so.
   */
  const buildMenuCols = buildMenu ? (run?.previews[buildMenu.outputId]?.cols ?? 0) : 0;
  /** The name a "created chart" toast quotes: the user's label, or the identity if unnamed. */
  const buildMenuName = buildMenu ? outputNames[buildMenu.ordinal] || buildMenu.outputId : '';

  // ── connection ports ──
  //
  // Every row is drawn as its own small card, and that card's head is what a wire anchors on
  // (decision 2026-11-17-port-anchored-connections): an input is met at its LEFT edge and an
  // output is left at its RIGHT edge, so a wire always meets the column it belongs to.
  //
  // The ref callbacks are memoized by port identity on purpose: this component re-renders on
  // every keystroke, and a freshly created callback each render would make React detach and
  // re-attach the ref, i.e. unregister + register, and every registration bumps the layout
  // version — one wire re-measure per typed character.
  const portRefFor = useMemo(() => {
    const callbacks = new Map<
      string,
      (element: HTMLElement | null) => (() => void) | undefined
    >();
    return (portId: string, side: AnchorSide) => {
      const key = `${side}:${portId}`;
      const existing = callbacks.get(key);
      if (existing) return existing;
      const callback = (element: HTMLElement | null) => {
        if (!element) return undefined;
        registerPort(card.id, portId, element, side);
        // The cleanup keeps the registry honest when the row leaves the list or the card
        // closes: a stale rect would leave a wire pointing at nothing.
        return () => unregisterPort(card.id, portId);
      };
      callbacks.set(key, callback);
      return callback;
    };
  }, [card.id, card.inputs, card.outputs]);

  // The row lists, so the observer below can watch them grow, shrink and reflow.
  const inputsList = useRef<HTMLUListElement | null>(null);
  const outputsList = useRef<HTMLUListElement | null>(null);

  /**
   * Row reflow is layout too.
   *
   * A preview expanding, a rename hint wrapping onto a second line or a row card growing all
   * move the anchors below them, and none of those passes through a drag or a resize handler.
   * The LISTS are observed rather than the rows, because a list also catches rows that did not
   * exist when this effect first ran (a new output, a new port).
   */
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => invalidateLayout());
    if (inputsList.current) observer.observe(inputsList.current);
    if (outputsList.current) observer.observe(outputsList.current);
    return () => observer.disconnect();
  }, [card.inputs.length, card.outputs.length]);

  /**
   * Stable, so the preview's effect fires when the toggle commits rather than on every
   * render of the row it lives in.
   */
  const invalidateOnLayoutChange = useCallback(() => invalidateLayout(), []);

  return (
    <CardShell
      card={card}
      variant="card--script"
      title={title}
      badge={badge}
      active={active}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      // Three columns need a floor of their own: below ~520px the 168px input column and the
      // 184px output column would leave the editor nothing, and the editor is the card.
      minWidth={520}
      minHeight={320}
      onBounds={(bounds) =>
        useWorkspace.getState().setBounds(card.id, bounds)
      }
    >
      <div className="script-card">
        <div className="script-card__bar">
          <button
            type="button"
            className="script-card__run"
            title={trusted ? labels.runTitle : labels.trustLockedHint}
            disabled={running || !trusted}
            onClick={() => {
              // A click means "the user finished": commit the editor's pending text first so
              // the run operates on exactly what is on screen.
              flushOperations();
              runScriptCard(card.id);
            }}
          >
            {labels.run}
          </button>
          <button
            type="button"
            className="script-card__run script-card__run--debug"
            title={trusted ? labels.debugTitle : labels.trustLockedHint}
            disabled={running || !trusted}
            onClick={() => {
              flushOperations();
              debugScriptCard(card.id);
            }}
          >
            {labels.debug}
          </button>
          <span className={`node-light node-light--${state}`} aria-hidden />
          {running ? (
            <span className="script-card__running">{labels.running}</span>
          ) : (
            <span className="script-card__env" title={env}>
              {env}
            </span>
          )}
          {card.autoRun !== undefined ? (
            <button
              type="button"
              className={`script-card__auto${card.autoRun ? ' is-on' : ''}`}
              aria-pressed={card.autoRun === true}
              title={labels.autoHint}
              onClick={() => setScriptAutoRun(card.id, card.autoRun !== true)}
            >
              {card.autoRun ? labels.autoOn : labels.autoOff}
            </button>
          ) : null}
          <span className="script-card__lang" aria-hidden>
            py
          </span>
        </div>

        {/*
          Locked script: the file it came from is not trusted (yet). The run buttons above are
          disabled rather than hidden — the card must still show what it would do, and one
          click here records the confirmation for this file.
        */}
        {!trusted ? (
          <div
            className="backend-banner script-card__locked"
            role="alert"
            data-script-locked={card.id}
            style={{ flexShrink: 0 }}
          >
            <span>
              <strong className="script-card__locked-title">{labels.trustLocked}</strong>
              {' — '}
              <span>{labels.trustLockedHint}</span>
            </span>
            <button
              type="button"
              className="card__control"
              onClick={() => confirmTrustedScript(card.id)}
            >
              {labels.trustConfirm}
            </button>
          </div>
        ) : null}

        {/*
          The red band sits between the run bar and the declaration panels: it must be
          impossible to miss, and it must not displace anything. Everything below keeps
          rendering (and stays editable) exactly as it did before the run — a missing
          runtime is not a reason to take the card's content away from the user.
        */}
        {runtimeMissing ? (
          <div
            className="backend-banner script-card__runtime-missing"
            role="alert"
            data-script-runtime-missing={card.id}
            // The band never shrinks: a card squeezed small must lose the debug panel (which
            // is collapsible) rather than silently drop the reason the run failed.
            style={{ flexShrink: 0 }}
          >
            {/* One flowing sentence: a title, then the one-line explanation that names the
                script which fetches the runtime. */}
            <span>
              <strong className="script-card__runtime-missing-title">
                {labels.runtimeMissingTitle}
              </strong>
              {' — '}
              <span className="script-card__runtime-missing-hint">
                {labels.runtimeMissingHint}
              </span>
            </span>
          </div>
        ) : null}

        {/*
          Three columns in one row: what the script reads, the script, what it produces. The
          editor used to be a full-width band below the declaration panels; putting the panels
          BESIDE it is what lets a wire enter a port row from the left and leave an output row
          to the right, at the row's own height, instead of at the card's edges.
        */}
        <div className="script-card__body">
          {/* ── left: what the script reads ── */}
          <SidePanel
            side="left"
            open={inputsOpen}
            onToggle={(open) => setFunctionPanelOpen(card.id, 'inputs', open)}
            title={labels.ports}
            panelId={`script-inputs-${card.id}`}
            className="script-card__panel script-card__panel--inputs"
            // Scrolling a column (or its rail) moves the ports, so re-measure the anchors.
            onScroll={() => invalidateLayout()}
            rail={
              ports.length === 0 ? (
                <span className="side-panel__rail-empty">—</span>
              ) : (
                ports.map((port) => (
                  <button
                    type="button"
                    className="script-card__rail-port"
                    key={port.portId}
                    // While the column is folded, the rail item IS the port element: same id,
                    // same side, so `portAnchor` keeps the wire at this row's height.
                    ref={portRefFor(port.portId, 'left')}
                    title={`${port.varName} · ${port.portId} · ${port.label}`}
                    onClick={() => setFunctionPanelOpen(card.id, 'inputs', true)}
                  >
                    {port.varName}
                  </button>
                ))
              )
            }
          >
            {ports.length === 0 ? (
              <p className="script-card__panel-empty">{labels.noPorts}</p>
            ) : (
              <ul className="script-card__row-list" ref={inputsList}>
                {ports.map((port, index) => (
                  <li className="script-card__row" key={port.portId}>
                    {/*
                      The row HEAD is the connection endpoint; the preview (its sibling, on
                      outputs) is not, so a wire never anchors on a row that has grown a table
                      under it. A wire enters at this head's LEFT edge.
                    */}
                    <div className="script-card__row-head" ref={portRefFor(port.portId, 'left')}>
                      <NameField
                        value={port.varName}
                        ariaLabel={`${labels.ports} ${index + 1}`}
                        labels={labels}
                        check={checkForPanel('port', index)}
                        occurrences={countScriptOccurrences(scriptText, port.varName)}
                        onCommit={(name) => {
                          // The rename rewrites identifiers in the CURRENT script: commit the
                          // pending editor text before it, or the two edits would race.
                          flushOperations();
                          renameScriptPort(card.id, port.portId, name);
                        }}
                      />
                      <span className="script-card__source" title={port.label}>
                        ← {port.label}
                      </span>
                      <span
                        className={`script-card__shape${port.missing ? ' script-card__shape--missing' : ''}`}
                      >
                        {port.missing ? '—' : `${port.rows}×${port.cols}`}
                      </span>
                      <span className="script-card__mode">
                        {t(port.mode === 'cell' ? 'formula.modeCell' : 'formula.modeMatrix')}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="script-card__add"
              disabled={ports.length === 0}
              onClick={() => {
                // The action appends to the script's text: it must append to the latest text.
                flushOperations();
                addScriptPort(card.id);
              }}
            >
              {labels.addPort}
            </button>
          </SidePanel>

          {/* ── middle: the script itself ── */}
          <div className="script-card__editor" ref={editorHost} data-script-editor={card.id} />

          {/* ── right: what the script produces ── */}
          <SidePanel
            side="right"
            open={outputsOpen}
            onToggle={(open) => setFunctionPanelOpen(card.id, 'outputs', open)}
            title={labels.outputs}
            panelId={`script-outputs-${card.id}`}
            className="script-card__panel script-card__panel--outputs"
            onScroll={() => invalidateLayout()}
            rail={card.outputs.map((output, ordinal) => (
              <button
                type="button"
                className="script-card__rail-port script-card__rail-port--output"
                key={output.outputId}
                ref={portRefFor(output.outputId, 'right')}
                title={`${outputNames[ordinal] || output.outputId} · ${output.outputId}`}
                onClick={() => setFunctionPanelOpen(card.id, 'outputs', true)}
              >
                {outputNames[ordinal] || output.outputId}
              </button>
            ))}
          >
            <ul className="script-card__row-list" ref={outputsList}>
              {card.outputs.map((output, ordinal) => {
                const preview = run?.previews[output.outputId];
                return (
                  <li
                    className="script-card__row script-card__row--output"
                    key={output.outputId}
                    // The output row is this card's equivalent of a column header: a data
                    // column is right-clicked to build from it, and every declared output
                    // — ordinal 0 included — is a matrix the store can already build from.
                    // The gesture is the entry point, not a button (the left-click 「建卡」
                    // button contradicted the workspace-wide rule that cards are born from a
                    // right-click on a header).
                    onContextMenu={(event) => {
                      // A text box or a button keeps its own gesture (paste, remove); a
                      // right-click there is not a request to build a card.
                      if ((event.target as HTMLElement).closest('input, button, textarea')) return;
                      event.preventDefault();
                      // The canvas owns the empty-space right-click, so this must not bubble.
                      event.stopPropagation();
                      setBuildMenu({
                        x: event.clientX,
                        y: event.clientY,
                        outputId: output.outputId,
                        ordinal,
                      });
                    }}
                  >
                    {/* The head, not the whole row: this is where the wire leaves, at this
                        row's height, from the RIGHT edge. */}
                    <div
                      className="script-card__row-head"
                      ref={portRefFor(output.outputId, 'right')}
                    >
                      <NameField
                        value={outputNames[ordinal] ?? ''}
                        ariaLabel={`${labels.outputs} ${ordinal + 1}`}
                        labels={labels}
                        check={checkForPanel('output', ordinal)}
                        occurrences={countScriptOccurrences(
                          scriptText,
                          outputNames[ordinal] ?? '',
                        )}
                        onCommit={(name) => {
                          flushOperations();
                          renameScriptOutput(card.id, output.outputId, name);
                        }}
                      />
                      <span className="script-card__output-id" title={output.outputId}>
                        {output.outputId}
                      </span>
                      <span className="script-card__shape">
                        {preview && preview.rows > 0 ? `${preview.rows}×${preview.cols}` : '—'}
                      </span>
                      <button
                        type="button"
                        className="script-card__remove"
                        title={labels.removeOutput}
                        aria-label={`${labels.removeOutput} ${outputNames[ordinal] ?? ordinal + 1}`}
                        disabled={ordinal === 0}
                        onClick={() => {
                          flushOperations();
                          removeScriptOutput(card.id, output.outputId);
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <OutputPreview
                      preview={preview}
                      labels={labels}
                      onLayoutChange={invalidateOnLayoutChange}
                    />
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className="script-card__add"
              onClick={() => {
                flushOperations();
                addScriptOutput(card.id);
              }}
            >
              {labels.addOutput}
            </button>
          </SidePanel>
        </div>

        {/*
          One merged list, not two panels: the user cares about "the script is wrong at line
          N", not about which layer noticed first. The source badge is the provenance — the
          backend's line numbers are the ones a traceback will print, so when they are there
          they are what the list shows; the local entry exists only while that answer is in
          flight (or unavailable).
        */}
        {diagnostics.length > 0 ? (
          <ul className="script-card__diagnostics" aria-label={labels.diagnostics}>
            {diagnostics.map((entry, index) => {
              const isError = entry.code === 'localSyntax' || entry.code === 'syntaxError';
              const text =
                entry.code === 'localSyntax'
                  ? labels.diagnosticLocalSyntax
                  : entry.code === 'syntaxError'
                    ? `${labels.errors.syntaxError}${entry.detail ? ` — ${entry.detail}` : ''}`
                    : entry.code === 'runtimeMissing'
                      ? labels.errors.runtimeMissing
                      : entry.code === 'backendUnavailable'
                        ? labels.errors.backendUnavailable
                        : labels.errors.internalError;
              return (
                <li
                  className={`script-card__diagnostic script-card__diagnostic--${
                    isError ? 'error' : 'note'
                  }`}
                  key={`${entry.source}-${entry.code}-${entry.line}-${index}`}
                  data-source={entry.source}
                  data-code={entry.code}
                  role={isError ? 'alert' : 'status'}
                >
                  <span className="script-card__diagnostic-source">
                    {entry.source === 'local' ? labels.diagnosticLocal : labels.diagnosticBackend}
                  </span>
                  {entry.line > 0 ? (
                    <button
                      type="button"
                      className="script-card__trace-jump"
                      title={fill(labels.traceJump, { line: entry.line })}
                      onClick={() => jumpToLine(entry.line)}
                    >
                      {fill(labels.failure.line, { line: entry.line })}
                      {entry.col > 0 ? `:${entry.col}` : ''}
                    </button>
                  ) : null}
                  <span className="script-card__diagnostic-message">{text}</span>
                </li>
              );
            })}
          </ul>
        ) : null}

        <DebugPanel run={run} labels={labels} onJumpToLine={jumpToLine} />
      </div>

      {/*
        The build menu — opened by right-clicking an output row, the same gesture a data
        column header uses. It is a sibling of the card body so nothing inside the card's
        `overflow: hidden` can clip it (see `Popup`). Every branch closes it itself: a menu
        that survives its own click leaves the user wondering whether the click landed.
      */}
      {buildMenu ? (
        <ContextMenu
          x={buildMenu.x}
          y={buildMenu.y}
          title={fill(labels.buildTitle, {
            name: outputNames[buildMenu.ordinal] || buildMenu.outputId,
            id: buildMenu.outputId,
          })}
          onDismiss={() => setBuildMenu(null)}
        >
          {/* No rows yet: say it once, and let the chart group below read as a rule rather
              than as a menu that silently does nothing. */}
          {buildMenuCols === 0 ? (
            <div className="context-menu__hint">{labels.outputEmpty}</div>
          ) : null}
          <ContextMenuSub label={t('table.contextChartMenu')}>
            <ChartTypeItems
              // A chart reads this output's columns from the left, so "enough" is about the
              // output's own width — the same rule the data card's column menu applies.
              remaining={buildMenuCols}
              columnLabel={buildMenuName}
              // A refusal this card can explain better than the width rule: the run has
              // finished but its output cache has not landed yet, which is a timing gap and
              // not a narrow table. The list owns the toast; this only supplies the words.
              refusedHint={labels.buildUnavailable}
              onPick={(type) => {
                // The submenu owns the chart toast, including the refusal: it derived the
                // rule, so it owns the wording — two toasts would only fight, because
                // `showToast` replaces the current one on screen.
                //
                // The card still owns its own lifecycle: it closes the menu (both outcomes),
                // the primitive only reports what happened.
                // Creating from an output reads the declaration: settle pending edits first.
                flushOperations();
                const created = addChartCard(card.id, 0, type, buildMenu.outputId);
                setBuildMenu(null);
                return created;
              }}
            />
          </ContextMenuSub>
          <div className="context-menu__separator" />
          <ContextMenuItem
            onClick={() => {
              // One table in, one table out: the slot id is the store's to resolve
              // (`out:0` is the display cache, `out:N` its own slot) — never derived here.
              flushOperations();
              const matrixId = outputMatrixId(card, buildMenu.outputId);
              const created = matrixId === null ? null : addFormulaCard(card.id, matrixId);
              if (created === null) {
                useWorkspace.getState().showToast('error', labels.buildUnavailable);
              }
              setBuildMenu(null);
            }}
          >
            {t('menu.newFormula')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              // Same birth binding the data card's column menu uses, pointed at this output.
              flushOperations();
              addScriptCard([{ cardId: card.id, outputId: buildMenu.outputId }]);
              setBuildMenu(null);
            }}
          >
            {t('menu.newScriptCard')}
          </ContextMenuItem>
        </ContextMenu>
      ) : null}
    </CardShell>
  );
}
