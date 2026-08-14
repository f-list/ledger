import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // forward API calls to the Express server during development
      '/api': 'http://localhost:3000',
    },
  },
});
