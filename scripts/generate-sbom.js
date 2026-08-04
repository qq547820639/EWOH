#!/usr/bin/env node
/* EWOH SBOM (Software Bill of Materials) generator.
 *
 * Generates a CycloneDX 1.5 SBOM for the published ewoh-spark-app artifact
 * using `npm sbom` (npm >= 10, no third-party dependency). Output is written
 * to a file and a short summary is printed.
 *
 * Usage:
 *   node scripts/generate-sbom.js [--out <path>] [--include-dev]
 *
 *   --out          output file path (default: release/ewoh-spark-sbom.cyclonedx.json)
 *   --include-dev  include dev dependencies (default: omit dev, i.e. runtime only)
 *
 * Fallback: if `npm sbom` is unavailable (older npm) or fails, the script emits
 * a minimal CycloneDX summary derived from package-lock.json and marks
 * `generation: "derived-from-lockfile"` instead of `"npm-sbom"`. It never
 * fabricates dependency data on its own.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = resolve(ROOT, 'ewoh-spark-app');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { out: resolve(ROOT, 'release/ewoh-spark-sbom.cyclonedx.json'), dev: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out.out = resolve(ROOT, args[++i]);
    else if (args[i] === '--include-dev') out.dev = true;
  }
  return out;
}

function runNpmSbom(includeDev) {
  const args = ['sbom', '--sbom-format=cyclonedx'];
  if (!includeDev) args.push('--omit=dev');
  const stdout = execFileSync('npm', args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function deriveFromLockfile() {
  const lock = JSON.parse(readFileSync(resolve(APP_DIR, 'package-lock.json'), 'utf8'));
  const pkg = lock.packages?.[''] ?? {};
  const deps = pkg.dependencies ?? {};
  const components = Object.entries(deps)
    .filter(([name]) => name && !name.startsWith('node_modules'))
    .map(([name, spec]) => {
      const version = typeof spec === 'string' ? spec.replace(/^[^0-9]/, '') : spec?.version;
      return {
        type: 'library',
        name,
        version: version || 'unknown',
        scope: 'required',
        purl: `pkg:npm/${name.toLowerCase()}@${version}`,
      };
    });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'ewoh', name: 'generate-sbom', version: '1.0.0' }],
      component: {
        type: 'application',
        name: 'ewoh-spark-app',
        version: pkg.version ?? '0.0.0',
      },
      properties: [{ name: 'ewoh:generation', value: 'derived-from-lockfile' }],
    },
    components,
  };
}

function main() {
  const { out, dev } = parseArgs();
  let bom;
  let mode;
  try {
    bom = runNpmSbom(dev);
    mode = 'npm-sbom';
    bom.metadata.properties = bom.metadata.properties ?? [];
    bom.metadata.properties.push({ name: 'ewoh:generation', value: mode });
  } catch (error) {
    console.warn(`[generate-sbom] npm sbom unavailable/failed (${error?.message}). Falling back to lockfile-derived summary.`);
    bom = deriveFromLockfile();
    mode = 'derived-from-lockfile';
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);

  const components = bom.components?.length ?? 0;
  const top = bom.metadata?.component
    ? `${bom.metadata.component.name}@${bom.metadata.component.version}`
    : 'unknown';
  console.log(`[generate-sbom] mode=${mode} top=${top} components=${components}`);
  console.log(`[generate-sbom] written: ${out}`);
  return mode === 'npm-sbom' ? 0 : 1;
}

process.exitCode = main();