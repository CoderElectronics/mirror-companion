import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/frontend',
  plugins: [tailwindcss()],
  build: { outDir: '../../dist', emptyOutDir: true },
});
