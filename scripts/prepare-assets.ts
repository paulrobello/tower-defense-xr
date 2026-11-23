import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stageWorkspaceAssets } from '@par/xr-workspace/stage-assets';

interface SourceModelRecord {
  readonly id: string;
  readonly lod: number;
  readonly file: string;
  readonly sha256: string;
  readonly animations?: readonly string[];
}

interface SourceModelManifest {
  readonly version: number;
  readonly models: readonly SourceModelRecord[];
}

interface SourceMaterialTextureRecord {
  readonly file: string;
  readonly role: 'basecolor' | 'normal' | 'orm' | 'emissive';
  readonly sha256: string;
}

interface SourceMaterialManifest {
  readonly version: number;
  readonly textures: readonly SourceMaterialTextureRecord[];
}

interface SourceSfxDerivativeRecord {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly duration_seconds: number;
}

interface SourceSfxCatalogEntry {
  readonly id: string;
  readonly family: string;
  readonly loop: boolean;
  readonly derivatives: {
    readonly ogg: SourceSfxDerivativeRecord;
    readonly mp3: SourceSfxDerivativeRecord;
  };
}

interface SourceSfxCatalog {
  readonly cues: readonly SourceSfxCatalogEntry[];
}

export interface PromotedModelEntry {
  readonly id: string;
  readonly lod: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly animations: readonly string[];
}

export interface PromotedMaterialEntry {
  readonly id: string;
  readonly basecolor: string;
  readonly normal: string;
  readonly orm: string;
  readonly emissive?: string;
}

export interface PromotedSfxEntry {
  readonly id: string;
  readonly family: string;
  readonly loop: boolean;
  readonly ogg: string;
  readonly mp3: string;
  readonly durationSec: number;
}

export interface RuntimeAssetManifest {
  readonly version: 1;
  readonly generatedFrom: string;
  readonly basisTranscoderDir: string;
  readonly models: readonly PromotedModelEntry[];
  readonly materials: readonly PromotedMaterialEntry[];
  readonly sfx: readonly PromotedSfxEntry[];
  readonly extras: Readonly<
    Record<string, { readonly path: string; readonly sha256: string; readonly bytes: number }>
  >;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const root = resolve(import.meta.dirname, '..');
const publicDir = join(root, 'public');
const assetsDir = join(publicDir, 'assets');
await mkdir(join(root, '.local'), { recursive: true });
const temp = await mkdtemp(join(root, '.local', 'stage-'));

try {
  // 1. Stage @par/xr-workspace hands & local Troika fonts
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

  // 2. Stage Three.js Basis/KTX2 transcoder for runtime WebGL2 KTX2 decoding
  const basisSrc = join(root, 'node_modules/three/examples/jsm/libs/basis');
  const basisDst = join(assetsDir, 'basis');
  await mkdir(basisDst, { recursive: true });
  for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm'] as const) {
    await copyFile(join(basisSrc, file), join(basisDst, file));
  }

  // 3. Promote Owner-Checkpoint-2-approved Blender GLBs (all 40 LOD0/LOD1 models)
  const modelsSrcDir = join(root, 'assets-source/models');
  const modelsDstDir = join(assetsDir, 'models');
  await mkdir(modelsDstDir, { recursive: true });
  const sourceManifestRaw = await readFile(join(modelsSrcDir, 'manifest.json'), 'utf8');
  const sourceManifest = JSON.parse(sourceManifestRaw) as SourceModelManifest;

  const promotedModels: PromotedModelEntry[] = [];
  for (const record of sourceManifest.models) {
    const srcPath = join(modelsSrcDir, record.file);
    const bytes = await readFile(srcPath);
    const actualSha = sha256Hex(bytes);
    if (actualSha !== record.sha256) {
      throw new Error(
        `SHA-256 mismatch while promoting ${record.id} LOD${record.lod}: expected ${record.sha256}, got ${actualSha}`,
      );
    }
    const outName = `${record.id}-lod${record.lod}.glb`;
    const dstPath = join(modelsDstDir, outName);
    await writeFile(dstPath, bytes);
    promotedModels.push({
      id: record.id,
      lod: record.lod,
      path: `/assets/models/${outName}`,
      sha256: actualSha,
      bytes: bytes.byteLength,
      animations: record.animations ?? [],
    });
  }

  // 4. Promote Boss Phase-2 molten crack emissive mask + Higgsfield UI atlas & key art
  const uiSrcDir = join(root, 'assets-source/ui/candidates');
  const uiDstDir = join(assetsDir, 'ui');
  await mkdir(uiDstDir, { recursive: true });

  const extraFiles: Array<readonly [key: string, src: string, dst: string, webPath: string]> = [
    [
      'broodlord-phase2-cracks',
      join(modelsSrcDir, 'apex-broodlord/phase2-cracks.png'),
      join(modelsDstDir, 'apex-broodlord-phase2-cracks.png'),
      '/assets/models/apex-broodlord-phase2-cracks.png',
    ],
    [
      'broodlord-emissive',
      join(modelsSrcDir, 'apex-broodlord/emissive.png'),
      join(modelsDstDir, 'apex-broodlord-emissive.png'),
      '/assets/models/apex-broodlord-emissive.png',
    ],
    [
      'tactical-atlas',
      join(uiSrcDir, 'tactical-atlas.png'),
      join(uiDstDir, 'tactical-atlas.png'),
      '/assets/ui/tactical-atlas.png',
    ],
    [
      'tactical-atlas-manifest',
      join(uiSrcDir, 'atlas.json'),
      join(uiDstDir, 'atlas.json'),
      '/assets/ui/atlas.json',
    ],
    [
      'desktop-title',
      join(uiSrcDir, 'desktop-title.jpg'),
      join(uiDstDir, 'desktop-title.jpg'),
      '/assets/ui/desktop-title.jpg',
    ],
    [
      'quest-title',
      join(uiSrcDir, 'quest-title.jpg'),
      join(uiDstDir, 'quest-title.jpg'),
      '/assets/ui/quest-title.jpg',
    ],
  ];

  const extras: Record<string, { path: string; sha256: string; bytes: number }> = {};
  for (const [key, src, dst, webPath] of extraFiles) {
    const bytes = await readFile(src);
    await writeFile(dst, bytes);
    extras[key] = {
      path: webPath,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }

  // 5. Promote all 5 shared PBR KTX2 materials (SHA-256 verified)
  const matsSrcDir = join(root, 'assets-source/materials');
  const matsDstDir = join(assetsDir, 'materials');
  const sourceMatManifest = JSON.parse(
    await readFile(join(matsSrcDir, 'manifest.json'), 'utf8'),
  ) as SourceMaterialManifest;

  const materialGroups = new Map<
    string,
    { basecolor?: string; normal?: string; orm?: string; emissive?: string }
  >();
  for (const tex of sourceMatManifest.textures) {
    const srcPath = join(matsSrcDir, tex.file);
    const bytes = await readFile(srcPath);
    const actualSha = sha256Hex(bytes);
    if (actualSha !== tex.sha256) {
      throw new Error(
        `SHA-256 mismatch while promoting material texture ${tex.file}: expected ${tex.sha256}, got ${actualSha}`,
      );
    }
    // Normalize `rift-obsidian-revision/rift-obsidian/basecolor.ktx2` -> `rift-obsidian`
    const parts = tex.file.split('/');
    const matId =
      parts.length >= 2 ? (parts[parts.length - 2] ?? parts[0] ?? 'material') : 'material';
    const fileName = parts[parts.length - 1] ?? `${tex.role}.ktx2`;
    const outDir = join(matsDstDir, matId);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, fileName), bytes);
    const webPath = `/assets/materials/${matId}/${fileName}`;
    const entry = materialGroups.get(matId) ?? {};
    entry[tex.role] = webPath;
    materialGroups.set(matId, entry);
  }
  const promotedMaterials: PromotedMaterialEntry[] = [];
  for (const [id, maps] of materialGroups.entries()) {
    if (maps.basecolor && maps.normal && maps.orm) {
      promotedMaterials.push({
        id,
        basecolor: maps.basecolor,
        normal: maps.normal,
        orm: maps.orm,
        ...(maps.emissive ? { emissive: maps.emissive } : {}),
      });
    }
  }

  // 6. Stage owner-approved ElevenLabs SFX for in-game runtime playback (when local archive is present)
  const sfxStagingDir = join(root, 'assets-source/audio/sfx/staging');
  const sfxCatalogPath = join(sfxStagingDir, 'catalog.json');
  const promotedSfx: PromotedSfxEntry[] = [];
  if (existsSync(sfxCatalogPath)) {
    const sfxCatalog = JSON.parse(await readFile(sfxCatalogPath, 'utf8')) as SourceSfxCatalog;
    const sfxDstDir = join(assetsDir, 'audio/sfx');
    let stagedAny = false;
    for (const cue of sfxCatalog.cues) {
      const oggSrc = join(sfxStagingDir, cue.derivatives.ogg.file);
      const mp3Src = join(sfxStagingDir, cue.derivatives.mp3.file);
      if (!existsSync(oggSrc) || !existsSync(mp3Src)) continue;
      if (!stagedAny) {
        await mkdir(sfxDstDir, { recursive: true });
        stagedAny = true;
      }
      const [oggBytes, mp3Bytes] = await Promise.all([readFile(oggSrc), readFile(mp3Src)]);
      const oggSha = sha256Hex(oggBytes);
      const mp3Sha = sha256Hex(mp3Bytes);
      if (oggSha !== cue.derivatives.ogg.sha256) {
        throw new Error(
          `SHA-256 mismatch while staging SFX ${cue.derivatives.ogg.file}: expected ${cue.derivatives.ogg.sha256}, got ${oggSha}`,
        );
      }
      if (mp3Sha !== cue.derivatives.mp3.sha256) {
        throw new Error(
          `SHA-256 mismatch while staging SFX ${cue.derivatives.mp3.file}: expected ${cue.derivatives.mp3.sha256}, got ${mp3Sha}`,
        );
      }
      await Promise.all([
        writeFile(join(sfxDstDir, cue.derivatives.ogg.file), oggBytes),
        writeFile(join(sfxDstDir, cue.derivatives.mp3.file), mp3Bytes),
      ]);
      promotedSfx.push({
        id: cue.id,
        family: cue.family,
        loop: cue.loop,
        ogg: `/assets/audio/sfx/${cue.derivatives.ogg.file}`,
        mp3: `/assets/audio/sfx/${cue.derivatives.mp3.file}`,
        durationSec: cue.derivatives.ogg.duration_seconds,
      });
    }
  }

  // 7. Write hash-checked runtime manifest
  const runtimeManifest: RuntimeAssetManifest = {
    version: 1,
    generatedFrom: 'assets-source/models/manifest.json',
    basisTranscoderDir: '/assets/basis/',
    models: promotedModels,
    materials: promotedMaterials,
    sfx: promotedSfx,
    extras,
  };
  await writeFile(
    join(assetsDir, 'manifest.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    'utf8',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
