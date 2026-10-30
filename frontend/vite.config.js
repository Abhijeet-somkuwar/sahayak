import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server and build. The API origin comes from .env (VITE_API_URL), so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], antd: ['antd', '@ant-design/icons'] },
      },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.js'] },
});
