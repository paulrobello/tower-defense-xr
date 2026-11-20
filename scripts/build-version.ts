import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

export function currentBuildId(): string {
  if (process.env.RIFT_BASTION_BUILD_ID) return process.env.RIFT_BASTION_BUILD_ID;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export function versionManifestPlugin(buildId = currentBuildId()): Plugin {
  return {
    name: 'rift-bastion-build-version',
    apply: 'build',
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
      const hash = createHash('sha256');
      for (const [name, entry] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (name.endsWith('.map')) continue;
        hash.update(name).update('\0');
        hash.update(entry.type === 'chunk' ? entry.code : String(entry.source)).update('\0');
      }
      const contentHash = hash.digest('hex');
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ id: buildId, contentHash }),
      });
    },
  };
}
