/**
 * Global banners of the workspace environment lock.
 *
 * Two notices live here, and both are *information about the file that was loaded* — never
 * an action the app takes on its own:
 *
 *   1. **Environment mismatch.** The workspace records the toolchain its scripts were
 *      validated against. When that block disagrees with this build's pinned constants the
 *      banner says which two versions are in play. It does NOT migrate the block, does not
 *      rewrite the save file and does not run anything: the button only closes the banner
 *      («以当前环境重算»), leaving every run to the user.
 *   2. **"This workspace contains N user scripts, none auto-run."** One sentence per load,
 *      so opening somebody else's workspace can never look like it started their code.
 *
 * Rendered next to the backend banner in `App` on purpose: it uses the same global-banner
 * markup (`.backend-banner`) and the same status-bar button class, because this is the
 * existing "application-level message" surface — the environment stamp belongs to the
 * workspace, not to any one card, so it must not be re-invented per card.
 */
import { PINNED_WORKSPACE_ENV } from '../types.ts';
import { useEnvMismatch, useTranslator, useWorkspace } from '../workspaceStore.ts';

export function WorkspaceEnvBanner() {
  const { t } = useTranslator();
  const mismatch = useEnvMismatch();
  const workspaceEnv = useWorkspace((state) => state.workspaceEnv);
  const acknowledge = useWorkspace((state) => state.acknowledgeEnvMismatch);
  const scriptNotice = useWorkspace((state) => state.scriptNotice);
  const dismissScriptNotice = useWorkspace((state) => state.dismissScriptNotice);

  return (
    <>
      {mismatch ? (
        <div
          className="backend-banner"
          role="alert"
          data-banner="env-mismatch"
          // Never let the canvas squeeze a two-line explanation into an ellipsis.
          style={{ flexShrink: 0 }}
        >
          <span>
            {t('env.mismatch', {
              workspace: workspaceEnv.python,
              local: PINNED_WORKSPACE_ENV.python,
            })}
          </span>
          <button
            type="button"
            className="card__control"
            // The tooltip carries the explanation: the label alone reads like an action.
            title={t('env.mismatchHint')}
            onClick={() => acknowledge()}
          >
            {t('env.recompute')}
          </button>
        </div>
      ) : null}
      {scriptNotice !== null ? (
        <div
          className="backend-banner"
          role="status"
          data-banner="script-notice"
          // A notice, not a failure: keep the banner's layout, drop its danger colours.
          // Inline rather than a new stylesheet rule, so the shared banner stays the only
          // global-banner surface in `styles.css`.
          style={{
            flexShrink: 0,
            background: 'var(--surface-alt)',
            color: 'var(--text)',
            borderBottomColor: 'var(--border-strong)',
          }}
        >
          <span>{t('script.notice', { n: scriptNotice })}</span>
          <button
            type="button"
            className="card__control"
            onClick={() => dismissScriptNotice()}
          >
            {t('env.dismiss')}
          </button>
        </div>
      ) : null}
    </>
  );
}