import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Hashed chunk names never collide, so old builds may stay on disk: a tab
    // open across a rebuild (watch mode or a deploy) can still fetch the
    // chunks its html references instead of hitting a 404 mid-session.
    emptyOutDir: false,
  },
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
