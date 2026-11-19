import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './i18n';
import '@fontsource-variable/manrope';
import './index.css';
import { initTheme } from './lib/theme';
import { SessionProvider } from './state/session';

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, err) => count < 1 && !(err as { status?: number }).status, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
