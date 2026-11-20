import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './ui/App.tsx';
import { installNativeMenuSuppression } from './ui/suppressNativeMenu.ts';
import './styles.css';

// The workbench owns right-click (card birth, and the wire gesture from task G3 on), so the
// browser's own context menu is cancelled application-wide before the first render. The
// install is idempotent, and the self-rendered menus keep working because the listener only
// cancels the default action — see `suppressNativeMenu.ts` for the two invariants.
installNativeMenuSuppression();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
