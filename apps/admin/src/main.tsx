import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/providers.tsx';
import { AppRoutes } from './app/routes.tsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html must contain #root');
}

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  </StrictMode>,
);
