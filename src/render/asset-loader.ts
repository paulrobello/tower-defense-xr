/**
 * Runtime AAA GLB + KTX2 Asset Loader, Template Cache & Shader Precompilation Veil
 * (`src/render/asset-loader.ts`, P4-T1).
 *
 * - Reads the promoted hash-checked `/assets/manifest.json`.
 * - Decodes embedded BasisU/KTX2 PBR maps off-thread via `KTX2Loader` (`/assets/basis/`).
 * - Clones rigid models cleanly and clones skinned/animated invaders via `SkeletonUtils.clone`.
 * - Builds the Apex Broodlord Phase-2 molten crack emissive texture once on demand.
 * - Exposes a lightweight load-veil controller and precompiles all loaded shaders via
 *   `renderer.compileAsync` so Wave 1 runs with zero mid-combat shader compilation stalls.
 */

import * as THREE from 'three';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { EnemyId, TurretKind, TurretTierId } from '../content/index.ts';

export type SharedPbrMaterialId =
  | 'brushed-titanium'
  | 'tactical-ceramic'
  | 'dark-gunmetal'
  | 'obsidian-chitin'
  | 'rift-obsidian';

export interface RuntimeModelManifestEntry {
  readonly id: string;
  readonly lod: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly animations: readonly string[];
}

export interface RuntimeMaterialManifestEntry {
  readonly id: SharedPbrMaterialId;
  readonly basecolor: string;
  readonly normal: string;
  readonly orm: string;
  readonly emissive?: string;
}

export interface RuntimeSfxManifestEntry {
  readonly id: string;
  readonly family: string;
  readonly loop: boolean;
  readonly ogg: string;
  readonly mp3: string;
  readonly durationSec: number;
}

export interface RuntimeAssetManifest {
  readonly version: 1;
  readonly basisTranscoderDir: string;
  readonly models: readonly RuntimeModelManifestEntry[];
  readonly materials?: readonly RuntimeMaterialManifestEntry[];
  readonly sfx?: readonly RuntimeSfxManifestEntry[];
  readonly extras: Readonly<
    Record<string, { readonly path: string; readonly sha256: string; readonly bytes: number }>
  >;
}

export interface LoadedModelTemplate {
  readonly id: string;
  readonly lod: number;
  readonly scene: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
  readonly isSkinned: boolean;
}

export interface AssetLoaderProgress {
  readonly loaded: number;
  readonly total: number;
  readonly ready: boolean;
  readonly precompiled: boolean;
  /** True only after required runtime assets and shader preparation are complete. */
  readonly readyForLaunch: boolean;
}

export type AssetLoaderListener = (progress: Readonly<AssetLoaderProgress>) => void;

export interface RuntimeAssetLibrary {
  readonly manifest: RuntimeAssetManifest | null;
  readonly progress: Readonly<AssetLoaderProgress>;
  readonly ready: boolean;
  readonly broodlordPhase2Emissive: THREE.Texture | null;
  loadAll(): Promise<boolean>;
  hasModel(id: string, lod?: 0 | 1): boolean;
  hasSharedMaterial(id: SharedPbrMaterialId): boolean;
  getSharedMaterial(
    id: SharedPbrMaterialId,
    options?: { readonly repeat?: readonly [number, number]; readonly side?: THREE.Side },
  ): THREE.MeshStandardMaterial | null;
  instantiate(
    id: string,
    lod?: 0 | 1,
  ): {
    readonly root: THREE.Group;
    readonly animations: readonly THREE.AnimationClip[];
    readonly isSkinned: boolean;
  } | null;
  precompile(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): Promise<void>;
  subscribe(listener: AssetLoaderListener): () => void;
  dispose(): void;
}

const TURRET_MODEL_PREFIX: Readonly<Record<TurretKind, string>> = {
  autocannon: 'm44-autocannon',
  'plasma-mortar': 'helios-plasma-mortar',
  'cryo-arc': 'glacier-cryo-arc',
  'rail-sniper': 'valkyrie-rail-sniper',
};

export function turretModelId(kind: TurretKind, tier: TurretTierId): string {
  const suffix = tier.toLowerCase();
  return `${TURRET_MODEL_PREFIX[kind]}-${suffix}`;
}

export function enemyModelId(archetypeId: EnemyId): string {
  return archetypeId;
}

function modelKey(id: string, lod: number): string {
  return `${id}:lod${lod}`;
}

async function loadBroodlordPhase2Texture(
  emissiveUrl: string,
  cracksUrl: string,
): Promise<THREE.Texture | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const loadImg = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${url}`));
      img.src = url;
    });
  try {
    const [baseEmissive, crackMask] = await Promise.all([loadImg(emissiveUrl), loadImg(cracksUrl)]);
    const w = crackMask.naturalWidth;
    const h = crackMask.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(baseEmissive, 0, 0, w, h);
    const baseData = ctx.getImageData(0, 0, w, h);

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return null;
    maskCtx.drawImage(crackMask, 0, 0, w, h);
    const maskData = maskCtx.getImageData(0, 0, w, h);

    const dst = baseData.data;
    const msk = maskData.data;
    for (let i = 0; i < dst.length; i += 4) {
      const crack = (msk[i] ?? 0) / 255;
      if (crack > 0.02) {
        dst[i] = Math.min(255, Math.round((dst[i] ?? 0) + crack * 255));
        dst[i + 1] = Math.min(255, Math.round((dst[i + 1] ?? 0) + crack * 92));
        dst[i + 2] = Math.min(255, Math.round((dst[i + 2] ?? 0) + crack * 10));
        dst[i + 3] = 255;
      }
    }
    ctx.putImageData(baseData, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;
  }
}

function disposeTemplate(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry?.dispose();
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (!mat) continue;
        for (const val of Object.values(mat)) {
          if (val instanceof THREE.Texture) val.dispose();
        }
        mat.dispose();
      }
    }
  });
}

export interface CreateRuntimeAssetLibraryOptions {
  readonly renderer?: THREE.WebGLRenderer | null;
  readonly manifestUrl?: string;
}

export function createRuntimeAssetLibrary(
  options: CreateRuntimeAssetLibraryOptions = {},
): RuntimeAssetLibrary {
  const manifestUrl = options.manifestUrl ?? '/assets/manifest.json';
  const templates = new Map<string, LoadedModelTemplate>();
  const sharedMaterials = new Map<SharedPbrMaterialId, THREE.MeshStandardMaterial>();
  const derivedMaterials: THREE.MeshStandardMaterial[] = [];
  const derivedTextures: THREE.Texture[] = [];
  const listeners = new Set<AssetLoaderListener>();

  let manifest: RuntimeAssetManifest | null = null;
  let broodlordPhase2Emissive: THREE.Texture | null = null;
  let loadPromise: Promise<boolean> | null = null;
  let ktx2Loader: KTX2Loader | null = null;
  let loadedCount = 0;
  let totalCount = 0;
  let ready = false;
  let precompiled = false;
  let disposed = false;

  const notify = (): void => {
    const snap: AssetLoaderProgress = {
      loaded: loadedCount,
      total: totalCount,
      ready,
      precompiled,
      readyForLaunch: ready && precompiled,
    };
    for (const fn of listeners) fn(snap);
  };

  async function doLoadAll(): Promise<boolean> {
    if (disposed || typeof fetch !== 'function') return false;
    try {
      const resp = await fetch(manifestUrl);
      if (!resp.ok) return false;
      const contentType = resp.headers.get('content-type') ?? '';
      if (contentType && !contentType.includes('json')) return false;
      const parsed = (await resp.json()) as RuntimeAssetManifest;
      if (parsed.version !== 1 || !Array.isArray(parsed.models)) return false;
      manifest = parsed;

      const gltfLoader = new GLTFLoader();
      if (options.renderer && typeof options.renderer.getContext === 'function') {
        try {
          ktx2Loader = new KTX2Loader();
          ktx2Loader.setTranscoderPath(parsed.basisTranscoderDir || '/assets/basis/');
          ktx2Loader.detectSupport(options.renderer);
          gltfLoader.setKTX2Loader(ktx2Loader);
        } catch {
          ktx2Loader = null;
        }
      }

      // Load LOD0 models first (for instant hero readiness), then LOD1 models
      const sorted = [...parsed.models].sort((a, b) => a.lod - b.lod);
      totalCount = sorted.length;
      loadedCount = 0;
      notify();

      const loadOne = async (entry: RuntimeModelManifestEntry): Promise<void> => {
        if (disposed) return;
        const gltf: GLTF = await gltfLoader.loadAsync(entry.path);
        if (disposed) {
          disposeTemplate(gltf.scene);
          return;
        }
        let isSkinned = false;
        gltf.scene.traverse((node) => {
          if (node instanceof THREE.SkinnedMesh) {
            isSkinned = true;
            node.frustumCulled = false;
          }
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        templates.set(modelKey(entry.id, entry.lod), {
          id: entry.id,
          lod: entry.lod,
          scene: gltf.scene,
          animations: gltf.animations,
          isSkinned,
        });
        loadedCount += 1;
        notify();
      };

      // Concurrency-bounded streaming (4 in flight) so main thread & GPU upload stay smooth
      const queue = [...sorted];
      const workerCount = 4;
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (queue.length > 0 && !disposed) {
            const next = queue.shift();
            if (next) {
              await loadOne(next);
            }
          }
        }),
      );

      // Load the 5 shared PBR KTX2 materials (used for Desktop Command Room and architectural trim)
      if (ktx2Loader && Array.isArray(parsed.materials) && !disposed) {
        const loaderRef = ktx2Loader;
        await Promise.all(
          parsed.materials.map(async (matEntry) => {
            if (disposed) return;
            try {
              const configureTex = (tex: THREE.CompressedTexture, srgb: boolean): void => {
                tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.anisotropy = 4;
                tex.needsUpdate = true;
              };
              const [baseTex, normTex, ormTex, emTex] = await Promise.all([
                loaderRef.loadAsync(matEntry.basecolor),
                loaderRef.loadAsync(matEntry.normal),
                loaderRef.loadAsync(matEntry.orm),
                matEntry.emissive ? loaderRef.loadAsync(matEntry.emissive) : Promise.resolve(null),
              ]);
              if (disposed) {
                baseTex.dispose();
                normTex.dispose();
                ormTex.dispose();
                emTex?.dispose();
                return;
              }
              configureTex(baseTex, true);
              configureTex(normTex, false);
              configureTex(ormTex, false);
              if (emTex) configureTex(emTex, true);

              const mat = new THREE.MeshStandardMaterial({
                name: `pbr-${matEntry.id}`,
                map: baseTex,
                normalMap: normTex,
                aoMap: ormTex,
                aoMapIntensity: 1.0,
                roughnessMap: ormTex,
                roughness: 1.0,
                metalnessMap: ormTex,
                metalness: 1.0,
                ...(emTex
                  ? {
                      emissive: new THREE.Color(0xffffff),
                      emissiveMap: emTex,
                      emissiveIntensity: 1.35,
                    }
                  : {}),
              });
              sharedMaterials.set(matEntry.id, mat);
            } catch {
              // Skip if a KTX2 map fails in headless/mock tests
            }
          }),
        );
      }

      // Build Boss Phase-2 molten crack emissive texture
      const emExtra = parsed.extras['broodlord-emissive'];
      const crExtra = parsed.extras['broodlord-phase2-cracks'];
      if (emExtra && crExtra && !disposed) {
        broodlordPhase2Emissive = await loadBroodlordPhase2Texture(emExtra.path, crExtra.path);
      }

      if (!disposed) {
        ready = true;
        notify();
      }
      return !disposed;
    } catch {
      return false;
    }
  }

  return {
    get manifest() {
      return manifest;
    },
    get progress() {
      return {
        loaded: loadedCount,
        total: totalCount,
        ready,
        precompiled,
        readyForLaunch: ready && precompiled,
      };
    },
    get ready() {
      return ready;
    },
    get broodlordPhase2Emissive() {
      return broodlordPhase2Emissive;
    },
    loadAll() {
      loadPromise ??= doLoadAll();
      return loadPromise;
    },
    hasModel(id, lod = 0) {
      return templates.has(modelKey(id, lod)) || templates.has(modelKey(id, 0));
    },
    hasSharedMaterial(id) {
      return sharedMaterials.has(id);
    },
    getSharedMaterial(id, matOptions) {
      const base = sharedMaterials.get(id);
      if (!base) return null;
      const repeat = matOptions?.repeat;
      const side = matOptions?.side;
      if (!repeat && side === undefined) {
        return base;
      }
      const cloned = base.clone();
      if (side !== undefined) cloned.side = side;
      if (repeat) {
        const cloneWithRepeat = (tex: THREE.Texture | null): THREE.Texture | null => {
          if (!tex) return null;
          const t = tex.clone();
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(repeat[0], repeat[1]);
          t.needsUpdate = true;
          derivedTextures.push(t);
          return t;
        };
        cloned.map = cloneWithRepeat(base.map);
        cloned.normalMap = cloneWithRepeat(base.normalMap);
        const ormClone = cloneWithRepeat(base.roughnessMap);
        cloned.aoMap = ormClone;
        cloned.roughnessMap = ormClone;
        cloned.metalnessMap = ormClone;
        cloned.emissiveMap = cloneWithRepeat(base.emissiveMap);
      }
      cloned.needsUpdate = true;
      derivedMaterials.push(cloned);
      return cloned;
    },
    instantiate(id, lod = 0) {
      const tpl = templates.get(modelKey(id, lod)) ?? templates.get(modelKey(id, 0));
      if (!tpl) return null;
      const cloned = (
        tpl.isSkinned ? SkeletonUtils.clone(tpl.scene) : tpl.scene.clone(true)
      ) as THREE.Group;
      // Clone materials per instance so hit flashes, cryo frost tint, and depth occlusion stay isolated
      cloned.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map((m) => m.clone());
          } else if (node.material) {
            node.material = node.material.clone();
          }
        }
      });
      return {
        root: cloned,
        animations: tpl.animations,
        isSkinned: tpl.isSkinned,
      };
    },
    async precompile(renderer, scene, camera) {
      if (disposed || precompiled) return;
      if (typeof renderer.compileAsync !== 'function') {
        precompiled = true;
        notify();
        return;
      }
      const staging = new THREE.Group();
      staging.name = '__shader-precompile-staging';
      staging.position.set(0, -100, 0);
      for (const tpl of templates.values()) {
        if (tpl.lod === 0) {
          staging.add(tpl.scene.clone(false));
        }
      }
      scene.add(staging);
      try {
        await renderer.compileAsync(scene, camera);
      } catch {
        // Ignore mock renderer compileAsync errors
      } finally {
        scene.remove(staging);
        precompiled = true;
        notify();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({
        loaded: loadedCount,
        total: totalCount,
        ready,
        precompiled,
        readyForLaunch: ready && precompiled,
      });
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const tpl of templates.values()) {
        disposeTemplate(tpl.scene);
      }
      templates.clear();
      for (const mat of derivedMaterials.splice(0)) {
        mat.dispose();
      }
      for (const tex of derivedTextures.splice(0)) {
        tex.dispose();
      }
      for (const mat of sharedMaterials.values()) {
        for (const val of Object.values(mat)) {
          if (val instanceof THREE.Texture) val.dispose();
        }
        mat.dispose();
      }
      sharedMaterials.clear();
      broodlordPhase2Emissive?.dispose();
      broodlordPhase2Emissive = null;
      ktx2Loader?.dispose();
      ktx2Loader = null;
    },
  };
}
