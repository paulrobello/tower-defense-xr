import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stageWorkspaceAssets } from '@par/xr-workspace/stage-assets';

const root = resolve(import.meta.dirname, '..');
const publicDir = join(root, 'public');
await mkdir(join(root, '.local'), { recursive: true });
const temp = await mkdtemp(join(root, '.local', 'stage-'));
try {
  await stageWorkspaceAssets(temp);
  await copyFile(
    join(root, '../mux-xr/assets-source/xr-hands/LICENSE.md'),
    join(temp, 'assets/xr-hands/LICENSE.md'),
  );
  for (const [dir, names] of [
    ['assets/xr-hands', ['left.glb', 'right.glb', 'LICENSE.md']],
    [
      'fonts',
      [
        'NotoSans-Regular.ttf',
        'NotoSansSymbols2-Regular.ttf',
        'OFL.txt',
        'NotoSansSymbols2-OFL.txt',
      ],
    ],
  ] as const) {
    await mkdir(join(publicDir, dir), { recursive: true });
    for (const file of names) {
      await rename(join(temp, dir, file), join(publicDir, dir, file));
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
