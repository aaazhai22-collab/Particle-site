import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { qaSink } from './scripts/qa-sink';
export default defineConfig({plugins: [react(), qaSink()], server: {port: 5173, strictPort: true},build:{rollupOptions:{output:{manualChunks:{three:['three'],react:['react','react-dom']}}}}});
