import * as THREE from 'three';

export interface TacticalIconAtlas {
  readonly texture: THREE.Texture;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly icons: Readonly<Record<string, { rect: [number, number, number, number] }>>;
}

/** Loads the promoted tactical icon atlas once. Labels remain available while it is absent. */
export function createTacticalAtlas() {
  const controller = new AbortController();
  let result: Promise<TacticalIconAtlas | null> | undefined;
  let atlas: TacticalIconAtlas | null = null;
  let bitmap: ImageBitmap | undefined;

  async function load(): Promise<TacticalIconAtlas | null> {
    try {
      const link = document.querySelector<HTMLLinkElement>('link[rel="rift-tactical-atlas"]');
      if (!link || typeof createImageBitmap !== 'function' || controller.signal.aborted)
        return null;
      const manifestURL = new URL(link.href, document.baseURI);
      if (manifestURL.origin !== location.origin) return null;
      const options = { signal: controller.signal };
      const manifest = await fetch(manifestURL, options);
      if (!manifest.ok || !manifest.headers.get('content-type')?.includes('json')) return null;
      const data = await manifest.json();
      if (data.atlas !== 'tactical-atlas.png' || data.width !== 768 || data.height !== 384)
        return null;
      for (const entry of Object.values(data.icons) as { rect: number[] }[]) {
        const [x, y, w, h] = entry.rect;
        if (
          entry.rect.length !== 4 ||
          !entry.rect.every(Number.isInteger) ||
          w !== 128 ||
          h !== 128 ||
          x < 0 ||
          y < 0 ||
          x + w > data.width ||
          y + h > data.height
        )
          return null;
      }
      const url = new URL(data.atlas, manifestURL).href;
      const response = await fetch(url, options);
      if (!response.ok) return null;
      const decoded = await createImageBitmap(await response.blob(), {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
      });
      if (
        controller.signal.aborted ||
        decoded.width !== data.width ||
        decoded.height !== data.height
      ) {
        decoded.close();
        return null;
      }
      bitmap = decoded;
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      atlas = { texture, url, width: data.width, height: data.height, icons: data.icons };
      return atlas;
    } catch {
      return null;
    }
  }

  return {
    get() {
      if (controller.signal.aborted) return Promise.resolve(null);
      result ??= load();
      return result;
    },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      atlas?.texture.dispose();
      bitmap?.close();
      bitmap = undefined;
      atlas = null;
      result = undefined;
    },
  };
}
export type TacticalAtlasResource = ReturnType<typeof createTacticalAtlas>;
