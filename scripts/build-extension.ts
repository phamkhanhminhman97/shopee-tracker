import { build } from 'esbuild';

await build({
  entryPoints: ['extension/content-scrape.ts'],
  outfile: 'extension/content-scrape.js',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'silent',
});

console.log('Built extension/content-scrape.js');
