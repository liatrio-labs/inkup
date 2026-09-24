import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { mountPageOverlay } from '@/page-overlay/mount';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// This page can be reviewed too: a Session bound to its tab draws on it (feedback batch 1, U5).
mountPageOverlay();
