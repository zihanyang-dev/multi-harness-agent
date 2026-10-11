import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: process.env.WEB_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure(proxy) {
          // Forward truncation too: an open downstream SSE would prevent native reconnect.
          proxy.on('proxyRes', (upstream, _request, downstream) => {
            upstream.once('aborted', () => downstream.destroy());
          });
        },
      },
    },
  },
});
