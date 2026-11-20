/**
 * @vitest-environment jsdom
 *
 * The 「单位」 dialog: the GLOBAL units layer plus this workspace's manual constants
 * (units L1b §B2).
 *
 * What this suite locks is where each edit LANDS, because the three layers of the decision
 * look identical on screen and entirely different in persistence:
 *
 *   - the default tier and the pre-confirmations are GLOBAL — they go into
 *     `globalSettings`, survive a reload of the module cache (i.e. a new session), and a
 *     workspace snapshot never contains them;
 *   - a manual constant is WORKSPACE data — it lands in `store.unitConstants`, so it travels
 *     in the snapshot and disappears with a reset;
 *   - an incomplete entry is refused with a message instead of writing a half-definition the
 *     resolver would have to guess about.
 *
 * Opening note: the dialog is reached through the top bar's 「单位」 menu, so the menu is part
 * of what is tested (a dialog nobody can open is not a feature).
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GLOBAL_SETTINGS_KEY,
  getGlobalSettings,
  resetGlobalSettingsCache,
} from '../src/ui/globalSettings.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { MenuBar } from '../src/ui/components/MenuBar.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

let restoreFetch: (() => void) | null = null;

function stubBackend(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '{}',
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as Response) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountMenuBar(): Promise<HTMLElement> {
  const noop = () => {};
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <MenuBar
          onNewTable={noop}
          onOpenWorkspace={noop}
          onSaveWorkspace={noop}
          onExportCsv={noop}
          onExportAllCharts={noop}
          onTile={noop}
          onCascade={noop}
          onResetView={noop}
          onCloseAll={noop}
          canExport={false}
          hasCharts={false}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await settle();
  });
  return host;
}

/** Open the 「单位」 menu and click its one entry — the only way into the dialog. */
async function openUnitsDialog(): Promise<HTMLElement | null> {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('.menubar__trigger')].find(
    (button) => button.textContent === '单位',
  );
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger!.click();
  });
  const item = [...document.querySelectorAll<HTMLButtonElement>('.menubar__item')].find(
    (button) => button.textContent === '单位设置…',
  );
  expect(item).toBeDefined();
  await act(async () => {
    item!.click();
  });
  return document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="unit-settings-title"]');
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * The add buttons, in document order (two forms, one label each — file order is the contract
 * here: pre-confirmations first, manual constants second).
 */
function addButtons(): HTMLButtonElement[] {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent === '添加',
  );
  expect(found).toHaveLength(2);
  return found;
}

function buttonByText(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === label,
  );
  expect(found, `button "${label}"`).toBeDefined();
  return found!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await act(async () => {
    await settle();
  });
}

beforeEach(async () => {
  localStorage.clear();
  resetGlobalSettingsCache();
  restoreFetch = stubBackend();
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
  resetGlobalSettingsCache();
});

describe('opening the dialog', () => {
  it('the top bar has a 单位 menu that opens the settings dialog', async () => {
    await mountMenuBar();
    // Before opening, the dialog does not exist at all.
    expect(document.querySelector('[aria-labelledby="unit-settings-title"]')).toBeNull();
    const dialog = await openUnitsDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('单位设置');
  });

  it('Escape closes it', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('[aria-labelledby="unit-settings-title"]')).toBeNull();
  });
});

describe('the global default tier', () => {
  it('starts on strict and writes the chosen tier into the GLOBAL settings', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="unit-policy"]')];
    expect(radios.map((radio) => radio.value)).toEqual(['strict', 'auto', 'free']);
    expect(radios.find((radio) => radio.checked)?.value).toBe('strict');

    const auto = radios.find((radio) => radio.value === 'auto')!;
    await click(auto);

    expect(JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) ?? '{}').unitPolicy).toBe('auto');
    expect(auto.checked).toBe(true);
    // A workspace snapshot says nothing about the global tier.
    expect(store().toSnapshot()).not.toHaveProperty('unitPolicy');
  });

  it('persists across a session (a fresh module cache reads it back)', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    const free = [...document.querySelectorAll<HTMLInputElement>('input[name="unit-policy"]')].find(
      (radio) => radio.value === 'free',
    )!;
    await click(free);

    // A new session: the in-memory copy is dropped, storage is the only source left. (`act`
    // because the cache reset notifies subscribers, and the mounted dialog is one.)
    await act(async () => {
      resetGlobalSettingsCache();
    });
    expect(getGlobalSettings().unitPolicy).toBe('free');
  });
});

describe('global pre-confirmations', () => {
  it('adds a token → unit pair and persists it globally', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    const token = document.querySelector<HTMLInputElement>(
      'input[aria-label="token"]',
    )!;
    const unit = document.querySelector<HTMLSelectElement>('select[aria-label="单位"]')!;

    await act(async () => {
      type(token, 'g');
    });
    await act(async () => {
      choose(unit, 'g');
    });
    await click(buttonByText('添加'));

    const saved = JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) ?? '{}');
    expect(saved.unitPreconfirm).toEqual({ g: 'g' });
    // The list shows it…
    const list = document.querySelector('[data-role="preconfirm-list"]');
    expect(list?.textContent).toContain('g');
    // …and it is NOT workspace data.
    expect(store().toSnapshot().unitConfirmations).toEqual({});
  });

  it('refuses an entry with no unit and says why', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    const token = document.querySelector<HTMLInputElement>('input[aria-label="token"]')!;
    await act(async () => {
      type(token, 'ms');
    });
    await click(buttonByText('添加'));

    expect(document.querySelector('.unit-settings__error')?.textContent).toBe('请选择单位');
    expect(localStorage.getItem(GLOBAL_SETTINGS_KEY)).toBeNull();
  });

  it('refuses an entry with no token', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    await click(buttonByText('添加'));
    expect(document.querySelector('.unit-settings__error')?.textContent).toBe('请填写 token');
  });

  it('removes a pair', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    const token = document.querySelector<HTMLInputElement>('input[aria-label="token"]')!;
    const unit = document.querySelector<HTMLSelectElement>('select[aria-label="单位"]')!;
    await act(async () => {
      type(token, 'ms');
    });
    await act(async () => {
      choose(unit, 'ms');
    });
    await click(buttonByText('添加'));
    expect(JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) ?? '{}').unitPreconfirm).toEqual({
      ms: 'ms',
    });

    const list = document.querySelector<HTMLElement>('[data-role="preconfirm-list"]')!;
    await click(buttonByText('删除', list));
    expect(JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) ?? '{}').unitPreconfirm).toEqual({});
    expect(document.querySelector('[data-role="preconfirm-list"]')).toBeNull();
  });
});

describe('workspace manual constants', () => {
  it('adds a definition to the WORKSPACE layer (not to the global settings)', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    // The constants form is the second token field on the page.
    const all = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="token"]')];
    expect(all).toHaveLength(2);
    const constantToken = all[1];
    const dimension = document.querySelector<HTMLInputElement>(
      'input[aria-label="量纲"]',
    )!;
    const factor = document.querySelector<HTMLInputElement>(
      'input[aria-label="换算系数"]',
    )!;

    await act(async () => {
      type(constantToken, 'g');
    });
    await act(async () => {
      type(dimension, 'acceleration');
    });
    await act(async () => {
      type(factor, '9.80665');
    });
    await click(addButtons()[1]);

    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });
    // Workspace data: it is in the snapshot, and the global layer never heard of it.
    expect(store().toSnapshot().unitConstants).toEqual({
      g: { dimension: 'acceleration', factor: 9.80665 },
    });
    expect(localStorage.getItem(GLOBAL_SETTINGS_KEY)).toBeNull();
    expect(document.querySelector('[data-role="constant-list"]')?.textContent).toContain(
      'acceleration',
    );
  });

  it('a non-positive factor is refused with a message and writes nothing', async () => {
    await mountMenuBar();
    await openUnitsDialog();
    const all = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="token"]')];
    const factor = document.querySelector<HTMLInputElement>('input[aria-label="换算系数"]')!;
    await act(async () => {
      type(all[1], 'g');
    });
    await act(async () => {
      type(factor, '0');
    });
    await click(addButtons()[1]);

    expect(store().unitConstants).toEqual({});
    const errors = [...document.querySelectorAll('.unit-settings__error')].map(
      (node) => node.textContent,
    );
    expect(errors).toContain('量纲不能为空，系数必须是正数');
  });

  it('removes a definition from the workspace layer', async () => {
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    await mountMenuBar();
    await openUnitsDialog();
    const list = document.querySelector<HTMLElement>('[data-role="constant-list"]')!;
    await click(buttonByText('删除', list));
    expect(store().unitConstants).toEqual({});
  });
});