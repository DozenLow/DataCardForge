/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import App from '../src/ui/App.tsx';
import { isMatrixCard } from '../src/ui/types.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';

const store = useWorkspace.getState;
const backendLifecycle = {
  connectBackend: store().connectBackend,
  startBackendEventLoop: store().startBackendEventLoop,
  stopBackendEventLoop: store().stopBackendEventLoop,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  store().reset();
  useWorkspace.setState({
    locale: 'en',
    connectBackend: async () => {},
    startBackendEventLoop: () => {},
    stopBackendEventLoop: () => {},
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  useWorkspace.setState(backendLifecycle);
  store().reset();
  vi.unstubAllGlobals();
});

function find<E extends Element>(selector: string) {
  const node = host.querySelector<E>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}

// jsdom File lacks arrayBuffer(); the real loaders still decode and parse these bytes.
let nextFileStamp = 1;
function dataFile(name: string, text: string, lastModified = nextFileStamp++) {
  const encoded = new TextEncoder().encode(text);
  const file = new File([encoded], name, { lastModified });
  const read = vi.fn(async () => encoded.buffer);
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  return { file, read, bytes: encoded.buffer };
}

function deferredFile(name: string, text: string) {
  const { file, read, bytes } = dataFile(name, text);
  let finish!: (value: ArrayBuffer) => void;
  read.mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
  return { file, read, finish: () => act(async () => finish(bytes)) };
}

async function drop(target: Element, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } });
  await act(async () => target.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}

async function seedCard() {
  await act(async () => {
    store().addMatrixCard(['first.txt', 'second.txt'].map((name, i) => {
      const matrix = new MatrixData();
      matrix.appendColumn('Pos.1', [10 + i]);
      return { name, matrix };
    }));
  });
}

function readCards() {
  return store().cards.filter(isMatrixCard).map((card) => ({
    active: card.activeSource,
    files: card.sources.map(({ name, matrixId }) => [name, store().matrices.get(matrixId)?.cell(0, 0)]),
  }));
}

async function openReplacementPicker() {
  await act(async () => find<HTMLButtonElement>('.matrix-card__replace').click());
  const picker = document.querySelector<HTMLInputElement>('input[type=file]');
  if (!picker) throw new Error('Replace button did not open a file picker');
  expect(picker.multiple).toBe(false);
  return picker;
}

async function chooseFile(picker: HTMLInputElement, file: File) {
  Object.defineProperty(picker, 'files', { value: [file] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
}

async function selectSecondFile() {
  const selector = find<HTMLSelectElement>('.matrix-card__selector');
  await act(async () => {
    selector.value = '1';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(readCards()[0].active).toBe(1);
}

function expectLoadError() {
  expect(find('.statusbar__message').textContent).toContain('Cannot load "empty.txt": Empty file');
  expect(find('.statusbar__error').textContent).toBe('!');
}

const originalFiles = [['first.txt', 10], ['second.txt', 11]];

describe('App file import and replacement', () => {
  it('keeps valid files before and after an invalid one dropped on the canvas, and reports the error', async () => {
    await drop(find('.canvas'), [
      dataFile('valid-first.txt', '12\n', 1000).file,
      dataFile('empty.txt', '\n').file,
      dataFile('valid-last.txt', '34\n', 1000).file,
    ]);

    expect(store().cards).toHaveLength(1);
    expect(readCards()).toEqual([{ active: 0, files: [['valid-first.txt', 12], ['valid-last.txt', 34]] }]);
    const selector = find<HTMLSelectElement>('.card--matrix .matrix-card__selector');
    expect(Array.from(selector.options, (option) => option.text)).toEqual(['valid-first.txt', 'valid-last.txt']);
    expectLoadError();
  });

  it('rejects a mixed batch dropped on a card without changing its sources, data or active slot', async () => {
    await seedCard();
    await selectSecondFile();
    const matrices = store().matrices;
    await drop(find('.card--matrix .matrix-card__bar'), [
      dataFile('valid.txt', '12\n').file,
      dataFile('empty.txt', '\n').file,
    ]);

    expect(store().cards).toHaveLength(1);
    expect(store().matrices).toBe(matrices);
    expect(readCards()).toEqual([{ active: 1, files: originalFiles }]);
    expectLoadError();
  });

  it('replaces only the shown slot when the picker and parse finish on that slot', async () => {
    await seedCard();
    await selectSecondFile();
    await chooseFile(await openReplacementPicker(), dataFile('replacement.txt', '99\n').file);

    expect(readCards()).toEqual([{ active: 1, files: [['first.txt', 10], ['replacement.txt', 99]] }]);
  });

  it('does not replace the new active slot when the user switches during parsing', async () => {
    await seedCard();
    const pending = deferredFile('replacement.txt', '99\n');
    await chooseFile(await openReplacementPicker(), pending.file);
    expect(pending.read).toHaveBeenCalledOnce();
    expect(readCards()).toEqual([{ active: 0, files: originalFiles }]);

    await selectSecondFile();
    await pending.finish();

    expect(readCards()).toEqual([{ active: 1, files: originalFiles }]);
    expect(find('.statusbar__message').textContent).not.toContain('Replaced');
  });

  it('does not retarget a replacement when the slot changes while the picker is pending', async () => {
    await seedCard();
    const picker = await openReplacementPicker();
    await selectSecondFile();
    await chooseFile(picker, dataFile('replacement.txt', '99\n').file);

    expect(readCards()).toEqual([{ active: 1, files: originalFiles }]);
  });

  it('does not overwrite a newer replacement of the same slot when an older parse finishes', async () => {
    await seedCard();
    const pending = deferredFile('older.txt', '99\n');
    await chooseFile(await openReplacementPicker(), pending.file);
    expect(pending.read).toHaveBeenCalledOnce();

    await chooseFile(await openReplacementPicker(), dataFile('newer.txt', '42\n').file);
    expect(readCards()).toEqual([{ active: 0, files: [['newer.txt', 42], ['second.txt', 11]] }]);
    await pending.finish();

    expect(readCards()).toEqual([{ active: 0, files: [['newer.txt', 42], ['second.txt', 11]] }]);
  });
});
