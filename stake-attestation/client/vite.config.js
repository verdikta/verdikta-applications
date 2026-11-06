import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 5176: next free client port after the repository's other apps (see ../README.md).
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, strictPort: true },
  preview: { port: 5176, strictPort: true },
});
