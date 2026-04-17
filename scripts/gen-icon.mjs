/**
 * Generates ScaleformTools.ico from an inline SVG.
 * Run: node scripts/gen-icon.mjs
 * Output: desktop/ScaleformTools.ico  (used by the WPF app)
 *         src/icon.png                (used by index.html favicon)
 */

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root  = path.resolve(__dir, '..');

// ─── Icon SVG design ──────────────────────────────────────────────────────────
// A rounded-square app icon with the Scaleform Tools colour scheme.
// Visual: two overlapping UI "frames" (inner + outer rectangle outlines)
// suggesting layers/editing, with an "S" negative-space cut through the centre.

const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#0f0f1a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
    <linearGradient id="accent2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>

  <!-- Background rounded square -->
  <rect width="256" height="256" rx="48" ry="48" fill="url(#bg)"/>

  <!-- Outer frame outline -->
  <rect x="28" y="28" width="200" height="200" rx="20" ry="20"
        fill="none" stroke="url(#accent)" stroke-width="8" opacity="0.35"/>

  <!-- Inner frame outline -->
  <rect x="52" y="52" width="152" height="152" rx="12" ry="12"
        fill="none" stroke="url(#accent)" stroke-width="6" opacity="0.6"/>

  <!-- Stylised "S" shape built from two arcs/rectangles -->
  <!-- Top arc of S -->
  <path d="M 152 88
             C 152 72, 104 72, 104 92
             C 104 108, 152 108, 152 128
             C 152 148, 104 148, 104 164"
        fill="none"
        stroke="url(#accent2)"
        stroke-width="20"
        stroke-linecap="round"
        stroke-linejoin="round"/>

  <!-- Corner accent dots -->
  <circle cx="52"  cy="52"  r="6" fill="url(#accent)" opacity="0.7"/>
  <circle cx="204" cy="52"  r="6" fill="url(#accent)" opacity="0.7"/>
  <circle cx="52"  cy="204" r="6" fill="url(#accent)" opacity="0.7"/>
  <circle cx="204" cy="204" r="6" fill="url(#accent)" opacity="0.7"/>
</svg>`;

// ─── Render at multiple sizes ─────────────────────────────────────────────────

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = [];

console.log('Rendering icon sizes...');
for (const size of sizes) {
  const buf = await sharp(Buffer.from(svgIcon))
    .resize(size, size)
    .png()
    .toBuffer();
  pngBuffers.push(buf);
  process.stdout.write(` ${size}px`);
}
console.log();

// ─── Write ICO (desktop app icon) ────────────────────────────────────────────

const icoPath = path.join(root, 'desktop', 'ScaleformTools.ico');
const icoBuffer = await pngToIco(pngBuffers);
writeFileSync(icoPath, icoBuffer);
console.log(`✓ ${icoPath} (${(icoBuffer.length / 1024).toFixed(1)} KB)`);

// ─── Write 256px PNG (favicon / future use) ──────────────────────────────────

const pngPath = path.join(root, 'src', 'icon.png');
writeFileSync(pngPath, pngBuffers[pngBuffers.length - 1]);
console.log(`✓ ${pngPath}`);
