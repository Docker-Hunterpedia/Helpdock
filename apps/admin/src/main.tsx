import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/providers.tsx';
import { csatTokenFromPath, unsubscribeTokenFromPath } from './app/route-paths.js';
import { AppRoutes } from './app/routes.tsx';
import { CsatApp } from './screens/csat/csat-app.tsx';
import { UnsubscribeApp } from './screens/unsubscribe/unsubscribe-app.tsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html must contain #root');
}

// M1-12: a customer following a rating link gets the rating page alone, never
// the staff app around it (`screens/csat/csat-app.tsx` says why).
const csatToken = csatTokenFromPath(window.location.pathname);
// M14-11: the same for the link in a notification email's footer.
const unsubscribeToken = unsubscribeTokenFromPath(window.location.pathname);

createRoot(container).render(
  <StrictMode>
    {unsubscribeToken !== null ? (
      <UnsubscribeApp token={unsubscribeToken} search={window.location.search} />
    ) : csatToken === null ? (
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    ) : (
      <CsatApp token={csatToken} search={window.location.search} />
    )}
  </StrictMode>,
);
