import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    // Optional standalone hot-reload server. The normal `npm run dev` uses
    // the single Express listener on 5173 and a non-listening Vite build watch.
    port: 5174,
    proxy: {
      '/api/terminal': {
        target: 'http://localhost:5173',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      },
    },
  },
});
