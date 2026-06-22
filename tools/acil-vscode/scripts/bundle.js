// esbuild bundle script for acil-vscode
// Inlines @nit-in/acil and all other non-vscode dependencies into a single extension.js
// vscode is marked external — it's provided by VS Code's extension host at runtime.

const esbuild = require('esbuild');
const path    = require('path');

esbuild.build({
  entryPoints: [path.join(__dirname, '../src/extension.ts')],
  bundle:       true,
  outfile:      path.join(__dirname, '../dist/extension.js'),
  external:     ['vscode'],          // ← provided by extension host, never bundle
  format:       'cjs',
  platform:     'node',
  target:       'node18',
  sourcemap:    true,
  minify:       false,               // keep readable for debugging
  treeShaking:  true,
  tsconfig:     path.join(__dirname, '../tsconfig.extension.json'),
  logLevel:     'info',
}).then(() => {
  console.log('✓ Bundle complete: dist/extension.js');
}).catch((err) => {
  console.error('✗ Bundle failed:', err);
  process.exit(1);
});
