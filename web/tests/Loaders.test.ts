/**
 * Loader behaviour: text/CSV parsing rules plus the off-main-thread dispatch added on
 * 2026-10-15 (fix F). The C++ original these were ported from was removed from this repo;
 * see docs/decisions/2026-10-15-qt-implementation-removed.md.
 *
 * Vitest runs in a Node environment, where the File / TextEncoder globals needed by
 * the loaders are available (Node >= 20). There is no Worker there, which is exactly the
 * fallback path these tests pin down.
 */
import { describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { createLoader, loadMatrixFile } from '../src/loaders/FileLoaderFactory.ts';
import { TxtLoader, splitWhitespaceDelimited } from '../src/loaders/TxtLoader.ts';
import { CsvLoader, parseCsv, sniffDelimiter } from '../src/loaders/CsvLoader.ts';
import { matrixToCsv } from '../src/ui/fileActions.ts';

function makeFile(name: string, content: string, type = 'text/plain'): File {
  return new File([content], name, { type });
}

describe('splitWhitespaceDelimited', () => {
  it('treats space, tab, comma and semicolon as interchangeable separators', () => {
    expect(splitWhitespaceDelimited('1 2\t3,4;5')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('collapses delimiter runs and drops empty tokens', () => {
    expect(splitWhitespaceDelimited('  1,,  2  ')).toEqual(['1', '2']);
  });

  it('returns nothing for a blank line', () => {
    expect(splitWhitespaceDelimited('   ')).toEqual([]);
  });
});

describe('TxtLoader', () => {
  it('loads a plain numeric matrix with Pos.N columns', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2 3\n4 5 6\n'));
    expect(mat.columnCount()).toBe(3);
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).posName).toBe('Pos.1');
    expect(mat.cell(1, 2)).toBe(6);
  });

  it('uses a non-numeric first row as column annotations, not as data', async () => {
    const mat = await new TxtLoader().load(
      makeFile('a.txt', 'temp pressure\n1.5 2.5\n3.5 4.5\n'),
    );
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).annotation).toBe('temp');
    expect(mat.column(1).annotation).toBe('pressure');
    expect(mat.columnLabel(0)).toBe('temp');
    expect(mat.cell(0, 0)).toBe(1.5);
  });

  it('keeps a numeric first row as data', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2\n3 4\n'));
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).annotation).toBe('');
  });

  it('skips blank lines and tolerates ragged rows', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2 3\n\n4 5\n'));
    expect(mat.columnCount()).toBe(3);
    expect(mat.rowCount()).toBe(2);
    // A missing trailing value surfaces as NaN rather than an invented zero.
    expect(mat.cell(1, 2)).toBeNaN();
  });

  it('parses scientific notation and signs', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1e-3 -2.5E+2 +7\n'));
    expect(mat.cell(0, 0)).toBeCloseTo(0.001, 12);
    expect(mat.cell(0, 1)).toBeCloseTo(-250, 12);
    expect(mat.cell(0, 2)).toBe(7);
  });

  it('handles CRLF line endings', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2\r\n3 4\r\n'));
    expect(mat.rowCount()).toBe(2);
    expect(mat.cell(1, 1)).toBe(4);
  });

  it('keeps text group columns as stable categorical codes and labels', async () => {
    const mat = await new TxtLoader().load(
      makeFile('a.txt', 'x group\n1 control\n2 treated\n3 control\n'),
    );

    expect(mat.column(1).categories).toEqual(['control', 'treated']);
    expect(mat.column(1).data).toEqual([0, 1, 0]);
    expect(mat.categoricalLabel(0, 1)).toBe('control');
    expect(mat.categoricalLabel(1, 1)).toBe('treated');
  });

  it('reads a NaN spelling as a gap, not as text', async () => {
    // What pandas/HDF5/instrument exports actually write for a missing sample: read
    // literally it is a text token, and it used to make the whole column "mixed".
    const mat = await new CsvLoader().load(
      makeFile('a.csv', 'x,y\n1,2.5\n2,NaN\n3,4.5\n4,nan\n5,NAN\n'),
    );

    expect(mat.columnCount()).toBe(2);
    expect(mat.column(1).categories).toBeUndefined();
    expect(mat.cell(0, 1)).toBe(2.5);
    expect(Number.isNaN(mat.cell(1, 1))).toBe(true);
    expect(mat.cell(2, 1)).toBe(4.5);
    // Every spelling of the gap, including the signed ones, lands as missing.
    expect(Number.isNaN(mat.cell(3, 1))).toBe(true);
    expect(Number.isNaN(mat.cell(4, 1))).toBe(true);
  });

  it('loads a column that is nothing but gaps', async () => {
    const mat = await new CsvLoader().load(makeFile('a.csv', 'x,y\n1,NaN\n2,nan\n'));

    expect(mat.columnCount()).toBe(2);
    expect(Number.isNaN(mat.cell(0, 1))).toBe(true);
    expect(Number.isNaN(mat.cell(1, 1))).toBe(true);
  });

  it.each(['NA', 'N/A', 'n/a', 'ND', '<LOD', '<LOQ', '-', '--', '—', 'nan'])(
    'reads %s as a gap inside a numeric column',
    async (marker) => {
      // The spellings instrument software and LIMS exports actually use for a missing sample.
      const mat = await new CsvLoader().load(
        makeFile('a.csv', `x,y\n1,2.5\n2,${marker}\n3,4.5\n`),
      );

      expect(mat.rowCount()).toBe(3);
      expect(mat.column(1).categories).toBeUndefined();
      expect(mat.cell(0, 1)).toBe(2.5);
      expect(Number.isNaN(mat.cell(1, 1))).toBe(true);
      expect(mat.cell(2, 1)).toBe(4.5);
    },
  );

  it('keeps a first row that contains a gap as data, not as a header', async () => {
    // `NA` in row one used to make the row look textual, so it was consumed as column titles
    // and the file silently lost its first measurement.
    const mat = await new CsvLoader().load(makeFile('a.csv', '1,NA\n2,5\n3,6\n'));

    expect(mat.rowCount()).toBe(3);
    expect(mat.column(0).annotation).toBe('');
    expect(mat.cell(0, 0)).toBe(1);
    expect(Number.isNaN(mat.cell(0, 1))).toBe(true);
    expect(mat.cell(2, 1)).toBe(6);
  });

  it('still refuses a numeric column that carries a genuine label', async () => {
    // The gap list is a list, not a licence to blank arbitrary text.
    await expect(
      new CsvLoader().load(makeFile('a.csv', 'x,y\n1,2.5\n2,NA\n3,control\n')),
    ).rejects.toThrow(/mixes numeric and text/);
  });

  it('rejects a mixed numeric and text column instead of silently coercing it', async () => {
    await expect(
      new CsvLoader().load(makeFile('a.csv', 'x,group\n1,0\n2,treatment\n')),
    ).rejects.toThrow(/mixes numeric and text/);
  });

  it('rejects an empty file', async () => {
    await expect(new TxtLoader().load(makeFile('a.txt', '\n\n'))).rejects.toThrow(/Empty file/);
  });

  it('rejects a header-only file', async () => {
    await expect(new TxtLoader().load(makeFile('a.txt', 'temp pressure\n'))).rejects.toThrow(
      /no data/,
    );
  });
});

describe('sniffDelimiter / parseCsv', () => {
  it('detects comma, semicolon and tab separated files', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('keeps a quoted delimiter inside one field', () => {
    const grid = parseCsv('a,"b,c",d\n1,2,3', ',');
    expect(grid[0]).toEqual(['a', 'b,c', 'd']);
    expect(grid[1]).toEqual(['1', '2', '3']);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",2', ',')[0]).toEqual(['say "hi"', '2']);
  });

  it('supports embedded newlines inside quotes', () => {
    const grid = parseCsv('"line1\nline2",b', ',');
    expect(grid[0]).toEqual(['line1\nline2', 'b']);
  });

  it('drops a trailing blank line', () => {
    expect(parseCsv('1,2\n', ',')).toEqual([['1', '2']]);
  });
});

describe('CsvLoader', () => {
  it('loads a comma separated file with header annotations', async () => {
    const mat = await new CsvLoader().load(makeFile('a.csv', 'x,y\n1,2\n3,4\n'));
    expect(mat.columnCount()).toBe(2);
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).annotation).toBe('x');
    expect(mat.cell(1, 1)).toBe(4);
  });

  it('loads a semicolon separated file', async () => {
    const mat = await new CsvLoader().load(makeFile('a.csv', '1;2;3\n4;5;6\n'));
    expect(mat.columnCount()).toBe(3);
    expect(mat.cell(1, 2)).toBe(6);
  });
});

describe('createLoader', () => {
  it('maps each supported extension to a loader', () => {
    expect(createLoader('a.txt')).toBeInstanceOf(TxtLoader);
    expect(createLoader('A.TXT')).toBeInstanceOf(TxtLoader);
    expect(createLoader('a.dat')).toBeInstanceOf(TxtLoader);
    expect(createLoader('a.csv')).toBeInstanceOf(CsvLoader);
    expect(createLoader('a.tsv')).toBeInstanceOf(CsvLoader);
    expect(createLoader('a.xlsx')).not.toBeNull();
  });

  it('rejects unsupported extensions', () => {
    expect(createLoader('a.parquet')).toBeNull();
    expect(createLoader('noextension')).toBeNull();
  });

  it('explains an unsupported extension through loadMatrixFile', async () => {
    await expect(loadMatrixFile(makeFile('a.parquet', 'x'))).rejects.toThrow(/Unsupported/);
  });
});

describe('matrixToCsv', () => {
  it('emits a header row and full-precision values', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [1.5, 2]);
    mat.setColumnAnnotation(0, '温度');
    mat.appendColumn('Pos.2', [3, 4]);

    const csv = matrixToCsv(mat);
    // A UTF-8 BOM so Excel reads non-ASCII headers as UTF-8 instead of the system code page.
    expect(csv.startsWith('\ufeff')).toBe(true);
    const lines = csv.slice(1).split('\n');
    expect(lines[0]).toBe('温度,Pos.2');
    expect(lines[1]).toBe('1.5,3');
    expect(lines[2]).toBe('2,4');
  });

  it('quotes fields that contain separators or quotes', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [1]);
    mat.setColumnAnnotation(0, 'a,b "c"');
    expect(matrixToCsv(mat).slice(1).split('\n')[0]).toBe('"a,b ""c"""');
  });

  it('writes NaN as an empty field', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [1, NaN]);
    expect(matrixToCsv(mat).split('\n')[2]).toBe('');
  });

  it('exports categorical labels instead of their internal numeric codes', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [0, 1, 0]);
    mat.setColumnCategories(0, ['control, A', 'treated']);
    expect(matrixToCsv(mat).slice(1).split('\n')).toEqual([
      'Pos.1',
      '"control, A"',
      'treated',
      '"control, A"',
    ]);
  });
});

describe('loadMatrixFile worker dispatch (fix F)', () => {
  it('parses inline when no Worker is available', async () => {
    // Node/vitest has no Worker global, so the client must fall through to the loaders.
    expect(typeof Worker).toBe('undefined');
    const mat = await loadMatrixFile(makeFile('a.txt', '1 2\n3 4\n'));
    expect(mat.rowCount()).toBe(2);
    expect(mat.cell(1, 1)).toBe(4);
  });

  it('still rejects an unsupported extension without touching a worker', async () => {
    await expect(loadMatrixFile(makeFile('a.parquet', 'x'))).rejects.toThrow(/Unsupported/);
  });

  it('payloadToMatrix round-trips the worker wire format', async () => {
    const { payloadToMatrix } = await import('../src/loaders/parseWorker.ts');
    const matrix = new MatrixData();
    matrix.appendColumn('Pos.1', [1.5, NaN, 3]);
    matrix.setColumnAnnotation(0, 'temp °C');
    matrix.appendColumn('Pos.2', [4, 5, 6]);
    matrix.setColumnCategories(1, ['a', 'b', 'c']);

    const columns = matrix.columns().map((col) => ({
      posName: col.posName,
      annotation: col.annotation,
      data: col.data,
      categories: col.categories,
    }));
    const restored = payloadToMatrix(columns);

    expect(restored.columnCount()).toBe(2);
    expect(restored.columnLabel(0)).toBe('temp °C');
    expect(restored.cell(0, 0)).toBe(1.5);
    expect(restored.cell(1, 0)).toBeNaN();
    expect(restored.column(1).categories).toEqual(['a', 'b', 'c']);
    // A copy, not an alias — the worker's arrays must never be mutated in place.
    columns[0].data[0] = 99;
    expect(restored.cell(0, 0)).toBe(1.5);
  });
});
