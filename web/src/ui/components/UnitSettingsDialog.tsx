/**
 * 「单位设置」 dialog — the GLOBAL units layer and this WORKSPACE's manual constants
 * (units L1b §B2, decision 2026-11-19 §三/§五).
 *
 * Three things live on this one surface because they are the three layers the decision names,
 * and keeping them on one page is what makes their precedence visible instead of a rule the
 * user has to remember:
 *
 *   1. **Default tier (global)** — `globalSettings.unitPolicy`. The application default every
 *      workspace inherits; a workspace that does not override it follows this value live.
 *   2. **Pre-confirmations (global)** — `globalSettings.unitPreconfirm`, token → registered
 *      unit. The application-wide "what does an ambiguous spelling mean" answer; it is only a
 *      FALLBACK, so a workspace confirmation or a manual constant always wins.
 *   3. **Manual constants (this workspace)** — `store.unitConstants`, token → dimension/factor
 *      (`g → acceleration 9.80665`). Workspace-private, saved in the snapshot, never merged.
 *
 * Only settings are edited here: nothing recalculates, nothing converts and no number is
 * rewritten — choosing a tier changes which sentence a card shows, and a constant changes what
 * a header MEANS. That is the whole difference between this dialog and a conversion.
 *
 * Why the open state is local React state rather than store state: unlike the help dialog
 * (reachable from two unrelated places), the units dialog has exactly one opener — the top
 * bar's 「单位」 menu — and `MenuBar` is the component that owns menus. A store field would
 * have to be reset in `reset()` and `loadSnapshot()` for no benefit.
 *
 * Rendered through a portal for the same reason as `HelpDialog`: cards are transform-positioned
 * and clipped, so `position: fixed` inside one is positioned against the CARD.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { convertibleUnits } from '../../core/units.ts';
import {
  UNIT_POLICIES,
  setGlobalSettings,
  type UnitPolicy,
} from '../globalSettings.ts';
import { useGlobalSettings } from '../useGlobalSettings.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { MessageKey } from '../i18n.ts';

const POLICY_LABEL_KEYS: Record<UnitPolicy, MessageKey> = {
  strict: 'unit.settings.policy.strict',
  auto: 'unit.settings.policy.auto',
  free: 'unit.settings.policy.free',
};

interface UnitOption {
  /** Dimension the unit belongs to (used as the `<optgroup>` label). */
  dimension: string;
  units: string[];
}

/** Every registered scalar unit, grouped by dimension in registry order. Built once. */
const UNIT_OPTIONS: readonly UnitOption[] = (() => {
  const byDimension = new Map<string, string[]>();
  for (const candidate of convertibleUnits()) {
    if (candidate.dimension === null) continue;
    const list = byDimension.get(candidate.dimension) ?? [];
    if (!list.includes(candidate.unit)) list.push(candidate.unit);
    byDimension.set(candidate.dimension, list);
  }
  return [...byDimension.entries()].map(([dimension, units]) => ({ dimension, units }));
})();

const DIMENSIONS: readonly string[] = UNIT_OPTIONS.map((entry) => entry.dimension);

export interface UnitSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function UnitSettingsDialog({ open, onClose }: UnitSettingsDialogProps) {
  const { t } = useTranslator();
  const settings = useGlobalSettings();
  const unitConstants = useWorkspace((s) => s.unitConstants);
  const addUnitConstant = useWorkspace((s) => s.addUnitConstant);
  const removeUnitConstant = useWorkspace((s) => s.removeUnitConstant);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Local draft for the two "add one entry" forms: they hold text that is not a setting yet,
  // and writing an incomplete pair into the settings layer would make the resolver act on it.
  const [preToken, setPreToken] = useState('');
  const [preUnit, setPreUnit] = useState('');
  const [conToken, setConToken] = useState('');
  const [conDimension, setConDimension] = useState(DIMENSIONS[0] ?? '');
  const [conFactor, setConFactor] = useState('');
  const [formError, setFormError] = useState<'' | 'token' | 'unit' | 'constant'>('');

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const preEntries = useMemo(
    () => Object.entries(settings.unitPreconfirm).sort(([a], [b]) => a.localeCompare(b)),
    [settings.unitPreconfirm],
  );
  const constantEntries = useMemo(
    () => Object.entries(unitConstants).sort(([a], [b]) => a.localeCompare(b)),
    [unitConstants],
  );

  if (!open) return null;

  /** Change the global default tier. Persisted immediately; every open workspace follows. */
  const choosePolicy = (policy: UnitPolicy) => {
    if (policy === settings.unitPolicy) return;
    setGlobalSettings({ unitPolicy: policy });
  };

  /** Add (or replace) one global pre-confirmation. Both halves are required. */
  const addPreconfirm = () => {
    const token = preToken.trim();
    if (token === '') {
      setFormError('token');
      return;
    }
    if (preUnit === '') {
      setFormError('unit');
      return;
    }
    setFormError('');
    setGlobalSettings({ unitPreconfirm: { ...settings.unitPreconfirm, [token]: preUnit } });
    setPreToken('');
    setPreUnit('');
  };

  const removePreconfirm = (token: string) => {
    const next = { ...settings.unitPreconfirm };
    delete next[token];
    setGlobalSettings({ unitPreconfirm: next });
  };

  /** Add (or replace) one workspace manual constant. */
  const addConstant = () => {
    const token = conToken.trim();
    const factor = Number(conFactor);
    const accepted =
      token !== '' && conDimension !== '' && conFactor.trim() !== '' && Number.isFinite(factor) && factor > 0
        ? addUnitConstant(token, { dimension: conDimension, factor })
        : false;
    if (!accepted) {
      setFormError('constant');
      return;
    }
    setFormError('');
    setConToken('');
    setConFactor('');
  };

  return createPortal(
    <div
      className="help-dialog__backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="help-dialog unit-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unit-settings-title"
      >
        <header className="help-dialog__head">
          <h2 className="help-dialog__title" id="unit-settings-title">
            {t('unit.settings.title')}
          </h2>
          <button
            type="button"
            ref={closeRef}
            className="help-dialog__close card__control"
            aria-label={t('unit.settings.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="help-dialog__body unit-settings__body">
          {/* ── 1. global default tier ─────────────────────────────────────────── */}
          <section className="unit-settings__section" aria-label={t('unit.settings.policyTitle')}>
            <h3 className="help-dialog__heading">{t('unit.settings.policyTitle')}</h3>
            <p className="help-dialog__note">{t('unit.settings.policyHint')}</p>
            <div className="unit-settings__policies" role="radiogroup">
              {UNIT_POLICIES.map((policy) => (
                <label key={policy} className="unit-settings__policy">
                  <input
                    type="radio"
                    name="unit-policy"
                    value={policy}
                    checked={settings.unitPolicy === policy}
                    onChange={() => choosePolicy(policy)}
                  />
                  <span>{t(POLICY_LABEL_KEYS[policy])}</span>
                </label>
              ))}
            </div>
          </section>

          {/* ── 2. global pre-confirmations ────────────────────────────────────── */}
          <section
            className="unit-settings__section"
            aria-label={t('unit.settings.preconfirmTitle')}
          >
            <h3 className="help-dialog__heading">{t('unit.settings.preconfirmTitle')}</h3>
            <p className="help-dialog__note">{t('unit.settings.preconfirmHint')}</p>
            {preEntries.length === 0 ? (
              <p className="unit-settings__empty">{t('unit.settings.preconfirmEmpty')}</p>
            ) : (
              <ul className="unit-settings__list" data-role="preconfirm-list">
                {preEntries.map(([token, unit]) => (
                  <li key={token} className="unit-settings__entry">
                    <code className="unit-settings__token">{token}</code>
                    <span className="unit-settings__arrow">→</span>
                    <span className="unit-settings__value">{unit}</span>
                    <button
                      type="button"
                      className="unit-settings__remove card__control"
                      onClick={() => removePreconfirm(token)}
                    >
                      {t('unit.settings.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="unit-settings__form">
              <input
                type="text"
                className="unit-settings__input card__control"
                aria-label={t('unit.settings.preconfirmToken')}
                placeholder={t('unit.settings.preconfirmToken')}
                value={preToken}
                onChange={(event) => setPreToken(event.target.value)}
              />
              <select
                className="unit-settings__input card__control"
                aria-label={t('unit.settings.preconfirmUnit')}
                value={preUnit}
                onChange={(event) => setPreUnit(event.target.value)}
              >
                <option value="">{t('unit.settings.preconfirmUnit')}</option>
                {UNIT_OPTIONS.map((group) => (
                  <optgroup key={group.dimension} label={group.dimension}>
                    {group.units.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button type="button" className="card__control" onClick={addPreconfirm}>
                {t('unit.settings.add')}
              </button>
            </div>
            {formError === 'token' ? (
              <p className="unit-settings__error" role="alert">
                {t('unit.settings.tokenRequired')}
              </p>
            ) : null}
            {formError === 'unit' ? (
              <p className="unit-settings__error" role="alert">
                {t('unit.settings.unitRequired')}
              </p>
            ) : null}
          </section>

          {/* ── 3. workspace manual constants ──────────────────────────────────── */}
          <section className="unit-settings__section" aria-label={t('unit.constantsTitle')}>
            <h3 className="help-dialog__heading">{t('unit.constantsTitle')}</h3>
            <p className="help-dialog__note">{t('unit.constantsHint')}</p>
            {constantEntries.length === 0 ? (
              <p className="unit-settings__empty">{t('unit.constantsEmpty')}</p>
            ) : (
              <ul className="unit-settings__list" data-role="constant-list">
                {constantEntries.map(([token, constant]) => (
                  <li key={token} className="unit-settings__entry">
                    <code className="unit-settings__token">{token}</code>
                    <span className="unit-settings__arrow">→</span>
                    <span className="unit-settings__value">
                      {constant.dimension} · {constant.factor}
                    </span>
                    <button
                      type="button"
                      className="unit-settings__remove card__control"
                      aria-label={`${t('unit.constantsRemove')} ${token}`}
                      onClick={() => removeUnitConstant(token)}
                    >
                      {t('unit.settings.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="unit-settings__form">
              <input
                type="text"
                className="unit-settings__input card__control"
                aria-label={t('unit.constantsToken')}
                placeholder={t('unit.constantsToken')}
                value={conToken}
                onChange={(event) => setConToken(event.target.value)}
              />
              <input
                type="text"
                className="unit-settings__input card__control"
                aria-label={t('unit.constantsDimension')}
                placeholder={t('unit.constantsDimension')}
                list="unit-settings-dimensions"
                value={conDimension}
                onChange={(event) => setConDimension(event.target.value)}
              />
              {/* The registry's own dimension ids, offered as suggestions: a manual constant
                  should reuse them so it converts against registered units (N, kg·m/s²…). */}
              <datalist id="unit-settings-dimensions">
                {DIMENSIONS.map((dimension) => (
                  <option key={dimension} value={dimension} />
                ))}
              </datalist>
              <input
                type="text"
                className="unit-settings__input unit-settings__input--num card__control"
                aria-label={t('unit.constantsFactor')}
                placeholder={t('unit.constantsFactor')}
                value={conFactor}
                onChange={(event) => setConFactor(event.target.value)}
              />
              <button type="button" className="card__control" onClick={addConstant}>
                {t('unit.settings.add')}
              </button>
            </div>
            {formError === 'constant' ? (
              <p className="unit-settings__error" role="alert">
                {t('unit.constantsInvalid')}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}