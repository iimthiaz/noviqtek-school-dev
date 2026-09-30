// Copies browser libraries from node_modules into public/vendor (served from your own domain, no CDN).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'public', 'vendor'), { recursive: true });
let missing = 0;
for (const [from, to] of [['qrcode-generator/qrcode.js', 'qrcode.js'], ['jsqr/dist/jsQR.js', 'jsQR.js'], ['xlsx/dist/xlsx.full.min.js', 'xlsx.full.min.js']]) {
  const src = join(ROOT, 'node_modules', from);
  if (!existsSync(src)) { console.error(`Missing ${from} — run npm install.`); missing++; continue; }
  copyFileSync(src, join(ROOT, 'public', 'vendor', to));
  console.log(`vendor: ${to}`);
}
if (missing) process.exit(1);
