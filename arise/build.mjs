// Wraps the Artifact-format fragment (wireframe.body.html) into a standalone
// document you can open with file://. The fragment is the single source of
// truth — never edit index.html by hand.
//
//   node arise/build.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const body = readFileSync(join(here, 'wireframe.body.html'), 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px system-ui, sans-serif; background: #fafaf9; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${body}
</body>
</html>
`;

writeFileSync(join(here, 'index.html'), html);
console.log('arise/index.html written (' + (html.length / 1024).toFixed(1) + ' KB)');
