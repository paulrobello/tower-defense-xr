import { createScalableLabel } from '@par/xr-workspace';
import * as THREE from 'three';
import type { TacticalAtlasResource } from '../ui/tactical-atlas.ts';
import type { RadialItemDescriptor } from './radial-controls.ts';

export const BASTION_RADIAL_THEME = {
  glass: '#26323d',
  selected: '#16768b',
  cancel: '#151e27',
  text: '#f0f5f7',
  outline: '#8a9ba7',
};

/** Subtle directional grain shared by the gunmetal wedge faces. */
function brushedSurface(): THREE.DataTexture {
  const width = 32;
  const height = 64;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shade = 215 + ((y * 43 + Math.floor(x / 9)) % 29);
      const offset = (y * width + x) * 4;
      pixels.set([shade, shade, shade, 255], offset);
    }
  }
  const grain = new THREE.DataTexture(pixels, width, height);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(3, 6);
  grain.generateMipmaps = true;
  grain.minFilter = THREE.LinearMipmapLinearFilter;
  grain.magFilter = THREE.LinearFilter;
  grain.needsUpdate = true;
  return grain;
}

export function skinRadialMenu(
  root: THREE.Group,
  items: readonly RadialItemDescriptor[],
  atlas: TacticalAtlasResource,
) {
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const disabled: THREE.MeshBasicMaterial[] = [];
  const fills: THREE.MeshBasicMaterial[] = [];
  let settled = false;
  let disposed = false;
  const grain = brushedSurface();
  let iconMaterial: THREE.MeshBasicMaterial | undefined;
  const contents = root.getObjectByName('radial-menu-contents');
  const noHit = () => {};
  for (const group of contents?.children ?? []) {
    const action = group.userData.radialAction;
    const label = group.children.find((child) => child.userData.labelTextObject);
    const fill = group.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        !child.userData.labelTextObject &&
        child.name !== 'radial-outline',
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined;
    if (!label || !fill) continue;
    const outline = group.getObjectByName('radial-outline');
    if (outline) {
      outline.position.z = 0.001;
      outline.renderOrder = 1;
      (outline as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.depthTest =
        false;
    }
    fills.push(fill.material);
    fill.material.map = grain;
    fill.material.depthTest = false;
    fill.material.needsUpdate = true;
    const title = label.userData.labelTextObject;
    title.position.z = 0.005;
    title.renderOrder = 4;
    if (action === 'cancel') {
      const trim = new THREE.Mesh(
        new THREE.RingGeometry(0.082, 0.088, 8),
        new THREE.MeshBasicMaterial({
          color: '#a1aeb5',
          transparent: true,
          depthTest: false,
          depthWrite: false,
          vertexColors: true,
        }),
      );
      const positions = trim.geometry.getAttribute('position');
      const sheen = [];
      for (let i = 0; i < positions.count; i++) {
        const light = 0.65 + (0.3 * (positions.getY(i) - positions.getX(i))) / 0.13;
        sheen.push(light, light, light);
      }
      trim.geometry.setAttribute('color', new THREE.Float32BufferAttribute(sheen, 3));
      trim.name = 'bastion-hub-bezel';
      trim.position.z = 0.002;
      trim.raycast = noHit;
      trim.renderOrder = 2;
      group.add(trim);
      materials.push(trim.material);
      geometries.push(trim.geometry);
      continue;
    }
    const item = items.find((entry) => entry.id === action);
    if (!item) continue;
    if (item.disabled) disabled.push(fill.material);
    const detail = item.label.split('\n')[1];
    if (detail) {
      const badge = createScalableLabel(detail, 0.167, 0.032, {
        backplate: false,
        fontSize: 0.019,
      });
      badge.name = 'bastion-cost-badge';
      badge.position.set(0, -0.043, 0.006);
      badge.raycast = noHit;
      const text = badge.userData.labelTextObject;
      text.color = item.disabled ? '#ffb3bd' : action === 'turret:priority' ? '#9be5ef' : '#ffd278';
      text.renderOrder = 4;
      text.sync();
      label.add(badge);
    }
    void atlas.get().then((loaded) => {
      if (disposed || !loaded || !item.icon) return;
      const cell = loaded.icons[item.icon];
      if (!cell) return;
      const [x, y, w, h] = cell.rect;
      const geometry = new THREE.PlaneGeometry(0.068, 0.068);
      const uv = geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(
          i,
          (x + uv.getX(i) * w) / loaded.width,
          1 - (y + (1 - uv.getY(i)) * h) / loaded.height,
        );
      }
      iconMaterial ??= new THREE.MeshBasicMaterial({
        map: loaded.texture,
        depthTest: false,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const decal = new THREE.Mesh(geometry, iconMaterial);
      decal.name = `bastion-icon-${item.icon}`;
      decal.position.set(0, 0.047, 0.007);
      decal.renderOrder = 3;
      decal.raycast = noHit;
      title.position.y = -0.009;
      label.add(decal);
      geometries.push(geometry);
    });
  }
  return {
    settle() {
      if (settled) return;
      settled = true;
      for (const fill of fills) fill.opacity = 1;
    },
    applyDisabled() {
      for (const material of disabled) material.color.setHex(0x672d40);
    },
    dispose() {
      disposed = true;
      iconMaterial?.dispose();
      grain.dispose();
      for (const mesh of geometries) mesh.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
