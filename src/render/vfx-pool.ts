/**
 * GPU-Instanced AAA Combat VFX & Particle Pools (`src/render/vfx-pool.ts`, P4-T3).
 *
 * Pre-allocated zero-GC ring buffers across `InstancedMesh` batches (`<= 2,500` total active
 * particles, `<= 5` extra draw calls):
 * - **Sparks / Debris / Ice Shards / Shell Casings (`sparkPool`, up to 1,400 instances):**
 *   ballistic gravity-affected particles for muzzle sparks, chitin/ichor impact bursts, enemy death
 *   shatters, brass shell-casing ejections, and cryo ice-crystal bursts.
 * - **Muzzle Flash Starbursts (`flashPool`, up to 160 instances):**
 *   short high-energy glowing bursts at firing muzzles and rail impact exit flashes.
 * - **Shockwave & Ionized Smoke Rings (`ringPool`, up to 120 instances):**
 *   expanding plasma detonations, rail sniper ionized rings along the beam, Disruptor EMP pulses,
 *   and Core Bastion shield ripples.
 * - **Scorch / Burn / Frost Floor Decals (`decalPool`, up to 96 instances):**
 *   lingering molten ember marks from Plasma Mortar impacts and frost patches from Cryo-Arc hits.
 */

import * as THREE from 'three';
import type { Vec3 } from '../content/index.ts';
import {
  applyDepthOcclusion,
  type DepthOcclusionBinding,
  type OcclusionController,
} from '../mr/occlusion.ts';

export const MAX_VFX_SPARKS = 1400;
export const MAX_VFX_FLASHES = 160;
export const MAX_VFX_RINGS = 120;
export const MAX_VFX_DECALS = 96;
export const MAX_TOTAL_VFX_CAP = MAX_VFX_SPARKS + MAX_VFX_FLASHES + MAX_VFX_RINGS + MAX_VFX_DECALS;

interface SparkSlot {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotY: number;
  rotSpeed: number;
  elapsedSec: number;
  durationSec: number;
  colorHex: number;
}

interface FlashSlot {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  maxScale: number;
  rotZ: number;
  elapsedSec: number;
  durationSec: number;
  colorHex: number;
}

interface RingSlot {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  startRadius: number;
  endRadius: number;
  elapsedSec: number;
  durationSec: number;
  colorHex: number;
}

interface DecalSlot {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  radius: number;
  elapsedSec: number;
  durationSec: number;
  colorHex: number;
}

export interface VfxPoolStats {
  readonly activeSparks: number;
  readonly activeFlashes: number;
  readonly activeRings: number;
  readonly activeDecals: number;
  readonly totalActive: number;
}

export interface CombatVfxPool {
  readonly group: THREE.Group;
  readonly stats: Readonly<VfxPoolStats>;
  readonly drawCallCount: number;
  spawnMuzzleFlash(position: Readonly<Vec3>, colorHex: number, scale?: number): void;
  spawnShellCasing(position: Readonly<Vec3>, direction: Readonly<Vec3>): void;
  spawnImpactBurst(
    position: Readonly<Vec3>,
    colorHex: number,
    count?: number,
    speed?: number,
    scale?: number,
  ): void;
  spawnDeathBurst(position: Readonly<Vec3>, colorHex: number, isBoss?: boolean): void;
  spawnPlasmaExplosion(position: Readonly<Vec3>, radiusM: number): void;
  spawnRailRings(from: Readonly<Vec3>, to: Readonly<Vec3>, colorHex?: number): void;
  spawnShockRing(
    position: Readonly<Vec3>,
    normal: Readonly<Vec3>,
    endRadiusM: number,
    colorHex: number,
    durationSec?: number,
  ): void;
  tick(dt: number): void;
  clear(): void;
  dispose(): void;
}

const _obj = new THREE.Object3D();
const _color = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _nrm = new THREE.Vector3();
const _quat = new THREE.Quaternion();

export function createCombatVfxPool(
  parent: THREE.Object3D,
  occlusion?: OcclusionController | null,
): CombatVfxPool {
  const group = new THREE.Group();
  group.name = 'aaa-combat-vfx-pool';
  parent.add(group);

  const bindings: DepthOcclusionBinding[] = [];
  const trackMat = <T extends THREE.Material>(mat: T): T => {
    if (occlusion) {
      bindings.push(applyDepthOcclusion(mat, occlusion, { role: 'world-object' }));
    }
    return mat;
  };

  // 1. Sparks / debris / casings / ice shards
  const sparkGeo = new THREE.BoxGeometry(1, 1, 1);
  const sparkMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_VFX_SPARKS);
  sparkMesh.name = 'vfx-instanced-sparks';
  sparkMesh.count = 0;
  sparkMesh.frustumCulled = false;

  // 2. Muzzle / impact starburst flashes
  const flashGeo = new THREE.OctahedronGeometry(1, 0);
  const flashMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const flashMesh = new THREE.InstancedMesh(flashGeo, flashMat, MAX_VFX_FLASHES);
  flashMesh.name = 'vfx-instanced-flashes';
  flashMesh.count = 0;
  flashMesh.frustumCulled = false;

  // 3. Expanding shockwave & rail ionized rings
  const ringGeo = new THREE.RingGeometry(0.76, 1.0, 24);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, MAX_VFX_RINGS);
  ringMesh.name = 'vfx-instanced-rings';
  ringMesh.count = 0;
  ringMesh.frustumCulled = false;

  // 4. Lingering scorch/ember/frost surface decals
  const decalGeo = new THREE.CircleGeometry(1, 20);
  decalGeo.rotateX(-Math.PI / 2);
  const decalMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );
  const decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, MAX_VFX_DECALS);
  decalMesh.name = 'vfx-instanced-decals';
  decalMesh.count = 0;
  decalMesh.frustumCulled = false;

  group.add(sparkMesh, flashMesh, ringMesh, decalMesh);

  // Pre-allocate ring buffers (zero runtime allocations in steady-state tick!)
  const sparks: SparkSlot[] = Array.from({ length: MAX_VFX_SPARKS }, () => ({
    active: false,
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: -5.5,
    scaleX: 0.015,
    scaleY: 0.015,
    scaleZ: 0.04,
    rotY: 0,
    rotSpeed: 0,
    elapsedSec: 0,
    durationSec: 0.35,
    colorHex: 0xffffff,
  }));
  const flashes: FlashSlot[] = Array.from({ length: MAX_VFX_FLASHES }, () => ({
    active: false,
    px: 0,
    py: 0,
    pz: 0,
    maxScale: 0.08,
    rotZ: 0,
    elapsedSec: 0,
    durationSec: 0.08,
    colorHex: 0xffffff,
  }));
  const rings: RingSlot[] = Array.from({ length: MAX_VFX_RINGS }, () => ({
    active: false,
    px: 0,
    py: 0,
    pz: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    startRadius: 0.05,
    endRadius: 0.5,
    elapsedSec: 0,
    durationSec: 0.32,
    colorHex: 0xffffff,
  }));
  const decals: DecalSlot[] = Array.from({ length: MAX_VFX_DECALS }, () => ({
    active: false,
    px: 0,
    py: 0,
    pz: 0,
    radius: 0.3,
    elapsedSec: 0,
    durationSec: 4.5,
    colorHex: 0xff5722,
  }));

  let sparkCursor = 0;
  let flashCursor = 0;
  let ringCursor = 0;
  let decalCursor = 0;
  let rngState = 0x9e3779b9;
  let disposed = false;

  let stats: VfxPoolStats = {
    activeSparks: 0,
    activeFlashes: 0,
    activeRings: 0,
    activeDecals: 0,
    totalActive: 0,
  };

  function nextRand(): number {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 4294967296;
  }

  function allocSpark(): SparkSlot {
    const slot = sparks[sparkCursor] as SparkSlot;
    sparkCursor = (sparkCursor + 1) % MAX_VFX_SPARKS;
    slot.active = true;
    slot.elapsedSec = 0;
    return slot;
  }

  function allocFlash(): FlashSlot {
    const slot = flashes[flashCursor] as FlashSlot;
    flashCursor = (flashCursor + 1) % MAX_VFX_FLASHES;
    slot.active = true;
    slot.elapsedSec = 0;
    return slot;
  }

  function allocRing(): RingSlot {
    const slot = rings[ringCursor] as RingSlot;
    ringCursor = (ringCursor + 1) % MAX_VFX_RINGS;
    slot.active = true;
    slot.elapsedSec = 0;
    return slot;
  }

  function allocDecal(): DecalSlot {
    const slot = decals[decalCursor] as DecalSlot;
    decalCursor = (decalCursor + 1) % MAX_VFX_DECALS;
    slot.active = true;
    slot.elapsedSec = 0;
    return slot;
  }

  function spawnMuzzleFlash(position: Readonly<Vec3>, colorHex: number, scale = 0.085): void {
    if (disposed) return;
    const slot = allocFlash();
    slot.px = position.x;
    slot.py = position.y;
    slot.pz = position.z;
    slot.maxScale = scale;
    slot.rotZ = nextRand() * Math.PI * 2;
    slot.durationSec = 0.085;
    slot.colorHex = colorHex;
  }

  function spawnShellCasing(position: Readonly<Vec3>, direction: Readonly<Vec3>): void {
    if (disposed) return;
    const slot = allocSpark();
    // Eject slightly to the right & upward of the firing barrel
    const rx = -direction.z;
    const rz = direction.x;
    slot.px = position.x;
    slot.py = position.y;
    slot.pz = position.z;
    slot.vx = rx * (0.6 + nextRand() * 0.4) + (nextRand() - 0.5) * 0.2;
    slot.vy = 0.65 + nextRand() * 0.45;
    slot.vz = rz * (0.6 + nextRand() * 0.4) + (nextRand() - 0.5) * 0.2;
    slot.gravity = -6.8;
    slot.scaleX = 0.008;
    slot.scaleY = 0.008;
    slot.scaleZ = 0.022;
    slot.rotY = nextRand() * Math.PI * 2;
    slot.rotSpeed = 14;
    slot.durationSec = 0.48;
    slot.colorHex = 0xfbbf24;
  }

  function spawnImpactBurst(
    position: Readonly<Vec3>,
    colorHex: number,
    count = 8,
    speed = 1.9,
    scale = 0.018,
  ): void {
    if (disposed) return;
    for (let i = 0; i < count; i += 1) {
      const slot = allocSpark();
      const theta = nextRand() * Math.PI * 2;
      const elev = (nextRand() - 0.15) * Math.PI * 0.55;
      const spd = speed * (0.45 + nextRand() * 0.75);
      slot.px = position.x;
      slot.py = position.y;
      slot.pz = position.z;
      slot.vx = Math.cos(theta) * Math.cos(elev) * spd;
      slot.vy = Math.sin(elev) * spd + 0.35;
      slot.vz = Math.sin(theta) * Math.cos(elev) * spd;
      slot.gravity = -4.6;
      slot.scaleX = scale;
      slot.scaleY = scale;
      slot.scaleZ = scale * 2.2;
      slot.rotY = theta;
      slot.rotSpeed = (nextRand() - 0.5) * 10;
      slot.durationSec = 0.22 + nextRand() * 0.22;
      slot.colorHex = colorHex;
    }
  }

  function spawnDeathBurst(position: Readonly<Vec3>, colorHex: number, isBoss = false): void {
    if (disposed) return;
    const count = isBoss ? 36 : 16;
    spawnMuzzleFlash(position, colorHex, isBoss ? 0.34 : 0.14);
    spawnImpactBurst(position, colorHex, count, isBoss ? 3.2 : 2.1, isBoss ? 0.036 : 0.022);
    spawnShockRing(
      position,
      { x: 0, y: 1, z: 0 },
      isBoss ? 1.45 : 0.45,
      colorHex,
      isBoss ? 0.65 : 0.32,
    );
  }

  function spawnPlasmaExplosion(position: Readonly<Vec3>, radiusM: number): void {
    if (disposed) return;
    spawnMuzzleFlash(position, 0xff7b29, Math.min(0.45, radiusM * 0.35));
    spawnImpactBurst(position, 0xff5722, 18, 2.8, 0.026);
    spawnImpactBurst(position, 0xfbbf24, 10, 1.8, 0.018);
    spawnShockRing(position, { x: 0, y: 1, z: 0 }, Math.max(0.35, radiusM), 0xff5722, 0.42);
    const decal = allocDecal();
    decal.px = position.x;
    decal.py = position.y + 0.008;
    decal.pz = position.z;
    decal.radius = Math.min(0.65, radiusM * 0.52);
    decal.durationSec = 4.2;
    decal.colorHex = 0x7c2d12;
  }

  function spawnRailRings(from: Readonly<Vec3>, to: Readonly<Vec3>, colorHex = 0x7dd3fc): void {
    if (disposed) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    for (const frac of [0.15, 0.48, 0.82] as const) {
      const ring = allocRing();
      ring.px = from.x + dx * frac;
      ring.py = from.y + dy * frac;
      ring.pz = from.z + dz * frac;
      ring.nx = nx;
      ring.ny = ny;
      ring.nz = nz;
      ring.startRadius = 0.025;
      ring.endRadius = 0.14;
      ring.durationSec = 0.34;
      ring.colorHex = colorHex;
    }
    spawnMuzzleFlash(to, 0xe0f2fe, 0.14);
    spawnImpactBurst(to, colorHex, 10, 2.4, 0.016);
  }

  function spawnShockRing(
    position: Readonly<Vec3>,
    normal: Readonly<Vec3>,
    endRadiusM: number,
    colorHex: number,
    durationSec = 0.36,
  ): void {
    if (disposed) return;
    const ring = allocRing();
    ring.px = position.x;
    ring.py = position.y + 0.02;
    ring.pz = position.z;
    const len = Math.hypot(normal.x, normal.y, normal.z);
    ring.nx = len > 1e-5 ? normal.x / len : 0;
    ring.ny = len > 1e-5 ? normal.y / len : 1;
    ring.nz = len > 1e-5 ? normal.z / len : 0;
    ring.startRadius = Math.max(0.03, endRadiusM * 0.12);
    ring.endRadius = endRadiusM;
    ring.durationSec = durationSec;
    ring.colorHex = colorHex;
  }

  function tick(dt: number): void {
    if (disposed) return;
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;

    // 1. Update sparks
    let activeSparks = 0;
    for (let i = 0; i < MAX_VFX_SPARKS; i += 1) {
      const s = sparks[i] as SparkSlot;
      if (!s.active) continue;
      s.elapsedSec += stepDt;
      if (s.elapsedSec >= s.durationSec) {
        s.active = false;
        continue;
      }
      s.vy += s.gravity * stepDt;
      s.px += s.vx * stepDt;
      s.py += s.vy * stepDt;
      s.pz += s.vz * stepDt;
      s.rotY += s.rotSpeed * stepDt;

      const life = 1 - s.elapsedSec / s.durationSec;
      _obj.position.set(s.px, s.py, s.pz);
      _obj.rotation.set(s.rotY * 0.6, s.rotY, 0);
      _obj.scale.set(s.scaleX * life, s.scaleY * life, s.scaleZ * life);
      _obj.updateMatrix();
      sparkMesh.setMatrixAt(activeSparks, _obj.matrix);
      _color.setHex(s.colorHex).multiplyScalar(0.5 + 0.5 * life);
      sparkMesh.setColorAt(activeSparks, _color);
      activeSparks += 1;
    }
    sparkMesh.count = activeSparks;
    sparkMesh.instanceMatrix.needsUpdate = true;
    if (sparkMesh.instanceColor) sparkMesh.instanceColor.needsUpdate = true;

    // 2. Update flashes
    let activeFlashes = 0;
    for (let i = 0; i < MAX_VFX_FLASHES; i += 1) {
      const f = flashes[i] as FlashSlot;
      if (!f.active) continue;
      f.elapsedSec += stepDt;
      if (f.elapsedSec >= f.durationSec) {
        f.active = false;
        continue;
      }
      const p = f.elapsedSec / f.durationSec;
      const s = f.maxScale * Math.sin(Math.PI * p);
      _obj.position.set(f.px, f.py, f.pz);
      _obj.rotation.set(f.rotZ, f.rotZ * 1.3, f.rotZ);
      _obj.scale.setScalar(Math.max(0.001, s));
      _obj.updateMatrix();
      flashMesh.setMatrixAt(activeFlashes, _obj.matrix);
      _color.setHex(f.colorHex);
      flashMesh.setColorAt(activeFlashes, _color);
      activeFlashes += 1;
    }
    flashMesh.count = activeFlashes;
    flashMesh.instanceMatrix.needsUpdate = true;
    if (flashMesh.instanceColor) flashMesh.instanceColor.needsUpdate = true;

    // 3. Update rings
    let activeRings = 0;
    for (let i = 0; i < MAX_VFX_RINGS; i += 1) {
      const r = rings[i] as RingSlot;
      if (!r.active) continue;
      r.elapsedSec += stepDt;
      if (r.elapsedSec >= r.durationSec) {
        r.active = false;
        continue;
      }
      const p = r.elapsedSec / r.durationSec;
      const ease = 1 - (1 - p) * (1 - p);
      const radius = r.startRadius + (r.endRadius - r.startRadius) * ease;
      _obj.position.set(r.px, r.py, r.pz);
      _nrm.set(r.nx, r.ny, r.nz);
      _quat.setFromUnitVectors(_up, _nrm);
      _obj.quaternion.copy(_quat);
      _obj.scale.setScalar(radius);
      _obj.updateMatrix();
      ringMesh.setMatrixAt(activeRings, _obj.matrix);
      _color.setHex(r.colorHex).multiplyScalar(1 - p * 0.75);
      ringMesh.setColorAt(activeRings, _color);
      activeRings += 1;
    }
    ringMesh.count = activeRings;
    ringMesh.instanceMatrix.needsUpdate = true;
    if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;

    // 4. Update decals
    let activeDecals = 0;
    for (let i = 0; i < MAX_VFX_DECALS; i += 1) {
      const d = decals[i] as DecalSlot;
      if (!d.active) continue;
      d.elapsedSec += stepDt;
      if (d.elapsedSec >= d.durationSec) {
        d.active = false;
        continue;
      }
      const fade = 1 - THREE.MathUtils.smoothstep(d.elapsedSec / d.durationSec, 0.55, 1.0);
      _obj.position.set(d.px, d.py, d.pz);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.setScalar(d.radius * (0.85 + 0.15 * fade));
      _obj.updateMatrix();
      decalMesh.setMatrixAt(activeDecals, _obj.matrix);
      _color.setHex(d.colorHex).multiplyScalar(fade);
      decalMesh.setColorAt(activeDecals, _color);
      activeDecals += 1;
    }
    decalMesh.count = activeDecals;
    decalMesh.instanceMatrix.needsUpdate = true;
    if (decalMesh.instanceColor) decalMesh.instanceColor.needsUpdate = true;

    stats = {
      activeSparks,
      activeFlashes,
      activeRings,
      activeDecals,
      totalActive: activeSparks + activeFlashes + activeRings + activeDecals,
    };
  }

  function clear(): void {
    for (const s of sparks) s.active = false;
    for (const f of flashes) f.active = false;
    for (const r of rings) r.active = false;
    for (const d of decals) d.active = false;
    sparkMesh.count = 0;
    flashMesh.count = 0;
    ringMesh.count = 0;
    decalMesh.count = 0;
    stats = {
      activeSparks: 0,
      activeFlashes: 0,
      activeRings: 0,
      activeDecals: 0,
      totalActive: 0,
    };
  }

  return {
    group,
    get stats() {
      return stats;
    },
    drawCallCount: 4,
    spawnMuzzleFlash,
    spawnShellCasing,
    spawnImpactBurst,
    spawnDeathBurst,
    spawnPlasmaExplosion,
    spawnRailRings,
    spawnShockRing,
    tick,
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const b of bindings) b.dispose();
      bindings.length = 0;
      sparkGeo.dispose();
      sparkMat.dispose();
      sparkMesh.dispose();
      flashGeo.dispose();
      flashMat.dispose();
      flashMesh.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      ringMesh.dispose();
      decalGeo.dispose();
      decalMat.dispose();
      decalMesh.dispose();
      group.clear();
      group.removeFromParent();
    },
  };
}
