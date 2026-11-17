/**
 * Workspace-trust panel: the first-run persistence question, the untrusted scripts, and the
 * bulk confirmation — all in one banner above the canvas.
 *
 * It never decides anything by itself: the store owns the record, the page only asks. The bulk
 * "trust the rest" appears only after the user has confirmed three scripts one by one, so the
 * shortcut is a reward for having actually looked, not a way to skip looking.
 */
import { isScriptCard } from '../types.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { scriptTrusted } from '../workspaceTrust.ts';

export function TrustPanel() {
  const { t } = useTranslator();
  const trust = useWorkspace((state) => state.trust);
  const cards = useWorkspace((state) => state.cards);
  const setPersistence = useWorkspace((state) => state.setTrustPersistence);
  const confirmOne = useWorkspace((state) => state.confirmTrustedScript);
  const confirmAll = useWorkspace((state) => state.confirmAllTrustedScripts);
  const revoke = useWorkspace((state) => state.revokeWorkspaceTrust);

  // A workspace with no file has nothing to trust, and one without scripts has nothing to ask.
  if (trust.hash === null) return null;
  const scripts = cards.filter((card) => isScriptCard(card));
  if (scripts.length === 0) return null;

  const untrusted = scripts.filter((card) => !scriptTrusted(trust, card.id));
  const needsDecision = trust.persistence === 'undecided';
  const sessionOnly = trust.persistence === 'session' || trust.persistence === 'unavailable';
  const backendDown = trust.error === 'backendUnavailable';
  if (
    !needsDecision &&
    untrusted.length === 0 &&
    !trust.envChanged &&
    !sessionOnly &&
    !backendDown
  ) {
    return null;
  }

  return (
    <div
      className="backend-banner trust-panel"
      role="status"
      data-banner="workspace-trust"
      // A notice, not a failure: keep the shared banner layout, drop its danger colours.
      style={{
        flexShrink: 0,
        background: 'var(--surface-alt)',
        borderBottomColor: 'var(--border-strong)',
      }}
    >
      <strong className="trust-panel__title">{t('trust.panel')}</strong>
      {needsDecision ? (
        <>
          <span>{t('trust.decision')}</span>
          <span className="trust-panel__hint">{t('trust.decisionHint')}</span>
          <button type="button" className="card__control" onClick={() => setPersistence(true)}>
            {t('trust.keep')}
          </button>
          <button type="button" className="card__control" onClick={() => setPersistence(false)}>
            {t('trust.session')}
          </button>
        </>
      ) : null}
      {backendDown ? <span>{t('trust.backendUnavailable')}</span> : null}
      {trust.envChanged ? <span>{t('trust.envChanged')}</span> : null}
      {sessionOnly && !needsDecision ? (
        <span>{t(trust.persistence === 'unavailable' ? 'trust.unavailable' : 'trust.sessionOnly')}</span>
      ) : null}
      {untrusted.length > 0 ? (
        <>
          <span>{t('trust.untrusted', { n: untrusted.length })}</span>
          <ul className="trust-panel__list">
            {untrusted.map((card) => (
              <li className="trust-panel__item" key={card.id}>
                <span>{card.title.trim() || `#${card.id}`}</span>
                <button type="button" className="card__control" onClick={() => confirmOne(card.id)}>
                  {t('trust.confirmOne')}
                </button>
              </li>
            ))}
          </ul>
          {trust.confirmed.length >= 3 && untrusted.length > 1 ? (
            <button
              type="button"
              className="card__control"
              title={t('trust.confirmAllHint')}
              onClick={confirmAll}
            >
              {t('trust.confirmAll')}
            </button>
          ) : null}
        </>
      ) : null}
      {trust.persistence === 'persistent' ? (
        <button type="button" className="card__control" onClick={revoke}>
          {t('trust.revoke')}
        </button>
      ) : null}
    </div>
  );
}
