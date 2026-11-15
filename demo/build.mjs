// Bundle src/ into one self-contained page: dist/containment-demo.html.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2019',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  legalComments: 'none',
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const page = readFileSync('index.template.html', 'utf8').replace('/*__APP__*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/containment-demo.html', page);
console.log(`dist/containment-demo.html ${(page.length / 1024).toFixed(0)} KB`);
