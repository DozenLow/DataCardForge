/**
 * @vitest-environment jsdom
 *
 * The 「继承」 provenance label of a formula output unit (units L2a).
 *
 * What this suite locks is the ONE thing a user can see: a unit the card INFERRED from the
 * expression must be labelled differently from a unit the user ASSERTED, because both reach
 * the header as an ordinary `recognized` unit. `columnUnitResolutions` cannot tell them
 * apart — only the two memories can — so the label is what keeps the distinction visible.
 *
 * The derivation itself (whitelist, precedence, recompute, session scoping) is covered at the
 * core and store layers (`unitInheritance.test.ts`, `unitsL2aStore.test.ts`); this file feeds
 * `inheritedUnits` / `unitConfirmations` directly, exactly as a completed pull would.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { unitSignature } from '../src/core/units.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
import { FormulaCard } from '../src/ui/components/FormulaCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

let nextMatrixId = 900;

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

/** A formula card as the store would hold it right after a pull, with its result table. */
function formulaCard(id: number): FunctionCardModel {
  return {
    id,
    kind: 'formula',
    title: 'formula',
    z: 1,
    createdAt: 0,
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    inputs: [],
    signatureId: 'builtin:formula',
    params: { formulas: [{ name: 'Col1', expression: 'pressure_kpa * 2' }] },
    outputs: [{ outputId: 'result', resultMatrixId: 1, label: 'result' }],
    node: { nodeId: 1, state: 'done' },
    displayMatrixId: id,
    result: { totalRows: 3, shownRows: 3, complete: true, truncated: false },
  } as unknown as FunctionCardModel;
}

function resultTable(annotation: string): MatrixData {
  const mat = new MatrixData();
  mat.appendColumn('Pos.1', [2, 4, 6]);
  mat.setColumnAnnotation(0, annotation);
  return mat;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let restoreFetch: (() => void) | null = null;

beforeEach(async () => {
  localStorage.clear();
  const originalFetch = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
  globalThis.fetch = (async () => json({ matrixId: nextMatrixId++ })) as unknown as typeof fetch;
  store().reset();
  store().setLocale('zh');
  await act(async () => {
    await settle();
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  restoreFetch?.();
  restoreFetch = null;
  localStorage.clear();
});

/** Mount one formula card whose result table has `annotation`, rendered through the store. */
async function mountWith(annotation: string): Promise<{ host: HTMLElement; cardId: number }> {
  const cardId = 41;
  const table = resultTable(annotation);
  useWorkspace.setState({
    cards: [formulaCard(cardId)],
    matrices: new Map([[cardId, table]]),
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const card = store().cards[0] as FunctionCardModel;
  await act(async () => {
    root.render(
      <StrictMode>
        <FormulaCard
          card={card}
          resultMatrix={table}
          sourceColumnNames={[]}
          inputs={[]}
          onRenameOutputColumn={() => {}}
          onSetColumnContract={() => {}}
          onOpenChart={() => null}
          onOpenFunction={() => {}}
          active
          closeBlocked={false}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onActivate={() => {}}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await settle();
  });
  return { host, cardId };
}

/** The provenance labels drawn in the result header (one per unit chip). */
function provenanceLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.vtable__unit-provenance')].map(
    (element) => element.textContent ?? '',
  );
}

function resultChips(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.vtable__unit-label')].map(
    (element) => element.textContent ?? '',
  );
}

const SIGNATURE = unitSignature(['Col1']);

describe('the 「继承」 label of a formula output unit', () => {
  it('an inherited unit draws the unit plus 继承', async () => {
    useWorkspace.setState({ inheritedUnits: { [SIGNATURE]: { 0: 'kPa' } } });
    const { host } = await mountWith('Col1');
    expect(resultChips(host)).toEqual(['kPa']);
    expect(provenanceLabels(host)).toEqual(['继承']);
  });

  it('a user assertion is labelled 断言 instead', async () => {
    useWorkspace.setState({
      inheritedUnits: { [SIGNATURE]: { 0: 'kPa' } },
      unitConfirmations: { [SIGNATURE]: { 0: 'mbar' } },
    });
    const { host } = await mountWith('Col1');
    // The user's answer decides the unit, and the label says so.
    expect(resultChips(host)).toEqual(['mbar']);
    expect(provenanceLabels(host)).toEqual(['断言']);
  });

  it('a header-delivered unit with no derivation carries no provenance label', async () => {
    const { host } = await mountWith('Col1 pressure_kpa');
    // The header itself names the unit, so nothing was derived and nothing is claimed.
    expect(resultChips(host)).toEqual(['kPa']);
    expect(provenanceLabels(host)).toEqual([]);
  });

  it('the English locale says "inherited"', async () => {
    store().setLocale('en');
    useWorkspace.setState({ inheritedUnits: { [SIGNATURE]: { 0: 'kPa' } } });
    const { host } = await mountWith('Col1');
    expect(provenanceLabels(host)).toEqual(['inherited']);
  });
});