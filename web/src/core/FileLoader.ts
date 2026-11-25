/**
 * Loader abstraction — TypeScript port of `src/core/FileLoader.h`.
 *
 * The C++ original reads from a filesystem path; the web frontend reads from a
 * `File` handed over by a file picker or a drag-and-drop. Everything downstream of
 * `load()` is identical, so `MatrixData` stays the single source of truth.
 */
import { MatrixData } from './MatrixData.ts';
import { isMissingToken, isNumeric, parseNumeric } from './numeric.ts';

export interface FileLoader {
  /** Parse the file. Rejects with a human-readable message when unsupported/corrupt. */
  load(file: File): Promise<MatrixData>;
}

/** Extensions accepted by the file dialogs and the factory. */
export const SUPPORTED_EXTENSIONS = ['.txt', '.csv', '.tsv', '.dat', '.xlsx', '.xls'] as const;

/** `accept` string for `<input type="file">`. */
export const FILE_ACCEPT = SUPPORTED_EXTENSIONS.join(',');

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}

// ── Shared helpers used by every text-ish loader ──────────────────────────

/**
 * Build a `MatrixData` from a rectangular (possibly ragged) grid of raw cell strings.
 *
 * Mirrors the C++ TxtLoader: when the first row is not entirely numeric it is treated
 * as a header/annotation row rather than data.
 *
 * Numeric detection is driven by the token grammar (`isNumeric`), never by the parsed
 * value — otherwise a tolerant fallback like `0` would make `temp` look numeric and
 * silently swallow the header row into the data.
 *
 * A column that is entirely text is categorical: the numeric array carries stable codes
 * and the matrix keeps the label dictionary as display metadata. Mixing genuine text with
 * numbers in one column is refused instead of silently inventing zeroes or changing its
 * meaning — but a NaN spelling is a gap, not text, and never makes a column "mixed".
 */
export function gridToMatrix(grid: string[][]): MatrixData {
  let rows = grid.filter((r) => r.length > 0);
  if (rows.length === 0) throw new Error('Empty file: no data rows found.');

  let headerNames: string[] = [];
  const first = rows[0];
  // A first row of numbers with a gap is still a data row: the gap is not evidence of a
  // header. Demanding at least one real number keeps a stray line of delimiters (all cells
  // empty) from being read as data.
  const firstIsData =
    first.some((cell) => isNumeric(cell.trim())) &&
    first.every((cell) => isNumeric(cell.trim()) || isMissingToken(cell.trim()));
  if (!firstIsData) {
    headerNames = first.map((c) => c.trim());
    rows = rows.slice(1);
  }

  if (rows.length === 0) throw new Error('File contains a header row but no data.');

  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (colCount === 0) throw new Error('Empty file: no columns found.');

  const mat = new MatrixData();
  for (let c = 0; c < colCount; ++c) {
    const tokens = rows.map((row) => (c < row.length ? row[c].trim() : ''));
    let hasNumeric = false;
    let hasText = false;
    for (const token of tokens) {
      // A missing cell is neither evidence of numbers nor of text: a column of numbers with
      // a few `NaN` gaps is numeric, not mixed.
      if (isMissingToken(token)) continue;
      if (isNumeric(token)) hasNumeric = true;
      else hasText = true;
    }
    if (hasNumeric && hasText) {
      const label = headerNames[c] || `Pos.${c + 1}`;
      throw new Error(
        `Column "${label}" mixes numeric and text values; use blanks for missing values.`,
      );
    }

    const categories: string[] = [];
    const categoryCodes = new Map<string, number>();
    const data = tokens.map((token) => {
      if (isMissingToken(token)) return NaN;
      if (!hasText) return parseNumeric(token);
      let code = categoryCodes.get(token);
      if (code === undefined) {
        code = categories.length;
        categories.push(token);
        categoryCodes.set(token, code);
      }
      return code;
    });
    mat.appendColumn(`Pos.${c + 1}`, data);
    const index = mat.columnCount() - 1;
    if (c < headerNames.length && headerNames[c] !== '') {
      mat.setColumnAnnotation(index, headerNames[c]);
    }
    if (hasText) mat.setColumnCategories(index, categories);
  }
  return mat;
}

/** Decode a file as UTF-8, honouring a UTF-16 BOM when present. */
export async function decodeText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
  }
  // Strip a UTF-8 BOM so the first token does not carry it into header detection.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}
