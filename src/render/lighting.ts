/**
 * AAA Tactical Lighting & Transient Dynamic Point-Light Pool (`src/render/lighting.ts`, P4-T2).
 *
 * Provides:
 * - Procedural PMREM IBL reflections (RoomEnvironment tuned for brushed titanium & matte ceramic
 *   in both Desktop and XR passthrough without heavy HDR downloads).
 * - Tuned 1024×1024 PCFSoftShadowMap key light, cool tactical hemisphere fill, cyan rim light,
 *   and Core Bastion ambient point glow.
 * - Pre-allocated pool of `<= 2` transient dynamic `PointLight` instances for Plasma Mortar
 *   explosions, Rail Sniper impacts, Disruptor EMP surges, and Apex Broodlord Phase-2 shifts
 *   (zero runtime light additions or shader recompilations).
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GAMEPLAY_OBJECT_SCALE, type Vec3 } from '../content/index.ts';
import type { RoomSurface } from '../mr/room-scan.ts';

export const MAX_TRANSIENT_POINT_LIGHTS = 2;

interface TransientLightSlot {
  readonly light: THREE.PointLight;
  elapsedSec: number;
  durationSec: number;
  peakIntensity: number;
}

interface WallFlashSlot {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  elapsedSec: number;
  durationSec: number;
  peakOpacity: number;
  wallId: string | null;
}

interface WallReceiver {
  readonly surface: RoomSurface;
  readonly geometry: THREE.BufferGeometry;
  readonly worldToWall: THREE.Matrix4;
}

function createReceiverGeometry(surface: RoomSurface): THREE.BufferGeometry {
  const outline = surface.localPolygon.map(({ x, z }) => new THREE.Vector2(x, z));
  const triangles = THREE.ShapeUtils.triangulateShape(outline, []);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      surface.localPolygon.flatMap(({ x, z }) => [x, 0, z]),
      3,
    ),
  );
  geometry.setIndex(triangles.flat());
  return geometry;
}

function closestPolygonPoint(
  x: number,
  z: number,
  polygon: readonly { readonly x: number; readonly z: number }[],
): { x: number; z: number; distanceSq: number } {
  let best = { x, z, distanceSq: Number.POSITIVE_INFINITY };
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as { x: number; z: number };
    const b = polygon[(i + 1) % polygon.length] as { x: number; z: number };
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(
      0,
      Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)),
    );
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const distanceSq = (x - px) ** 2 + (z - pz) ** 2;
    if (distanceSq < best.distanceSq) best = { x: px, z: pz, distanceSq };
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i] as { x: number; z: number };
    const b = polygon[j] as { x: number; z: number };
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside ? { x, z, distanceSq: 0 } : best;
}

export interface LightingController {
  readonly group: THREE.Group;
  readonly keyLight: THREE.DirectionalLight;
  readonly coreGlowLight: THREE.PointLight;
  readonly envTexture: THREE.Texture | null;
  setCorePosition(position: Readonly<Vec3>): void;
  setCoreState(hpRatio: number, isHitFlash: boolean): void;
  flashPoint(
    position: Readonly<Vec3>,
    colorHex: number,
    peakIntensity?: number,
    distanceM?: number,
    durationSec?: number,
  ): void;
  syncRoomSurfaces(surfaces: readonly RoomSurface[]): void;
  update(dt: number): void;
  dispose(): void;
}

export function createLightingController(
  scene: THREE.Scene,
  renderer?: THREE.WebGLRenderer | null,
): LightingController {
  const group = new THREE.Group();
  group.name = 'rift-bastion-aaa-lighting';

  // Cool tactical skylight + dark slate ground bounce for legible PBR metals in MR passthrough
  const hemi = new THREE.HemisphereLight('#b8d8ff', '#16202e', 0.9);
  hemi.name = 'aaa-hemi-light';
  group.add(hemi);

  const keyLight = new THREE.DirectionalLight('#f8fafc', 1.75);
  keyLight.name = 'aaa-key-light';
  const keyLightOffset = new THREE.Vector3(2.2, 3.6, 1.8);
  keyLight.position.copy(keyLightOffset);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 10;
  keyLight.shadow.camera.left = -3.2;
  keyLight.shadow.camera.right = 3.2;
  keyLight.shadow.camera.top = 3.2;
  keyLight.shadow.camera.bottom = -3.2;
  keyLight.shadow.radius = 2.5;
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.normalBias = 0.025;
  group.add(keyLight);
  group.add(keyLight.target);

  const rimLight = new THREE.DirectionalLight('#38bdf8', 0.65);
  rimLight.name = 'aaa-rim-light';
  rimLight.position.set(-2.6, 2.3, -2.2);
  group.add(rimLight);

  const coreGlowLight = new THREE.PointLight('#8b5cf6', 1.25, 3.4, 1.8);
  coreGlowLight.name = 'aaa-core-glow-light';
  coreGlowLight.position.set(0, 1.25, 0);
  group.add(coreGlowLight);

  // Pre-allocated transient dynamic point lights (kept at intensity 0 when idle so shader count stays fixed)
  const slots: TransientLightSlot[] = [];
  for (let i = 0; i < MAX_TRANSIENT_POINT_LIGHTS; i += 1) {
    const light = new THREE.PointLight(0xff5722, 0, 3.2, 2.0);
    light.name = `aaa-transient-point-light-${i}`;
    light.position.set(0, -10, 0);
    group.add(light);
    slots.push({
      light,
      elapsedSec: 1,
      durationSec: 1,
      peakIntensity: 0,
    });
  }

  const emptyWallGeometry = new THREE.BufferGeometry();
  const wallFlashes: WallFlashSlot[] = [];
  for (let i = 0; i < MAX_TRANSIENT_POINT_LIGHTS; i += 1) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x55dfff) },
        uOpacity: { value: 0 },
        uSource: { value: new THREE.Vector3() },
        uRadius: { value: 1 },
      },
      vertexShader: `
        varying vec3 vWall;
        void main() {
          vWall = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform vec3 uSource;
        uniform float uRadius;
        varying vec3 vWall;
        void main() {
          vec3 delta = uSource - vWall;
          float metres = length(delta);
          float edge = 1.0 - smoothstep(0.0, uRadius, metres);
          float incidence = abs(delta.y) / max(metres, 0.06);
          float intensity = uOpacity * edge * edge * mix(0.6, 1.0, incidence);
          gl_FragColor = vec4(uColor, intensity);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    material.forceSinglePass = true;
    const mesh = new THREE.Mesh(emptyWallGeometry, material);
    mesh.name = `aaa-mr-wall-flash-${i}`;
    mesh.visible = false;
    mesh.renderOrder = 2;
    mesh.raycast = () => undefined;
    group.add(mesh);
    wallFlashes.push({ mesh, elapsedSec: 1, durationSec: 1, peakOpacity: 0, wallId: null });
  }

  scene.add(group);

  let envRenderTarget: THREE.WebGLRenderTarget | null = null;
  if (renderer && typeof renderer.getContext === 'function') {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      envRenderTarget = pmrem.fromScene(envScene, 0.04);
      scene.environment = envRenderTarget.texture;
      scene.environmentIntensity = 0.85;
      envScene.dispose();
      pmrem.dispose();
    } catch {
      // Headless / mock renderers skip PMREM generation.
    }
  }

  let nextSlot = 0;
  let nextWallFlashSlot = 0;
  let disposed = false;
  const walls = new Map<string, WallReceiver>();
  const wallWorldPoint = new THREE.Vector3();
  const wallLocalPoint = new THREE.Vector3();

  function attachFlash(slot: WallFlashSlot, wall: WallReceiver): void {
    slot.mesh.geometry = wall.geometry;
    slot.mesh.position
      .setFromMatrixPosition(wall.surface.worldMatrix)
      .addScaledVector(
        wall.surface.normal,
        0.004 * (slot.mesh.material.uniforms.uSource.value.y < 0 ? -1 : 1),
      );
    slot.mesh.quaternion.setFromRotationMatrix(wall.surface.worldMatrix);
  }

  function hideFlash(slot: WallFlashSlot): void {
    slot.wallId = null;
    slot.mesh.visible = false;
    slot.mesh.geometry = emptyWallGeometry;
    slot.mesh.material.uniforms.uOpacity.value = 0;
    slot.elapsedSec = slot.durationSec;
  }

  return {
    group,
    keyLight,
    coreGlowLight,
    get envTexture() {
      return envRenderTarget?.texture ?? null;
    },
    setCorePosition(position) {
      coreGlowLight.position.set(position.x, position.y + 0.56 * GAMEPLAY_OBJECT_SCALE, position.z);
      keyLight.target.position.set(position.x, position.y, position.z);
      keyLight.position.set(
        position.x + keyLightOffset.x,
        position.y + keyLightOffset.y,
        position.z + keyLightOffset.z,
      );
    },
    setCoreState(hpRatio, isHitFlash) {
      if (isHitFlash) {
        coreGlowLight.color.setHex(0xff3b5c);
        coreGlowLight.intensity = 2.6;
      } else if (hpRatio < 0.35) {
        coreGlowLight.color.setHex(0xff6b35);
        coreGlowLight.intensity = 1.6;
      } else {
        coreGlowLight.color.setHex(0x8b5cf6);
        coreGlowLight.intensity = 1.25;
      }
    },
    flashPoint(position, colorHex, peakIntensity = 4.2, distanceM = 3.2, durationSec = 0.34) {
      if (disposed) return;
      // Prefer an inactive slot; otherwise recycle oldest slot
      let slot = slots.find((s) => s.elapsedSec >= s.durationSec);
      if (!slot) {
        slot = slots[nextSlot % slots.length] as TransientLightSlot;
        nextSlot = (nextSlot + 1) % slots.length;
      }
      slot.light.position.set(position.x, position.y + 0.14, position.z);
      slot.light.color.setHex(colorHex);
      slot.light.distance = distanceM;
      slot.light.intensity = peakIntensity;
      slot.peakIntensity = peakIntensity;
      slot.elapsedSec = 0;
      slot.durationSec = Math.max(0.05, durationSec);

      const radius = Math.min(1.7, Math.max(0.55, distanceM * 0.48));
      wallWorldPoint.set(position.x, position.y, position.z);
      let wall: WallReceiver | undefined;
      let nearestDistanceSq = radius * radius;
      for (const candidate of walls.values()) {
        wallLocalPoint.copy(wallWorldPoint).applyMatrix4(candidate.worldToWall);
        const nearest = closestPolygonPoint(
          wallLocalPoint.x,
          wallLocalPoint.z,
          candidate.surface.localPolygon,
        );
        const distanceSq = wallLocalPoint.y ** 2 + nearest.distanceSq;
        if (distanceSq < nearestDistanceSq) {
          nearestDistanceSq = distanceSq;
          wall = candidate;
        }
      }
      if (!wall) return;
      const wallSlot =
        wallFlashes.find((candidate) => !candidate.mesh.visible) ??
        (wallFlashes[nextWallFlashSlot++ % wallFlashes.length] as WallFlashSlot);
      const uniforms = wallSlot.mesh.material.uniforms;
      uniforms.uSource.value.copy(wallWorldPoint).applyMatrix4(wall.worldToWall);
      uniforms.uColor.value.setHex(colorHex);
      uniforms.uRadius.value = radius;
      wallSlot.peakOpacity = Math.min(0.22, peakIntensity * 0.042);
      uniforms.uOpacity.value = wallSlot.peakOpacity;
      wallSlot.wallId = wall.surface.id;
      wallSlot.elapsedSec = 0;
      wallSlot.durationSec = Math.max(0.08, durationSec);
      attachFlash(wallSlot, wall);
      wallSlot.mesh.visible = true;
    },
    syncRoomSurfaces(surfaces) {
      const seenWalls = new Set<string>();
      for (const surface of surfaces) {
        if (
          surface.kind !== 'wall' ||
          surface.source === 'virtual' ||
          surface.localPolygon.length < 3
        )
          continue;
        seenWalls.add(surface.id);
        const current = walls.get(surface.id);
        if (current?.surface === surface) continue;
        current?.geometry.dispose();
        const wall = {
          surface,
          geometry: createReceiverGeometry(surface),
          worldToWall: surface.worldMatrix.clone().invert(),
        };
        walls.set(surface.id, wall);
        for (const slot of wallFlashes) if (slot.wallId === surface.id) attachFlash(slot, wall);
      }
      for (const [id, wall] of walls) {
        if (seenWalls.has(id)) continue;
        for (const slot of wallFlashes) if (slot.wallId === id) hideFlash(slot);
        wall.geometry.dispose();
        walls.delete(id);
      }
    },
    update(dt) {
      if (disposed || dt <= 0) return;
      for (const slot of slots) {
        if (slot.elapsedSec < slot.durationSec) {
          slot.elapsedSec += dt;
          const t = THREE.MathUtils.clamp(slot.elapsedSec / slot.durationSec, 0, 1);
          const falloff = (1 - t) * (1 - t);
          slot.light.intensity = slot.peakIntensity * falloff;
        } else if (slot.light.intensity !== 0) {
          slot.light.intensity = 0;
        }
      }
      for (const slot of wallFlashes) {
        if (!slot.mesh.visible) continue;
        slot.elapsedSec += dt;
        if (slot.elapsedSec >= slot.durationSec) hideFlash(slot);
        else
          slot.mesh.material.uniforms.uOpacity.value =
            slot.peakOpacity * (1 - slot.elapsedSec / slot.durationSec) ** 2;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (envRenderTarget) {
        if (scene.environment === envRenderTarget.texture) {
          scene.environment = null;
        }
        envRenderTarget.dispose();
        envRenderTarget = null;
      }
      emptyWallGeometry.dispose();
      for (const wall of walls.values()) wall.geometry.dispose();
      walls.clear();
      for (const slot of wallFlashes) slot.mesh.material.dispose();
      group.clear();
      group.removeFromParent();
    },
  };
}
