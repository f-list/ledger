import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the built app works mounted at any subpath
  // (production serves it under /_ledger/ behind nginx).
  base: './',
  server: {
    proxy: {
      // forward API calls to the Express server during development
      '/api': 'http://localhost:3000',
    },
  },
});
