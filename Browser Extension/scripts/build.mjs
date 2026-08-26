#!/usr/bin/env node
/**
 * esbuild bundler for the extension.
 *
 * Produces four independent bundles (MV3 forbids shared chunks across worlds):
 *   dist/service-worker.js  background, ESM service worker
 *   dist/content.js         ISOLATED-world content script (IIFE)
 *   dist/page-hook.js       MAIN-world network metadata hook (IIFE)
 *   dist/popup.js           popup UI (IIFE)
 */
import * as esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'extension', 'src');
const outDir = path.join(root, 'extension', 'dist');

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

// Bundles that touch the data-collection surface directly (network hook, field
// tracking, button-click/submission detection) get obfuscated on top of minification
// so the shipped code isn't trivially readable. Not applied in --dev/--watch builds.
const OBFUSCATE_OUTFILES = new Set(['content.js', 'page-hook.js']);

async function obfuscateOutput(outfile) {
  const code = await readFile(outfile, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    numbersToExpressions: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    simplify: true,
  });
  await writeFile(outfile, result.getObfuscatedCode());
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  target: ['chrome114'],
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __DEV__: JSON.stringify(dev),
  },
  alias: {
    '@': srcDir,
  },
};

const targets = [
  {
    entryPoints: [path.join(srcDir, 'background', 'service-worker.ts')],
    outfile: path.join(outDir, 'service-worker.js'),
    format: 'esm',
  },
  {
    entryPoints: [path.join(srcDir, 'content', 'index.ts')],
    outfile: path.join(outDir, 'content.js'),
    format: 'iife',
  },
  {
    entryPoints: [path.join(srcDir, 'content', 'page-hook.ts')],
    outfile: path.join(outDir, 'page-hook.js'),
    format: 'iife',
  },
  {
    entryPoints: [path.join(srcDir, 'popup', 'popup.ts')],
    outfile: path.join(outDir, 'popup.js'),
    format: 'iife',
  },
];

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  await cp(path.join(srcDir, 'popup', 'popup.html'), path.join(outDir, 'popup.html'));
  await cp(path.join(srcDir, 'popup', 'popup.css'), path.join(outDir, 'popup.css'));
  const iconsSrc = path.join(root, 'extension', 'icons');
  if (existsSync(iconsSrc)) {
    await cp(iconsSrc, path.join(outDir, 'icons'), { recursive: true });
  }
  // Keep manifest version in sync with package.json.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifestPath = path.join(root, 'extension', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

await copyStatic();

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context({ ...shared, ...t })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build] watching…');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...shared, ...t })));
  if (!dev) {
    const toObfuscate = targets.filter((t) => OBFUSCATE_OUTFILES.has(path.basename(t.outfile)));
    await Promise.all(toObfuscate.map((t) => obfuscateOutput(t.outfile)));
    console.log('[build] obfuscated →', toObfuscate.map((t) => path.basename(t.outfile)).join(', '));
  }
  console.log('[build] done →', path.relative(root, outDir));
}
