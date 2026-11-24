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

export const MAX_TRANSIENT_POINT_LIGHTS = 2;

interface TransientLightSlot {
  readonly light: THREE.PointLight;
  elapsedSec: number;
  durationSec: number;
  peakIntensity: number;
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
  let disposed = false;

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
      group.clear();
      group.removeFromParent();
    },
  };
}
