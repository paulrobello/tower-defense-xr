import { createHash, type Hash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Runtime ids are validated with this exact pattern on the client too (src/ui/version-check.ts). */
export const BUILD_ID_PATTERN = /^[0-9a-f]{6,64}$/;

const projectRoot = resolve(import.meta.dirname, '..');
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function normalizeBuildId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!BUILD_ID_PATTERN.test(id)) {
    throw new Error(
      `RIFT_BASTION_BUILD_ID must be 6-64 lowercase hex characters, received ${JSON.stringify(raw)}`,
    );
  }
  return id;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      byName(a.name, b.name),
    );
    for (const entry of entries) {
      if (IGNORED_FILES.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Feeds every file under `dir` (relative path + bytes, sorted) into `hash`. */
export function hashDirectory(hash: Hash, dir: string, label: string): void {
  hash.update(`dir:${label}\0`);
  for (const file of listFiles(dir)) {
    hash.update(relative(dir, file).split('\\').join('/')).update('\0');
    hash.update(readFileSync(file)).update('\0');
  }
}

export function packageVersion(root = projectRoot): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/**
 * Deterministic fingerprint of everything that can change what a user runs: the package version,
 * entry HTML, sources, lockfile and every file under `public/` (so an asset-only update changes it).
 */
export function sourceFingerprint(root = projectRoot): string {
  const hash = createHash('sha256');
  hash.update(`version:${packageVersion(root)}\0`);
  for (const file of ['index.html', 'bun.lock']) {
    const path = join(root, file);
    if (existsSync(path)) hash.update(`file:${file}\0`).update(readFileSync(path)).update('\0');
  }
  hashDirectory(hash, join(root, 'src'), 'src');
  hashDirectory(hash, join(root, 'public'), 'public');
  return hash.digest('hex');
}

/**
 * `RIFT_BASTION_BUILD_ID` (hex) overrides the id for deterministic A to B upgrade tests; otherwise
 * the id is the first 12 hex chars of the source fingerprint.
 */
export function currentBuildId(root = projectRoot): string {
  const override = process.env.RIFT_BASTION_BUILD_ID;
  if (override) return normalizeBuildId(override);
  return sourceFingerprint(root).slice(0, 12);
}

export interface VersionManifest {
  id: string;
  contentHash: string;
}

interface BundleEntry {
  type: string;
  code?: string;
  source?: string | Uint8Array;
}

/** Fingerprints emitted runtime bundles, the package version and `publicDir` files. */
export function computeContentHash(
  bundle: Record<string, BundleEntry>,
  version: string,
  publicDir: string,
): string {
  const hash = createHash('sha256');
  hash.update(`version:${version}\0`);
  for (const [name, entry] of Object.entries(bundle).sort(([a], [b]) => byName(a, b))) {
    if (name.endsWith('.map') || name === 'version.json') continue;
    hash.update(name).update('\0');
    hash.update(entry.type === 'chunk' ? (entry.code ?? '') : (entry.source ?? '')).update('\0');
  }
  hashDirectory(hash, publicDir, 'public');
  return hash.digest('hex');
}

export function versionManifestPlugin(buildId = currentBuildId()): Plugin {
  let root = projectRoot;
  let publicDir = join(projectRoot, 'public');
  return {
    name: 'rift-bastion-build-version',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      if (config.publicDir) publicDir = config.publicDir;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          '</head>',
          `<script>window.__APP_BUILD=${JSON.stringify(buildId)}</script></head>`,
        );
      },
    },
    generateBundle(_options, bundle) {
      const manifest: VersionManifest = {
        id: buildId,
        contentHash: computeContentHash(
          bundle as unknown as Record<string, BundleEntry>,
          packageVersion(root),
          publicDir,
        ),
      };
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(manifest),
      });
    },
  };
}
