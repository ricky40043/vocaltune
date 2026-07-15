import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      watch: {
        ignored: [
          '**/backend-api/venv*/**',
          '**/backend-api/downloads/**',
          '**/backend-api/separated/**',
          '**/backend-api/karaoke_output/**',
          '**/backend-api/debug.log',
        ],
      },
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8050',
          changeOrigin: true,
          secure: false,
        },
        '/files': {
          target: 'http://127.0.0.1:8050',
          changeOrigin: true,
          secure: false,
        },
        '/ws': {
          target: 'ws://127.0.0.1:8050',
          ws: true,
        }
      }
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
