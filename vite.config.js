import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ base: './', plugins: [react()], resolve: { alias: [ {find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL('./src/localized-jsx-runtime.js', import.meta.url))}, {find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL('./src/localized-jsx-dev-runtime.js', import.meta.url))} ] }, build: { outDir: 'dist', rolldownOptions: {
  input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), faceWorker: fileURLToPath(new URL('./face-worker.html', import.meta.url)) }
} } });
