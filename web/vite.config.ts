import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api/terminal': {
        target: 'http://localhost:8177',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8177',
        changeOrigin: true,
      },
    },
  },
});
