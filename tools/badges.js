#!/usr/bin/env node
/* Generate the README's status badges as static SVGs under docs/.
 *
 * Static, not shields.io endpoints, because the repo is private and shields
 * cannot read it. That means they can drift from the truth — so scripts/check.js
 * checks each one's claim against the source (dependencies really 0, node
 * really the CI matrix, Electron really that major). This file is what it
 * checks the SHAPE against: run it, and if docs/ changes, a badge's text was
 * edited by hand instead of here. CI reproduces it the same way it reproduces
 * the userscript.
 *
 *   node tools/badges.js            # write docs/badge-*.svg
 *   node tools/badges.js --check    # fail if any file would change
 *
 * The values themselves are read from the repo, not hardcoded, so `Electron 43`
 * becomes `Electron 44` here the moment client/package.json bumps — and the
 * check.js guard then makes sure the README was regenerated to match.
 *
 * The README shows PNGs, not these SVGs, because GitHub's camo proxy mangles
 * README SVGs into broken-image icons (worse on a private repo). The PNGs are
 * rasterised from these SVGs by tools/rasterise-docs.js (a headed browser), so
 * the SVG stays the single source of truth and the PNG is just what renders.
 * check.js verifies every image the README points at actually exists.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

/**
 * A flat, shields-style badge. `id` is woven into the two internal ids so that
 * five of these inlined into one document — which is what a markdown renderer
 * that doesn't sandbox each <img> does — don't all share `id="r"` and clip each
 * other. Widths survive it today only because every clip is the same rectangle;
 * a unique id is what keeps that from being luck.
 */
function badge(id, label, value, color) {
  const pad = 7;
  const textW = (s) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 12 : 6.6), 0);
  const lw = Math.round(textW(label) + pad * 2);
  const vw = Math.round(textW(value) + pad * 2);
  const w = lw + vw;
  const gid = `g_${id}`;
  const rid = `r_${id}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="${gid}" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="${rid}"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#${rid})">
    <rect width="${lw}" height="20" fill="#42474e"/>
    <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#${gid})"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${lw / 2}" y="14">${label}</text>
    <text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${lw + vw / 2}" y="14">${value}</text>
  </g>
</svg>
`;
}

const rootPkg = read('package.json');
const clientPkg = read('client/package.json');
const manifest = read('manifest.json');
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

const runtimeDeps = Object.keys(rootPkg.dependencies || {}).length
  + Object.keys(clientPkg.dependencies || {}).length;
const electronMajor = (clientPkg.devDependencies.electron || '').match(/(\d+)/)?.[1] || '?';
const nodeMatrix = (ci.match(/node:\s*\[([^\]]+)\]/)?.[1] || '').replace(/\s/g, '').replace(/,/g, ' · ');

const GREEN = '#12a45f';
const BLUE = '#2b6cb0';
const OLIVE = '#417e38';

const files = {
  'badge-deps.svg': badge('deps', 'dependencies', String(runtimeDeps), GREEN),
  'badge-build.svg': badge('build', 'build step', 'none', GREEN),
  'badge-node.svg': badge('node', 'node', nodeMatrix, OLIVE),
  'badge-electron.svg': badge('electron', 'platform', `Electron ${electronMajor}`, BLUE),
  'badge-mv3.svg': badge('mv3', 'extension', `MV${manifest.manifest_version}`, BLUE),
};

const check = process.argv.includes('--check');
let drift = 0;
for (const [name, svg] of Object.entries(files)) {
  const p = path.join(DOCS, name);
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (current === svg) continue;
  if (check) { console.error(`drift: docs/${name} — run \`node tools/badges.js\``); drift++; }
  else { fs.writeFileSync(p, svg); console.log(`wrote docs/${name}`); }
}
if (check && drift) process.exit(1);
if (check) console.log('badges are up to date');
