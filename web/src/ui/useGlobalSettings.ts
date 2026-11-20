/**
 * React binding for the application-level settings layer (units L1b §B2).
 *
 * `globalSettings.ts` is a tiny external store (get + subscribe + patch) written exactly for
 * `useSyncExternalStore`, but until the 「单位」 dialog existed no component needed to RE-RENDER
 * on a settings change: the store read them at call time and the drift hint only ran on an
 * action. The units context does need the re-render — a component that derives column units
 * must recompute when the global pre-confirmations change, otherwise editing the dialog would
 * leave every header chip showing the previous answer until something else moved.
 *
 * The subscription returns the live object (never a fresh copy per call), so React's snapshot
 * comparison is stable and the component re-renders only on an actual `setGlobalSettings`.
 */
import { useSyncExternalStore } from 'react';

import { getGlobalSettings, subscribeGlobalSettings } from './globalSettings.ts';

export function useGlobalSettings() {
  return useSyncExternalStore(subscribeGlobalSettings, getGlobalSettings, getGlobalSettings);
}
