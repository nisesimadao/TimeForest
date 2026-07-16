#!/usr/bin/env node
/* Rasterise client/build/icon.svg into the PNGs the app and its installer need.
 *
 * No image library: Chromium is already here (Electron ships one, and the
 * verify scripts drive it over CDP), and it renders SVG better than anything
 * we'd add to package.json for this. electron-builder derives .ico/.icns from
 * icon.png itself, so a single 1024px master plus the tray sizes is enough.
 *
 * Usage:  npm i playwright-core && npm run icons
 */
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed. For this script only:  npm i playwright-core');
  process.exit(1);
}
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'client', 'build');
const SVG = path.join(BUILD, 'icon.svg');

// 1024: electron-builder's master. 512/256: what it wants for .icns rungs.
// 32/16: the tray, where the whole design has to still be legible.
const SIZES = [1024, 512, 256, 128, 64, 32, 16];

(async () => {
  if (!fs.existsSync(SVG)) throw new Error('missing ' + SVG);
  const svg = fs.readFileSync(SVG, 'utf8');

  const exe = path.join(ROOT, 'client', 'node_modules', 'electron', 'dist', 'electron.exe');
  const browser = await chromium.launch({
    executablePath: fs.existsSync(exe) ? undefined : undefined,
  });
  const page = await browser.newPage();

  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
    );
    const out = path.join(BUILD, size === 1024 ? 'icon.png' : `icon-${size}.png`);
    await page.locator('svg').screenshot({ path: out, omitBackground: true });
    console.log(`  ${path.relative(ROOT, out).replace(/\\/g, '/')}  ${size}×${size}`);
  }

  await browser.close();
  console.log('\nicons written to client/build/');
})().catch((e) => {
  console.error('icon build failed:', e.message);
  process.exit(1);
});
