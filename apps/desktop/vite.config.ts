import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(`./ui/${name}`, import.meta.url));

// The window's UI. Tauri loads the dev server in `pnpm dev` (tauri.conf.json devUrl) and dist/ in a build. Two pages:
// the main window (index.html) and the panel spike's overlay (spike.html, one window per display).
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./ui/src', import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: { input: { main: page('index.html'), spike: page('spike.html') } },
  },
});
