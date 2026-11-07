import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  build: { inlineStylesheets: 'never' },
  vite: {
    build: {
      target: 'es2022',
      assetsInlineLimit: 0,
    },
  },
});
