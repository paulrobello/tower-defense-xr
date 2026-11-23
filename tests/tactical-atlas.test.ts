import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../assets-source/ui/candidates/atlas.json';
import { createTacticalAtlas } from '../src/ui/tactical-atlas.ts';
import { buildBuildWheelItems, buildTurretCommandWheelItems } from '../src/xr/radial-controls.ts';

function registerAtlas() {
  const link = document.createElement('link');
  link.rel = 'rift-tactical-atlas';
  link.href = '/assets/ui/atlas.json';
  document.head.append(link);
}
afterEach(() => {
  for (const link of document.head.querySelectorAll('link[rel="rift-tactical-atlas"]')) {
    link.remove();
  }
  vi.unstubAllGlobals();
});

describe('Bastion tactical atlas', () => {
  it('preserves the text-only baseline without issuing missing requests', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const resource = createTacticalAtlas();
    expect(await resource.get()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    resource.dispose();
  });
  it('reuses one decode, releases its image and GPU texture and covers every wheel mapping', async () => {
    registerAtlas();
    const bitmap = { width: 768, height: 384, close: vi.fn() };
    const decode = vi.fn(async () => bitmap);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(new Response(new Blob()));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('createImageBitmap', decode);
    const resource = createTacticalAtlas();
    expect(resource.get()).toBe(resource.get());
    const atlas = await resource.get();
    expect(atlas).not.toBeNull();
    const build = buildBuildWheelItems({ credits: 500, activeTurretCount: 0 });
    for (const item of build)
      expect(atlas?.icons[item.icon]).toEqual(expect.objectContaining({ rect: expect.any(Array) }));
    for (const tier of ['T1', 'T2', 'T3'] as const) {
      for (const priority of ['first', 'strongest', 'closest', 'air'] as const) {
        const turret = { id: 'test', kind: 'autocannon' as const, tier, priority };
        const items = buildTurretCommandWheelItems(turret, 500);
        for (const item of items) expect(atlas?.icons[item.icon]).toBeDefined();
        expect(items[0]?.icon).toBe(tier === 'T1' ? 'tier-2' : 'tier-3');
        expect(items[1]?.icon).toBe(`target-${priority}`);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    const onDispose = vi.fn();
    atlas?.texture.addEventListener('dispose', onDispose);
    resource.dispose();
    resource.dispose();
    expect(await resource.get()).toBeNull();
    expect(onDispose).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('rejects a bad cell before texture allocation', async () => {
    registerAtlas();
    const fetcher = vi.fn(async () =>
      Response.json({ ...manifest, icons: { bad: { rect: [750, 0, 128, 128] } } }),
    );
    const decode = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('createImageBitmap', decode);
    const resource = createTacticalAtlas();
    expect(await resource.get()).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    resource.dispose();
  });
  it('closes a bitmap that arrives after disposal', async () => {
    registerAtlas();
    const bitmap = { width: 768, height: 384, close: vi.fn() };
    let complete: (image: typeof bitmap) => void = () => {};
    const decode = vi.fn(
      () =>
        new Promise<typeof bitmap>((resolve) => {
          complete = resolve;
        }),
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(new Response(new Blob()));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('createImageBitmap', decode);
    const resource = createTacticalAtlas();
    const loading = resource.get();
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    resource.dispose();
    complete(bitmap);
    expect(await loading).toBeNull();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
