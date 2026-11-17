/**
 * The blocking gate: when a card cannot advance because of an environment or structure
 * problem, automatic propagation stops and this dialog says why.
 *
 * The dialog is informational, not a decision: there is no "continue anyway" button, because
 * continuing past a block is how a wrong number gets published. The latch releases by itself
 * when the cause disappears; this component only alerts (in-page, sound, desktop, title) and
 * lets the user acknowledge what is on screen. A compute error is NOT a blocker — it stays a
 * red card with its own diagnostics, otherwise every typo would freeze the workspace.
 */
import { useEffect, useRef, useState } from 'react';

import type { MessageKey } from '../i18n.ts';
import { useTranslator, useWorkspace, type Blocker } from '../workspaceStore.ts';
import {
  desktopAlertPermission,
  flashTitle,
  playAlertSound,
  requestDesktopAlertPermission,
  showDesktopAlert,
  stopTitleFlash,
} from '../alerts.ts';

function blockerKey(blocker: Blocker): string {
  return `${blocker.kind}:${blocker.cardId ?? '-'}`;
}

export function BlockingGate() {
  const { t } = useTranslator();
  const blockers = useWorkspace((state) => state.blockers);
  const [open, setOpen] = useState(false);
  /** Blocker identities already alerted for this latch; cleared when the gate releases. */
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (blockers.length === 0) {
      seen.current.clear();
      stopTitleFlash();
      return;
    }
    const unseen = blockers.filter((blocker) => !seen.current.has(blockerKey(blocker)));
    if (unseen.length === 0) return;
    for (const blocker of unseen) seen.current.add(blockerKey(blocker));
    setOpen(true);
    playAlertSound();
    const title = t('blocker.title');
    flashTitle(title);
    showDesktopAlert(
      title,
      unseen.map((blocker) => t(`blocker.${blocker.kind}` as MessageKey)).join(' · '),
    );
  }, [blockers, t]);

  if (blockers.length === 0 || !open) return null;

  return (
    <div
      className="blocking-gate"
      role="dialog"
      aria-modal="true"
      aria-label={t('blocker.title')}
      data-blockers={blockers.length}
    >
      <div className="blocking-gate__panel">
        <h2 className="blocking-gate__title">⚠ {t('blocker.title')}</h2>
        <p className="blocking-gate__hint">{t('blocker.hint')}</p>
        <ul className="blocking-gate__list">
          {blockers.map((blocker) => (
            <li className="blocking-gate__item" key={blockerKey(blocker)}>
              <strong>{t(`blocker.${blocker.kind}` as MessageKey)}</strong>
              {blocker.cardId !== undefined ? (
                <span> · {t('blocker.card', { n: blocker.cardId })}</span>
              ) : null}
              {blocker.detail ? (
                <span className="blocking-gate__detail"> ({blocker.detail})</span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="blocking-gate__actions">
          {desktopAlertPermission() === 'default' ? (
            <button
              type="button"
              className="card__control"
              onClick={() => requestDesktopAlertPermission()}
            >
              {t('blocker.enableNotifications')}
            </button>
          ) : null}
          <button
            type="button"
            className="card__control blocking-gate__ack"
            onClick={() => setOpen(false)}
          >
            {t('blocker.ack')}
          </button>
        </div>
        <p className="blocking-gate__note">{t('blocker.autoRelease')}</p>
      </div>
    </div>
  );
}
