import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies the API base to the orchestrator/scoring host. The host is not in
// source: set DASHBOARD_PROXY_TARGET (default localhost:8080). The path is kept as-is.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE || '/api';
  const target = env.DASHBOARD_PROXY_TARGET || 'http://localhost:8080';
  return {
    plugins: [react()],
    server: {
      proxy: apiBase.startsWith('/') ? { [apiBase]: { target, changeOrigin: true } } : undefined,
    },
  };
});
