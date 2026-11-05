import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'node:path';
import { validateOrigin } from './src/api/client.js';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const origin = validateOrigin(env.VITE_API_ORIGIN || '');
  if (mode === 'production' && origin && !origin.startsWith('https://'))
    throw new Error('Production API origin requires HTTPS');
  const target = new URL(env.DEV_API_TARGET || 'http://127.0.0.1:4000');
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new Error('Development API target must be a local HTTP(S) server');
  const apiSource = origin ? ` ${origin}` : '';
  const socketSource = origin ? origin.replace(/^http/, 'ws') : 'wss://localhost:4173';
  const productionCsp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:${apiSource}; connect-src 'self'${apiSource} ${socketSource}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  const headers = {
    'Content-Security-Policy': productionCsp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
  const proxy = {
    '/api': { target: target.origin, changeOrigin: false },
    '/socket.io': { target: target.origin, ws: true, changeOrigin: false },
  };
  return {
    plugins: env.DEV_HTTPS === 'false' ? [] : [basicSsl()],
    esbuild: { jsx: 'automatic' },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy,
      fs: {
        allow: [process.cwd(), path.resolve(process.cwd(), '../node_modules')],
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem,key,pfx}',
          '**/.git/**',
          '**/tests/**',
          '**/test-results/**',
          '**/playwright-report/**',
          '**/basic-ssl/**',
        ],
      },
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy, headers },
  };
});
