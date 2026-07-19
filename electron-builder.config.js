/* electron-builder configuration.
 *
 * The app root is the REPOSITORY root, not client/ — which looks odd until you
 * remember why src/lib exists. The renderer loads ../../src/lib/*.js, because
 * the extension, the userscript and this client all run the SAME files and CI
 * fails the build if a second copy appears. Packaging client/ alone would leave
 * the shared libs out; copying them in at build time would be exactly the drift
 * that rule exists to prevent. So we package from the root and keep the paths
 * the code already uses: inside the asar, client/renderer/index.html still
 * resolves ../../src/lib/tz.js to src/lib/tz.js.
 *
 * `files` is therefore an allowlist. It has to be — the repo root also holds
 * scripts/, .local/ and client/node_modules (Electron itself, 144MB).
 *
 * Usage: npm run dist        (from the repo root)
 */
const fs = require('node:fs');
const path = require('node:path');

/* Electron lives in client/package.json, so the version has to be read from
 * there. Hard-coding it here would silently package the wrong runtime the
 * first time somebody bumps it in the only place it's actually installed. */
const clientPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'client', 'package.json'), 'utf8')
);
const electronVersion = (clientPkg.devDependencies.electron || '').replace(/^[^\d]*/, '');

module.exports = {
  appId: 'io.github.nisesimadao.timeforest',
  productName: 'TimeForest',
  copyright: 'nisesimadao',
  electronVersion,

  directories: {
    output: 'client/dist',
    buildResources: 'client/build',
  },

  // `main` in the root package.json points at nothing useful (this isn't the
  // app), so tell the packaged copy where the real entry point is.
  extraMetadata: {
    main: 'client/main.js',
    name: 'TimeForest',
  },

  files: [
    'client/main.js',
    'client/preload.js',
    'client/renderer/**/*',
    'client/build/icon*.png',
    'src/lib/**/*',
    'package.json',
    // Belt and braces: `files` is an allowlist, but Electron's own 144MB tree
    // sitting inside the app root is the kind of thing worth naming twice.
    '!client/node_modules/**/*',
    '!client/dist/**/*',
  ],

  asar: true,

  win: {
    icon: 'client/build/icon.png',
    target: [
      { target: 'nsis', arch: ['x64'] },
      // A zip as well: this is an unsigned build of an unofficial client, and
      // "unzip and run" is a reasonable thing to want when Windows is going to
      // warn about the installer anyway.
      { target: 'zip', arch: ['x64'] },
    ],
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'TimeForest',
    // The app keeps sessions and accounts in %APPDATA%\TimeForest. Deleting
    // them on uninstall would log the user out of every account they added;
    // leaving them means a reinstall picks up where they left off.
    deleteAppDataOnUninstall: false,
  },

  mac: {
    icon: 'client/build/icon.png',
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
  },

  linux: {
    icon: 'client/build/icon.png',
    category: 'Office',
    target: ['AppImage'],
  },

  artifactName: '${productName}-${version}-${arch}.${ext}',
};
