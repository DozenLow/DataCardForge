/**
 * Browser-side equivalents of the Qt file dialogs, plus the workspace format.
 *
 * The C++ frontend leaned on `QFileDialog` and a filesystem path. In the browser the
 * user hands us `File` objects through an `<input type="file">` or a drop event, and
 * results are handed back as downloads. This module isolates both directions so the
 * components stay free of DOM plumbing.
 */
import { MatrixData } from '../core/MatrixData.ts';
import type { ChartSource } from '../charts/chartModel.ts';
import { FILE_ACCEPT, loadMatrixFile } from '../loaders/FileLoaderFactory.ts';
import { migrateWorkspace, WorkspaceFormatError } from './migrate.ts';
import type { WorkspaceSnapshot } from './types.ts';
import { hashWorkspaceBytes } from './workspaceTrust.ts';

/** Open the native picker and resolve with the chosen files (empty when cancelled). */
export function pickFiles(multiple: boolean, accept = FILE_ACCEPT): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.position = 'fixed';
    input.style.left = '-9999px';

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => {
      finish(input.files ? Array.from(input.files) : []);
    });
    // `cancel` fires in modern browsers when the dialog is dismissed.
    input.addEventListener('cancel', () => finish([]));

    document.body.appendChild(input);
    input.click();
  });
}

export interface LoadedFile {
  name: string;
  matrix: MatrixData;
  /** Metadata of the file this was parsed from — see `MatrixEntry`. */
  identity: FileIdentity;
}

/**
 * Cheap lookup hint for the store's parse cache; the store compares parsed content
 * before sharing any matrix.
 */
export interface FileIdentity {
  size: number;
  lastModified: number;
}

export function identityOf(file: File): FileIdentity {
  return { size: file.size, lastModified: file.lastModified };
}

export function identityKey(identity: FileIdentity): string {
  return `${identity.size}:${identity.lastModified}`;
}

export interface LoadFailure {
  name: string;
  error: string;
}

/**
 * Parse a batch of files, reporting per-file failures instead of aborting.
 * Duplicate names inside one batch are de-duplicated by suffixing so each card shows a
 * distinct label; the byte identity travels with the parse for the store's cache.
 */
export async function parseFiles(
  files: File[],
): Promise<{ loaded: LoadedFile[]; failures: LoadFailure[] }> {
  const loaded: LoadedFile[] = [];
  const failures: LoadFailure[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    try {
      const matrix = await loadMatrixFile(file);
      let name = file.name;
      let counter = 2;
      while (seen.has(name)) {
        const dot = file.name.lastIndexOf('.');
        name =
          dot > 0
            ? `${file.name.slice(0, dot)} (${counter})${file.name.slice(dot)}`
            : `${file.name} (${counter})`;
        counter += 1;
      }
      seen.add(name);
      loaded.push({ name, matrix, identity: identityOf(file) });
    } catch (error) {
      failures.push({
        name: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { loaded, failures };
}

/**
 * Serialise a matrix as CSV, quoting only when needed.
 *
 * A UTF-8 BOM is prepended: without it Excel (the tool most of this data comes from and
 * goes back to) reads the file in the system code page and mangles non-ASCII column
 * headers — which is every annotated column in a Chinese-language lab.
 */
export function matrixToCsv(matrix: MatrixData): string {
  const rows = matrix.rowCount();
  const cols = matrix.columnCount();
  const lines: string[] = [];

  const header = [];
  for (let c = 0; c < cols; ++c) {
    header.push(csvField(matrix.columnLabel(c) || matrix.column(c).posName));
  }
  lines.push(header.join(','));

  for (let r = 0; r < rows; ++r) {
    const cells: string[] = [];
    for (let c = 0; c < cols; ++c) {
      const value = matrix.cell(r, c);
      const category = matrix.categoricalLabel(r, c);
      cells.push(category !== undefined ? csvField(category) : Number.isNaN(value) ? '' : String(value));
    }
    lines.push(cells.join(','));
  }

  return `\ufeff${lines.join('\n')}`;
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Trigger a browser download for text or binary payloads. Returns the byte length. */
export function downloadBlob(filename: string, blob: Blob): number {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return blob.size;
}

export function downloadText(
  filename: string,
  text: string,
  mime = 'text/plain;charset=utf-8',
): number {
  // `Blob.size` counts the BOM as the UTF-8 bytes it is, which is what the user's file
  // manager will report.
  return downloadBlob(filename, new Blob([text], { type: mime }));
}

/**
 * Read, upgrade and validate a workspace JSON file.
 *
 * Accepts schema v1 and v2; v1 is migrated by `migrateWorkspace` (pure + deterministic,
 * see docs/decisions/2026-10-26-card-schema-v2.md). Writing is always v2, so a saved file
 * only ever needs one migration pass in a user's lifetime.
 */
export interface LoadedWorkspace {
  snapshot: WorkspaceSnapshot;
  /** SHA-256 of the exact bytes parsed — the key the trust record is stored under. */
  hash: string;
}

/** Serialize the workspace text used both for the download and its trust hash. */
export function serializeWorkspace(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    cards: snapshot.cards.map((card) => {
      if (card.kind !== 'chart') return card;
      // A chart caches its plotted numbers in the config (attached columns, explicit X,
      // grouping factor). They need the same ±Infinity encoding as matrix columns: JSON
      // otherwise turns them into null — the NaN encoding — and a restored chart would
      // silently plot a gap where the file held a value.
      const encode = (source: ChartSource) =>
        source && Array.isArray(source.raw) &&
        (source.raw.includes(Infinity) || source.raw.includes(-Infinity))
          ? {
              ...source,
              raw: source.raw.map((value) =>
                value === Infinity || value === -Infinity ? String(value) : value,
              ),
            }
          : source;
      const config = card.config;
      // A malformed card passes through untouched: refusing it is the reader's job, and
      // the writer must not throw on the way to a file the reader will reject.
      if (!config || typeof config !== 'object' || !Array.isArray(config.sources)) return card;
      return {
        ...card,
        config: {
          ...config,
          sources: config.sources.map(encode),
          xAxisSource: config.xAxisSource ? encode(config.xAxisSource) : config.xAxisSource,
          factorSource: config.factorSource ? encode(config.factorSource) : config.factorSource,
        },
      };
    }),
    matrices: snapshot.matrices.map((matrix) => ({
      ...matrix,
      columns: matrix.columns.map((column) => {
        const { data } = column;
        if (!data.includes(Infinity) && !data.includes(-Infinity)) return column;
        // JSON otherwise turns both infinities into null, the existing encoding for NaN.
        // The v1/v2 matrix reader already accepts these numeric strings.
        return {
          ...column,
          data: data.map((value) => (value === Infinity || value === -Infinity ? String(value) : value)),
        };
      }),
    })),
  });
}

export async function readWorkspace(file: File): Promise<LoadedWorkspace> {
  // One read for both jobs: the hash must describe the bytes the snapshot was parsed from,
  // otherwise a file changed on disk mid-open could be blessed under the wrong identity.
  const bytes = await file.arrayBuffer();
  const hash = await hashWorkspaceBytes(bytes);
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WorkspaceFormatError(
      `Workspace file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { snapshot: migrateWorkspace(parsed), hash };
}
