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
import { python } from '@codemirror/lang-python';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import type { Locale } from '../i18n.ts';
import {
  SCRIPT_PREVIEW_ROWS,
  checkScriptName,
  countScriptOccurrences,
  emptyScriptRun,
  useTranslator,
  useWorkspace,
  type ScriptNameCheck,
  type ScriptNameProblem,
  type ScriptPreview,
  type ScriptRunState,
} from '../workspaceStore.ts';
import { portVarName } from '../bindings.ts';
import {
  isFormulaCard,
  isMatrixCard,
  scriptParams,
  workspaceEnvPackageVersion,
  type FunctionCardModel,
} from '../types.ts';
import { CardShell } from './CardShell.tsx';

/**
 * How long an edit waits before it becomes a definition change.
 *
 * The backend stores `params` on PATCH and marks the node dirty, so shipping every keystroke
 * would be a network round trip per character for a card that never auto-runs anyway.
 */
const SCRIPT_DEBOUNCE_MS = 500;

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
  warnings: Record<'caseTwin' | 'keyword', string>;
  errors: Record<string, string>;
  status: Record<ScriptNameProblem['code'], string>;
  failure: Record<string, string>;
  runMode: { clean: string; debug: string };
  runSummary: string;
  traceJump: string;
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
}: {
  preview: ScriptPreview | undefined;
  labels: ScriptLabels;
}) {
  const [open, setOpen] = useState(false);
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

  const params = scriptParams(card);
  const scriptText = params.script;
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

  // ── editor ──
  const editorHost = useRef<HTMLDivElement | null>(null);
  const editorView = useRef<EditorView | null>(null);
  const syncTimer = useRef<number | null>(null);
  // Callbacks the editor is created with are reached through refs: re-creating the view on
  // every render would throw away the cursor, the undo history and the user's selection.
  const changeRef = useRef(setScriptText);
  const debugRef = useRef(debugScriptCard);
  changeRef.current = setScriptText;
  debugRef.current = debugScriptCard;

  const flushPendingEdit = useCallback(() => {
    if (syncTimer.current !== null) {
      window.clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
  }, []);

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
                // Ctrl+Enter is the run the user is inspecting with, so it is the DEBUG run:
                // inspecting must never publish into the graph.
                debugRef.current(card.id);
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
            syncTimer.current = window.setTimeout(() => {
              syncTimer.current = null;
              changeRef.current(card.id, text);
            }, SCRIPT_DEBOUNCE_MS);
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
    flushPendingEdit();
    const anchor = Math.min(view.state.selection.main.head, scriptText.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: scriptText },
      selection: { anchor },
    });
  }, [scriptText, flushPendingEdit]);

  useEffect(() => flushPendingEdit, [flushPendingEdit]);

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

  return (
    <CardShell
      card={card}
      variant="card--script"
      title={
        outputNames[0] ? `${labels.cardTitle} — ${outputNames[0]}` : labels.cardTitle
      }
      badge={badge}
      active={active}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) =>
        useWorkspace.getState().setBounds(card.id, bounds)
      }
    >
      <div className="script-card">
        <div className="script-card__bar">
          <button
            type="button"
            className="script-card__run"
            title={labels.runTitle}
            disabled={running}
            onClick={() => runScriptCard(card.id)}
          >
            {labels.run}
          </button>
          <button
            type="button"
            className="script-card__run script-card__run--debug"
            title={labels.debugTitle}
            disabled={running}
            onClick={() => debugScriptCard(card.id)}
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
          <span className="script-card__lang" aria-hidden>
            py
          </span>
        </div>

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

        <div className="script-card__panels">
          {/* ── left: what the script reads ── */}
          <section className="script-card__panel" aria-label={labels.ports}>
            <div className="script-card__panel-title">{labels.ports}</div>
            {ports.length === 0 ? (
              <p className="script-card__panel-empty">{labels.noPorts}</p>
            ) : (
              <ul className="script-card__row-list">
                {ports.map((port, index) => (
                  <li className="script-card__row" key={port.portId}>
                    <NameField
                      value={port.varName}
                      ariaLabel={`${labels.ports} ${index + 1}`}
                      labels={labels}
                      check={checkForPanel('port', index)}
                      occurrences={countScriptOccurrences(scriptText, port.varName)}
                      onCommit={(name) => renameScriptPort(card.id, port.portId, name)}
                    />
                    <span className="script-card__source" title={port.label}>
                      ← {port.label}
                    </span>
                    <span
                      className={`script-card__shape${port.missing ? ' script-card__shape--missing' : ''}`}
                    >
                      {port.missing ? '—' : `${port.rows}×${port.cols}`}
                    </span>
                    <span className="script-card__mode">{t(
                      port.mode === 'cell' ? 'formula.modeCell' : 'formula.modeMatrix',
                    )}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="script-card__add"
              disabled={ports.length === 0}
              onClick={() => addScriptPort(card.id)}
            >
              {labels.addPort}
            </button>
          </section>

          {/* ── right: what the script produces ── */}
          <section className="script-card__panel" aria-label={labels.outputs}>
            <div className="script-card__panel-title">{labels.outputs}</div>
            <ul className="script-card__row-list">
              {card.outputs.map((output, ordinal) => {
                const preview = run?.previews[output.outputId];
                return (
                  <li className="script-card__row script-card__row--output" key={output.outputId}>
                    <NameField
                      value={outputNames[ordinal] ?? ''}
                      ariaLabel={`${labels.outputs} ${ordinal + 1}`}
                      labels={labels}
                      check={checkForPanel('output', ordinal)}
                      occurrences={countScriptOccurrences(scriptText, outputNames[ordinal] ?? '')}
                      onCommit={(name) => renameScriptOutput(card.id, output.outputId, name)}
                    />
                    <span className="script-card__output-id" title={output.outputId}>
                      {output.outputId}
                    </span>
                    <span className="script-card__shape">
                      {preview && preview.rows > 0 ? `${preview.rows}×${preview.cols}` : '—'}
                    </span>
                    <OutputPreview preview={preview} labels={labels} />
                    <button
                      type="button"
                      className="script-card__remove"
                      title={labels.removeOutput}
                      aria-label={`${labels.removeOutput} ${outputNames[ordinal] ?? ordinal + 1}`}
                      disabled={ordinal === 0}
                      onClick={() => removeScriptOutput(card.id, output.outputId)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className="script-card__add"
              onClick={() => addScriptOutput(card.id)}
            >
              {labels.addOutput}
            </button>
          </section>
        </div>

        <div className="script-card__editor" ref={editorHost} data-script-editor={card.id} />

        <DebugPanel run={run} labels={labels} onJumpToLine={jumpToLine} />
      </div>
    </CardShell>
  );
}
