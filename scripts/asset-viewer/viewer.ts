import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import {
  createRiftPortalShaderMaterial,
  type RiftPortalShaderUniforms,
} from '../../src/render/portal-shader.ts';

type AssetCategory =
  | 'Core & Portal'
  | 'Mounts'
  | 'Turrets'
  | 'Invaders'
  | 'Materials'
  | 'Key Art'
  | 'UI Icons';

interface ModelAssetEntry {
  readonly kind: 'model';
  readonly id: string;
  readonly name: string;
  readonly category: 'Core & Portal' | 'Mounts' | 'Turrets' | 'Invaders';
  readonly subtitle: string;
  readonly score: number;
  readonly lod0Url: string;
  readonly lod1Url?: string;
  readonly isTurret?: boolean;
  readonly hasBossPhase2?: boolean;
  readonly defaultClip: string;
  readonly rigSummary: string;
}

interface MaterialAssetEntry {
  readonly kind: 'material';
  readonly id: string;
  readonly name: string;
  readonly category: 'Materials';
  readonly subtitle: string;
  readonly score: number;
  readonly basecolorUrl: string;
  readonly normalUrl: string;
  readonly ormUrl: string;
  readonly emissiveUrl?: string;
  readonly proofUrl: string;
}

interface ImageAssetEntry {
  readonly kind: 'key-art' | 'icon' | 'atlas';
  readonly id: string;
  readonly name: string;
  readonly category: 'Key Art' | 'UI Icons';
  readonly subtitle: string;
  readonly score: number;
  readonly imageUrl: string;
}

type ViewerAsset = ModelAssetEntry | MaterialAssetEntry | ImageAssetEntry;

const BASE_MODELS = '/assets-source/models';
const BASE_MATERIALS = '/assets-source/materials';
const BASE_UI = '/assets-source/ui/candidates';

const RIG_JOINT_NAMES = new Set([
  'yawRing',
  'pitchCradle',
  'recoilGroup',
  'rotaryCluster',
  'muzzleSocket',
  'mountSocket',
  'apertureAnchor',
  'turret-clamp-hub',
  'turret-clamp-leg-0',
  'turret-clamp-leg-1',
  'turret-clamp-leg-2',
  'turret-clamp-leg-3',
  'turret-hover-repulsor-core',
  'turret-hover-repulsor-ring',
  'energyCrystal',
  'containmentCollar',
  'shieldEmitterRing',
  'portalInterior',
]);

const SOCKET_NAMES = new Set(['muzzleSocket', 'mountSocket', 'apertureAnchor']);

const ASSETS: readonly ViewerAsset[] = [
  // Core & Portal
  {
    kind: 'model',
    id: 'core-bastion',
    name: 'Core Bastion',
    category: 'Core & Portal',
    subtitle:
      'Articulated rig · 5 clips: idle_pulse, ShieldEmitterSweep, hit_flinch, critical_overload, victory_surge',
    score: 86,
    lod0Url: `${BASE_MODELS}/core-bastion/core-bastion.glb`,
    defaultClip: 'idle_pulse',
    rigSummary: 'Articulated · 5 clips',
  },
  {
    kind: 'model',
    id: 'rift-portal',
    name: 'Dimensional Rift Portal',
    category: 'Core & Portal',
    subtitle:
      'Center-out radial rig + GLSL parallax vortex shader · 4 clips: open_tear, idle_rift, spawn_surge, close_seal',
    score: 89,
    lod0Url: `${BASE_MODELS}/rift-portal/rift-portal.glb`,
    defaultClip: 'open_tear',
    rigSummary: 'Shader + Rig · 4 clips',
  },

  // Mounts
  {
    kind: 'model',
    id: 'surface-clamp',
    name: 'Surface Clamp Base',
    category: 'Mounts',
    subtitle: '4 articulated clamp legs + hub · 3 clips: deploy_lock, idle_locked, retract_release',
    score: 88,
    lod0Url: `${BASE_MODELS}/surface-clamp/surface-clamp-lod0.glb`,
    lod1Url: `${BASE_MODELS}/surface-clamp/surface-clamp-lod1.glb`,
    defaultClip: 'deploy_lock',
    rigSummary: '4-Leg Rig · 3 clips',
  },
  {
    kind: 'model',
    id: 'hover-pod',
    name: 'Repulsor Hover-Ring Pod',
    category: 'Mounts',
    subtitle:
      'Counter-rotating core & ring · 4 clips: hover_idle, deploy_ignite, emp_stall, retract_powerdown',
    score: 81,
    lod0Url: `${BASE_MODELS}/hover-pod-revision/hover-pod-lod0.glb`,
    lod1Url: `${BASE_MODELS}/hover-pod-revision/hover-pod-lod1.glb`,
    defaultClip: 'hover_idle',
    rigSummary: 'Gyro Rig · 4 clips',
  },

  // Turrets (4 families × 3 tiers)
  {
    kind: 'model',
    id: 'm44-autocannon-t1',
    name: 'M44 Autocannon — Tier 1 (Single)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (3-round kinetic burst fire_recoil)',
    score: 83,
    lod0Url: `${BASE_MODELS}/m44-autocannon-t1/m44-autocannon-t1-lod0.glb`,
    lod1Url: `${BASE_MODELS}/m44-autocannon-t1/m44-autocannon-t1-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'm44-autocannon-t2',
    name: 'M44 Autocannon — Tier 2 (Twin Linked)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (twin-barrel kinetic burst fire_recoil)',
    score: 82,
    lod0Url: `${BASE_MODELS}/m44-autocannon-t2/m44-autocannon-t2-lod0.glb`,
    lod1Url: `${BASE_MODELS}/m44-autocannon-t2/m44-autocannon-t2-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'm44-autocannon-t3',
    name: 'M44 Autocannon — Tier 3 (Rotary Gatling)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil + rotaryCluster rig · 5 clips (high-speed 6-barrel spin)',
    score: 81,
    lod0Url: `${BASE_MODELS}/m44-autocannon-t3/m44-autocannon-t3-lod0.glb`,
    lod1Url: `${BASE_MODELS}/m44-autocannon-t3/m44-autocannon-t3-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Rotary Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'helios-plasma-mortar-t1',
    name: 'Helios Plasma Mortar — Tier 1 (Single)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (heavy artillery lob fire_recoil)',
    score: 83,
    lod0Url: `${BASE_MODELS}/helios-plasma-mortar-t1/helios-plasma-mortar-t1-lod0.glb`,
    lod1Url: `${BASE_MODELS}/helios-plasma-mortar-t1/helios-plasma-mortar-t1-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'helios-plasma-mortar-t2',
    name: 'Helios Plasma Mortar — Tier 2 (Dual Chamber)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (dual-chamber artillery fire_recoil)',
    score: 80,
    lod0Url: `${BASE_MODELS}/helios-plasma-mortar-t2/helios-plasma-mortar-t2-lod0.glb`,
    lod1Url: `${BASE_MODELS}/helios-plasma-mortar-t2/helios-plasma-mortar-t2-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'helios-plasma-mortar-t3',
    name: 'Helios Plasma Mortar — Tier 3 (Siege)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (heavy siege plasma lob fire_recoil)',
    score: 82,
    lod0Url: `${BASE_MODELS}/helios-plasma-mortar-t3/helios-plasma-mortar-t3-lod0.glb`,
    lod1Url: `${BASE_MODELS}/helios-plasma-mortar-t3/helios-plasma-mortar-t3-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'glacier-cryo-arc-t1',
    name: 'Glacier Cryo-Arc — Tier 1 (Coil)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (charge tremor + arc discharge)',
    score: 83,
    lod0Url: `${BASE_MODELS}/glacier-cryo-arc-t1/glacier-cryo-arc-t1-lod0.glb`,
    lod1Url: `${BASE_MODELS}/glacier-cryo-arc-t1/glacier-cryo-arc-t1-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'glacier-cryo-arc-t2',
    name: 'Glacier Cryo-Arc — Tier 2 (Fork)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (revised dual fork arc discharge)',
    score: 87,
    lod0Url: `${BASE_MODELS}/glacier-cryo-arc-t2/glacier-cryo-arc-t2-lod0.glb`,
    lod1Url: `${BASE_MODELS}/glacier-cryo-arc-t2/glacier-cryo-arc-t2-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'glacier-cryo-arc-t3',
    name: 'Glacier Cryo-Arc — Tier 3 (Tri-Pylon Conduit)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (tri-pylon cryo conduit)',
    score: 84,
    lod0Url: `${BASE_MODELS}/glacier-cryo-arc-t3/glacier-cryo-arc-t3-lod0.glb`,
    lod1Url: `${BASE_MODELS}/glacier-cryo-arc-t3/glacier-cryo-arc-t3-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'valkyrie-rail-sniper-t1',
    name: 'Valkyrie Rail Sniper — Tier 1 (Compact Rail)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (precision lock-on + hypervelocity kick)',
    score: 82,
    lod0Url: `${BASE_MODELS}/valkyrie-rail-sniper-t1/valkyrie-rail-sniper-t1-lod0.glb`,
    lod1Url: `${BASE_MODELS}/valkyrie-rail-sniper-t1/valkyrie-rail-sniper-t1-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'valkyrie-rail-sniper-t2',
    name: 'Valkyrie Rail Sniper — Tier 2 (Capacitor Fins)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (hypervelocity rail kickback)',
    score: 85,
    lod0Url: `${BASE_MODELS}/valkyrie-rail-sniper-t2/valkyrie-rail-sniper-t2-lod0.glb`,
    lod1Url: `${BASE_MODELS}/valkyrie-rail-sniper-t2/valkyrie-rail-sniper-t2-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },
  {
    kind: 'model',
    id: 'valkyrie-rail-sniper-t3',
    name: 'Valkyrie Rail Sniper — Tier 3 (Twin Accelerators)',
    category: 'Turrets',
    subtitle: 'Yaw/pitch/recoil rig · 5 clips (twin accelerator rail kickback)',
    score: 83,
    lod0Url: `${BASE_MODELS}/valkyrie-rail-sniper-t3/valkyrie-rail-sniper-t3-lod0.glb`,
    lod1Url: `${BASE_MODELS}/valkyrie-rail-sniper-t3/valkyrie-rail-sniper-t3-lod1.glb`,
    isTurret: true,
    defaultClip: 'fire_recoil',
    rigSummary: 'Turret Rig · 5 clips',
  },

  // Invaders & Boss
  {
    kind: 'model',
    id: 'skitter-crawler',
    name: 'Skitter Crawler',
    category: 'Invaders',
    subtitle: 'Skeletal rig (23 bones) · 5 clips: crawl_floor, climb_wall, attack, hit, death',
    score: 83,
    lod0Url: `${BASE_MODELS}/skitter-crawler/skitter-crawler-lod0.glb`,
    lod1Url: `${BASE_MODELS}/skitter-crawler/skitter-crawler-lod1.glb`,
    defaultClip: 'crawl_floor',
    rigSummary: '23 Bones · 5 clips',
  },
  {
    kind: 'model',
    id: 'wasp-skimmer',
    name: 'Wasp Skimmer',
    category: 'Invaders',
    subtitle: 'Skeletal rig (9 bones) · 5 clips: hover_fly, bank_turn, attack, hit, death',
    score: 84,
    lod0Url: `${BASE_MODELS}/wasp-skimmer/wasp-skimmer-lod0.glb`,
    lod1Url: `${BASE_MODELS}/wasp-skimmer/wasp-skimmer-lod1.glb`,
    defaultClip: 'hover_fly',
    rigSummary: '9 Bones · 5 clips',
  },
  {
    kind: 'model',
    id: 'carapace-brute',
    name: 'Carapace Brute',
    category: 'Invaders',
    subtitle: 'Skeletal rig (24 bones) · 5 clips: stomp_walk, armor_brace, attack, hit, death',
    score: 85,
    lod0Url: `${BASE_MODELS}/carapace-brute/carapace-brute-lod0.glb`,
    lod1Url: `${BASE_MODELS}/carapace-brute/carapace-brute-lod1.glb`,
    defaultClip: 'stomp_walk',
    rigSummary: '24 Bones · 5 clips',
  },
  {
    kind: 'model',
    id: 'rift-disruptor',
    name: 'Rift Disruptor',
    category: 'Invaders',
    subtitle: 'Skeletal rig (3 bones) · 4 clips: hover_glide, emp_pulse, hit, death',
    score: 86,
    lod0Url: `${BASE_MODELS}/rift-disruptor/rift-disruptor-lod0.glb`,
    lod1Url: `${BASE_MODELS}/rift-disruptor/rift-disruptor-lod1.glb`,
    defaultClip: 'hover_glide',
    rigSummary: '3 Bones · 4 clips',
  },
  {
    kind: 'model',
    id: 'apex-broodlord',
    name: 'Apex Broodlord (Wave 12 Boss)',
    category: 'Invaders',
    subtitle: 'Skeletal rig (28 bones) · 6 clips + Phase-2 molten armor cracks',
    score: 82,
    lod0Url: `${BASE_MODELS}/apex-broodlord/apex-broodlord-lod0.glb`,
    lod1Url: `${BASE_MODELS}/apex-broodlord/apex-broodlord-lod1.glb`,
    hasBossPhase2: true,
    defaultClip: 'boss_march',
    rigSummary: '28 Bones · 6 clips',
  },

  // Shared PBR Materials
  {
    kind: 'material',
    id: 'mat-brushed-titanium',
    name: 'Brushed Titanium (PBR Material)',
    category: 'Materials',
    subtitle: 'materials/brushed-titanium · 256 px tileable KTX2 (BaseColor, Normal, ORM)',
    score: 91,
    basecolorUrl: `${BASE_MATERIALS}/brushed-titanium/basecolor.ktx2`,
    normalUrl: `${BASE_MATERIALS}/brushed-titanium/normal.ktx2`,
    ormUrl: `${BASE_MATERIALS}/brushed-titanium/orm.ktx2`,
    proofUrl: `${BASE_MATERIALS}/review/brushed-titanium.webp`,
  },
  {
    kind: 'material',
    id: 'mat-tactical-ceramic',
    name: 'Tactical Ceramic (PBR Material)',
    category: 'Materials',
    subtitle: 'materials/tactical-ceramic · 256 px tileable KTX2 (BaseColor, Normal, ORM)',
    score: 87,
    basecolorUrl: `${BASE_MATERIALS}/tactical-ceramic/basecolor.ktx2`,
    normalUrl: `${BASE_MATERIALS}/tactical-ceramic/normal.ktx2`,
    ormUrl: `${BASE_MATERIALS}/tactical-ceramic/orm.ktx2`,
    proofUrl: `${BASE_MATERIALS}/review/tactical-ceramic.webp`,
  },
  {
    kind: 'material',
    id: 'mat-dark-gunmetal',
    name: 'Dark Gunmetal (PBR Material)',
    category: 'Materials',
    subtitle: 'materials/dark-gunmetal · 256 px tileable KTX2 (BaseColor, Normal, ORM)',
    score: 88,
    basecolorUrl: `${BASE_MATERIALS}/dark-gunmetal/basecolor.ktx2`,
    normalUrl: `${BASE_MATERIALS}/dark-gunmetal/normal.ktx2`,
    ormUrl: `${BASE_MATERIALS}/dark-gunmetal/orm.ktx2`,
    proofUrl: `${BASE_MATERIALS}/review/dark-gunmetal.webp`,
  },
  {
    kind: 'material',
    id: 'mat-obsidian-chitin',
    name: 'Obsidian Chitin (PBR Material)',
    category: 'Materials',
    subtitle: 'materials/obsidian-chitin · 256 px tileable KTX2 (BaseColor, Normal, ORM)',
    score: 82,
    basecolorUrl: `${BASE_MATERIALS}/obsidian-chitin/basecolor.ktx2`,
    normalUrl: `${BASE_MATERIALS}/obsidian-chitin/normal.ktx2`,
    ormUrl: `${BASE_MATERIALS}/obsidian-chitin/orm.ktx2`,
    proofUrl: `${BASE_MATERIALS}/review/obsidian-chitin.webp`,
  },
  {
    kind: 'material',
    id: 'mat-rift-obsidian',
    name: 'Rift Obsidian — Revised (PBR Material)',
    category: 'Materials',
    subtitle: 'materials/rift-obsidian-revision · 256 px tileable KTX2 + Emissive',
    score: 86,
    basecolorUrl: `${BASE_MATERIALS}/rift-obsidian-revision/rift-obsidian/basecolor.ktx2`,
    normalUrl: `${BASE_MATERIALS}/rift-obsidian-revision/rift-obsidian/normal.ktx2`,
    ormUrl: `${BASE_MATERIALS}/rift-obsidian-revision/rift-obsidian/orm.ktx2`,
    emissiveUrl: `${BASE_MATERIALS}/rift-obsidian-revision/rift-obsidian/emissive.ktx2`,
    proofUrl: `${BASE_MATERIALS}/rift-obsidian-revision/review/rift-obsidian.webp`,
  },

  // Launch Key Art
  {
    kind: 'key-art',
    id: 'desktop-title',
    name: 'Desktop Launch Art (16:9)',
    category: 'Key Art',
    subtitle: 'ui/candidates/desktop-title.jpg · 1920 × 1080 · 15.36:1 title contrast',
    score: 95,
    imageUrl: `${BASE_UI}/desktop-title.jpg`,
  },
  {
    kind: 'key-art',
    id: 'quest-title',
    name: 'Quest Launch Card (1:1)',
    category: 'Key Art',
    subtitle: 'ui/candidates/quest-title.jpg · 1024 × 1024 · 17.55:1 title contrast',
    score: 86,
    imageUrl: `${BASE_UI}/quest-title.jpg`,
  },

  // UI Icons & Atlas
  {
    kind: 'atlas',
    id: 'tactical-atlas',
    name: 'Tactical UI Icon Atlas (All 18 Badges)',
    category: 'UI Icons',
    subtitle: 'ui/candidates/tactical-atlas.png · 768 × 384 (6×3 @ 128 px RGBA)',
    score: 90,
    imageUrl: `${BASE_UI}/tactical-atlas.png`,
  },
  {
    kind: 'icon',
    id: 'icon-build-autocannon',
    name: 'Icon: Build M44 Autocannon',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/build-autocannon.png · 128 × 128 RGBA',
    score: 83,
    imageUrl: `${BASE_UI}/icons/build-autocannon.png`,
  },
  {
    kind: 'icon',
    id: 'icon-build-plasma-mortar',
    name: 'Icon: Build Helios Plasma Mortar',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/build-plasma-mortar.png · 128 × 128 RGBA',
    score: 93,
    imageUrl: `${BASE_UI}/icons/build-plasma-mortar.png`,
  },
  {
    kind: 'icon',
    id: 'icon-build-cryo-arc',
    name: 'Icon: Build Glacier Cryo-Arc',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/build-cryo-arc.png · 128 × 128 RGBA',
    score: 91,
    imageUrl: `${BASE_UI}/icons/build-cryo-arc.png`,
  },
  {
    kind: 'icon',
    id: 'icon-build-rail-sniper',
    name: 'Icon: Build Valkyrie Rail Sniper',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/build-rail-sniper.png · 128 × 128 RGBA (revised)',
    score: 87,
    imageUrl: `${BASE_UI}/icons/build-rail-sniper.png`,
  },
  {
    kind: 'icon',
    id: 'icon-wave-launch',
    name: 'Icon: Launch Wave',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/wave-launch.png · 128 × 128 RGBA',
    score: 92,
    imageUrl: `${BASE_UI}/icons/wave-launch.png`,
  },
  {
    kind: 'icon',
    id: 'icon-wave-warning',
    name: 'Icon: Wave Warning',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/wave-warning.png · 128 × 128 RGBA',
    score: 97,
    imageUrl: `${BASE_UI}/icons/wave-warning.png`,
  },
  {
    kind: 'icon',
    id: 'icon-tier-1',
    name: 'Icon: Tier 1',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/tier-1.png · 128 × 128 RGBA',
    score: 92,
    imageUrl: `${BASE_UI}/icons/tier-1.png`,
  },
  {
    kind: 'icon',
    id: 'icon-tier-2',
    name: 'Icon: Tier 2',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/tier-2.png · 128 × 128 RGBA',
    score: 90,
    imageUrl: `${BASE_UI}/icons/tier-2.png`,
  },
  {
    kind: 'icon',
    id: 'icon-tier-3',
    name: 'Icon: Tier 3',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/tier-3.png · 128 × 128 RGBA',
    score: 87,
    imageUrl: `${BASE_UI}/icons/tier-3.png`,
  },
  {
    kind: 'icon',
    id: 'icon-relocate',
    name: 'Icon: Relocate Turret',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/relocate.png · 128 × 128 RGBA',
    score: 89,
    imageUrl: `${BASE_UI}/icons/relocate.png`,
  },
  {
    kind: 'icon',
    id: 'icon-sell',
    name: 'Icon: Sell Turret',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/sell.png · 128 × 128 RGBA',
    score: 89,
    imageUrl: `${BASE_UI}/icons/sell.png`,
  },
  {
    kind: 'icon',
    id: 'icon-emp-disrupted',
    name: 'Icon: EMP Disrupted',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/emp-disrupted.png · 128 × 128 RGBA',
    score: 86,
    imageUrl: `${BASE_UI}/icons/emp-disrupted.png`,
  },
  {
    kind: 'icon',
    id: 'icon-target-first',
    name: 'Icon: Target First',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/target-first.png · 128 × 128 RGBA (revised)',
    score: 87,
    imageUrl: `${BASE_UI}/icons/target-first.png`,
  },
  {
    kind: 'icon',
    id: 'icon-target-strongest',
    name: 'Icon: Target Strongest',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/target-strongest.png · 128 × 128 RGBA',
    score: 88,
    imageUrl: `${BASE_UI}/icons/target-strongest.png`,
  },
  {
    kind: 'icon',
    id: 'icon-target-closest',
    name: 'Icon: Target Closest',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/target-closest.png · 128 × 128 RGBA',
    score: 96,
    imageUrl: `${BASE_UI}/icons/target-closest.png`,
  },
  {
    kind: 'icon',
    id: 'icon-target-air',
    name: 'Icon: Target Air',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/target-air.png · 128 × 128 RGBA',
    score: 89,
    imageUrl: `${BASE_UI}/icons/target-air.png`,
  },
  {
    kind: 'icon',
    id: 'icon-star-earned',
    name: 'Icon: Earned Star',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/star-earned.png · 128 × 128 RGBA',
    score: 97,
    imageUrl: `${BASE_UI}/icons/star-earned.png`,
  },
  {
    kind: 'icon',
    id: 'icon-star-empty',
    name: 'Icon: Empty Star',
    category: 'UI Icons',
    subtitle: 'ui/candidates/icons/star-empty.png · 128 × 128 RGBA',
    score: 91,
    imageUrl: `${BASE_UI}/icons/star-empty.png`,
  },
];

const CATEGORIES: readonly ('All' | AssetCategory)[] = [
  'All',
  'Core & Portal',
  'Mounts',
  'Turrets',
  'Invaders',
  'Materials',
  'Key Art',
  'UI Icons',
];

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return el as T;
}

const searchInput = requireEl<HTMLInputElement>('search-input');
const categoryTabsEl = requireEl<HTMLDivElement>('category-tabs');
const assetListEl = requireEl<HTMLDivElement>('asset-list');
const assetIndexEl = requireEl<HTMLSpanElement>('asset-index');
const assetCategoryEl = requireEl<HTMLSpanElement>('asset-category');
const assetScoreEl = requireEl<HTMLSpanElement>('asset-score');
const assetNameEl = requireEl<HTMLHeadingElement>('asset-name');
const assetSubtitleEl = requireEl<HTMLParagraphElement>('asset-subtitle');
const prevBtn = requireEl<HTMLButtonElement>('prev-btn');
const nextBtn = requireEl<HTMLButtonElement>('next-btn');
const canvasStage = requireEl<HTMLDivElement>('canvas-stage');
const imageStage = requireEl<HTMLDivElement>('image-stage');
const imageStageInner = requireEl<HTMLDivElement>('image-stage-inner');
const canvas = requireEl<HTMLCanvasElement>('viewer-canvas');
const loadingOverlay = requireEl<HTMLDivElement>('loading-overlay');
const loadingLabel = requireEl<HTMLSpanElement>('loading-label');
const errorOverlay = requireEl<HTMLDivElement>('error-overlay');
const liveStatsEl = requireEl<HTMLDivElement>('live-stats');
const animBar = requireEl<HTMLDivElement>('anim-bar');
const clipPillsEl = requireEl<HTMLDivElement>('clip-pills');
const animPlayBtn = requireEl<HTMLButtonElement>('anim-play-btn');
const animScrubber = requireEl<HTMLInputElement>('anim-scrubber');
const animTimeLabel = requireEl<HTMLSpanElement>('anim-time-label');
const controls3d = requireEl<HTMLDivElement>('controls-3d');
const controls2d = requireEl<HTMLDivElement>('controls-2d');
const lodGroup = requireEl<HTMLDivElement>('lod-group');
const mountGroup = requireEl<HTMLDivElement>('mount-group');
const bossPhaseGroup = requireEl<HTMLDivElement>('boss-phase-group');
const materialViewGroup = requireEl<HTMLDivElement>('material-view-group');
const rigBtn = requireEl<HTMLButtonElement>('rig-btn');
const rotateBtn = requireEl<HTMLButtonElement>('rotate-btn');
const wireframeBtn = requireEl<HTMLButtonElement>('wireframe-btn');
const gridBtn = requireEl<HTMLButtonElement>('grid-btn');
const resetCamBtn = requireEl<HTMLButtonElement>('reset-cam-btn');

// Three.js Studio Setup
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

const pmrem = new THREE.PMREMGenerator(renderer);
const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTexture;
pmrem.dispose();

const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 50);
camera.position.set(1.2, 0.9, 1.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;

// Studio lighting rig
const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.75);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xfff7ed, 2.4);
keyLight.position.set(2.4, 3.8, 2.8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.camera.near = 0.2;
keyLight.shadow.camera.far = 12;
const shadowBounds = 1.8;
keyLight.shadow.camera.left = -shadowBounds;
keyLight.shadow.camera.right = shadowBounds;
keyLight.shadow.camera.top = shadowBounds;
keyLight.shadow.camera.bottom = -shadowBounds;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.15);
rimLight.position.set(-2.6, 2.2, -2.4);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xa78bfa, 0.55);
fillLight.position.set(-1.5, 0.8, 2.5);
scene.add(fillLight);

// Ground grid & shadow catcher
const floorGroup = new THREE.Group();
const gridHelper = new THREE.GridHelper(3.2, 16, 0x38bdf8, 0x1e293b);
const gridMaterials = Array.isArray(gridHelper.material)
  ? gridHelper.material
  : [gridHelper.material];
for (const mat of gridMaterials) {
  mat.transparent = true;
  mat.opacity = 0.35;
}
floorGroup.add(gridHelper);

const shadowFloor = new THREE.Mesh(
  new THREE.CircleGeometry(1.7, 48),
  new THREE.ShadowMaterial({ opacity: 0.35 }),
);
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.position.y = -0.001;
shadowFloor.receiveShadow = true;
floorGroup.add(shadowFloor);
scene.add(floorGroup);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

const rigOverlayRoot = new THREE.Group();
rigOverlayRoot.visible = false;
scene.add(rigOverlayRoot);

// Loaders
const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/');
ktx2Loader.detectSupport(renderer);

const gltfLoader = new GLTFLoader();
gltfLoader.setKTX2Loader(ktx2Loader);

// State
let activeCategory: 'All' | AssetCategory = 'All';
let searchQuery = '';
let filteredAssets: ViewerAsset[] = [...ASSETS];
let selectedAssetId: string = ASSETS[0]?.id ?? 'core-bastion';
let currentLod: 0 | 1 = 0;
let currentMount: 'surface-clamp' | 'hover-pod' | 'none' = 'surface-clamp';
let currentBossPhase: 1 | 2 = 1;
let currentMatView: '3d' | 'proof' = '3d';
let wireframeEnabled = false;
let rigOverlayVisible = false;
let animPaused = false;
let playbackSpeed = 1;
let isScrubbing = false;
let loadToken = 0;

let mixer: THREE.AnimationMixer | null = null;
let mountMixer: THREE.AnimationMixer | null = null;
let activeClips: THREE.AnimationClip[] = [];
let mountClips: THREE.AnimationClip[] = [];
let activeAction: THREE.AnimationAction | null = null;
let activeMountAction: THREE.AnimationAction | null = null;
let activeClipName = '';
const defaultCamPos = new THREE.Vector3(1.2, 0.9, 1.5);
const defaultCamTarget = new THREE.Vector3(0, 0.3, 0);
let broodlordPhase1Emissive: THREE.Texture | null = null;
let broodlordPhase2Emissive: THREE.CanvasTexture | null = null;
let activePortalShader: THREE.ShaderMaterial | null = null;
let activePortalInterior: THREE.Object3D | null = null;
let portalShaderTime = 0;
const attachedRigHelpers: Array<{ parent: THREE.Object3D; child: THREE.Object3D }> = [];

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
      node.geometry.dispose();
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (!mat) continue;
        for (const value of Object.values(mat)) {
          if (value instanceof THREE.Texture) {
            value.dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}

function clearRigOverlay(): void {
  for (const link of attachedRigHelpers) {
    link.parent.remove(link.child);
    disposeObject3D(link.child);
  }
  attachedRigHelpers.length = 0;

  while (rigOverlayRoot.children.length > 0) {
    const child = rigOverlayRoot.children[0];
    if (!child) break;
    rigOverlayRoot.remove(child);
    disposeObject3D(child);
  }
}

function clearModelRoot(): void {
  clearRigOverlay();
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }
  if (mountMixer) {
    mountMixer.stopAllAction();
    mountMixer = null;
  }
  activeClips = [];
  mountClips = [];
  activeAction = null;
  activeMountAction = null;
  activeClipName = '';
  broodlordPhase1Emissive = null;
  if (broodlordPhase2Emissive) {
    broodlordPhase2Emissive.dispose();
    broodlordPhase2Emissive = null;
  }
  if (activePortalShader) {
    const uniforms = activePortalShader.uniforms as RiftPortalShaderUniforms;
    uniforms.uVortexMap.value?.dispose();
    activePortalShader = null;
  }
  activePortalInterior = null;
  portalShaderTime = 0;
  while (modelRoot.children.length > 0) {
    const child = modelRoot.children[0];
    if (!child) break;
    modelRoot.remove(child);
    disposeObject3D(child);
  }
}

function buildRigOverlay(assembly: THREE.Object3D): number {
  clearRigOverlay();
  let helperCount = 0;

  let hasSkinned = false;
  assembly.traverse((node) => {
    if (node instanceof THREE.SkinnedMesh) {
      hasSkinned = true;
    }
  });

  if (hasSkinned) {
    const skelHelper = new THREE.SkeletonHelper(assembly);
    const mat = skelHelper.material as THREE.LineBasicMaterial;
    mat.depthTest = false;
    mat.transparent = true;
    mat.opacity = 0.92;
    skelHelper.renderOrder = 999;
    rigOverlayRoot.add(skelHelper);
    helperCount += 1;
  }

  // Attach glowing joint / socket markers directly onto articulated rig nodes so they move live
  const jointGeo = new THREE.OctahedronGeometry(0.014, 0);
  const socketGeo = new THREE.OctahedronGeometry(0.018, 0);

  assembly.traverse((node) => {
    const isSocket = SOCKET_NAMES.has(node.name) || node.userData?.socket === true;
    const isJoint = RIG_JOINT_NAMES.has(node.name);
    if (!isSocket && !isJoint) return;

    const markerGroup = new THREE.Group();
    markerGroup.name = `__rig-marker-${node.name}`;
    markerGroup.visible = rigOverlayVisible;

    const mat = new THREE.MeshBasicMaterial({
      color: isSocket ? 0xf59e0b : 0x38bdf8,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const marker = new THREE.Mesh((isSocket ? socketGeo : jointGeo).clone(), mat);
    marker.renderOrder = 1000;
    markerGroup.add(marker);

    const axes = new THREE.AxesHelper(isSocket ? 0.075 : 0.055);
    const axesMat = axes.material as THREE.LineBasicMaterial;
    axesMat.depthTest = false;
    axesMat.transparent = true;
    axesMat.opacity = 0.9;
    axes.renderOrder = 1000;
    markerGroup.add(axes);

    node.add(markerGroup);
    attachedRigHelpers.push({ parent: node, child: markerGroup });
    helperCount += 1;
  });

  jointGeo.dispose();
  socketGeo.dispose();
  rigOverlayRoot.visible = rigOverlayVisible;
  return helperCount;
}

function setRigOverlayVisible(visible: boolean): void {
  rigOverlayVisible = visible;
  rigBtn.classList.toggle('active', visible);
  rigOverlayRoot.visible = visible;
  for (const link of attachedRigHelpers) {
    link.child.visible = visible;
  }
}

function setLoading(visible: boolean, label = 'Loading asset…'): void {
  loadingOverlay.hidden = !visible;
  loadingLabel.textContent = label;
}

function setError(message: string | null): void {
  if (!message) {
    errorOverlay.hidden = true;
    errorOverlay.textContent = '';
    return;
  }
  errorOverlay.hidden = false;
  errorOverlay.textContent = message;
}

function applyWireframe(enabled: boolean): void {
  modelRoot.traverse((node) => {
    if (node instanceof THREE.Mesh && !node.parent?.name.startsWith('__rig-marker-')) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if ('wireframe' in mat) {
          (mat as THREE.MeshStandardMaterial).wireframe = enabled;
        }
      }
    }
  });
}

function frameObject(object: THREE.Object3D, isPortal = false): void {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  object.position.y -= box.min.y;
  object.updateMatrixWorld(true);
  box.setFromObject(object);

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.25);
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const dist = ((maxDim * 0.56) / Math.tan(fovRad * 0.5)) * 1.5;

  defaultCamTarget.copy(center);
  if (isPortal) {
    defaultCamPos.set(center.x + dist * 0.42, center.y + dist * 0.16, center.z + dist * 0.92);
  } else {
    defaultCamPos.set(center.x + dist * 0.72, center.y + dist * 0.44, center.z + dist * 0.85);
  }

  camera.position.copy(defaultCamPos);
  controls.target.copy(defaultCamTarget);
  controls.minDistance = maxDim * 0.35;
  controls.maxDistance = maxDim * 8;
  controls.update();
}

function measureModel(object: THREE.Object3D): {
  triangles: number;
  meshes: number;
  bones: number;
  joints: number;
  materials: number;
  dims: string;
} {
  let triangles = 0;
  let meshes = 0;
  let joints = 0;
  const boneSet = new Set<THREE.Object3D>();
  const matSet = new Set<THREE.Material>();

  object.traverse((node) => {
    if (node.name.startsWith('__rig-marker-')) return;
    if (node instanceof THREE.Bone) {
      boneSet.add(node);
    }
    if (RIG_JOINT_NAMES.has(node.name)) {
      joints += 1;
    }
    if (node instanceof THREE.Mesh && !node.parent?.name.startsWith('__rig-marker-')) {
      meshes += 1;
      const geo = node.geometry;
      if (geo.index) {
        triangles += geo.index.count / 3;
      } else if (geo.attributes.position) {
        triangles += geo.attributes.position.count / 3;
      }
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (mat) matSet.add(mat);
      }
    }
  });

  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const dims = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;

  return {
    triangles: Math.round(triangles),
    meshes,
    bones: boneSet.size,
    joints,
    materials: matSet.size,
    dims,
  };
}

function renderLiveStats(chips: string[]): void {
  liveStatsEl.replaceChildren();
  for (const text of chips) {
    const span = document.createElement('span');
    span.className = 'stat-chip';
    span.textContent = text;
    liveStatsEl.appendChild(span);
  }
}

async function buildBroodlordPhase2Texture(): Promise<THREE.CanvasTexture> {
  const loadImg = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${url}`));
      img.src = url;
    });

  const [baseEmissive, crackMask] = await Promise.all([
    loadImg(`${BASE_MODELS}/apex-broodlord/emissive.png`),
    loadImg(`${BASE_MODELS}/apex-broodlord/phase2-cracks.png`),
  ]);

  const w = crackMask.naturalWidth;
  const h = crackMask.naturalHeight;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2D canvas context');

  ctx.drawImage(baseEmissive, 0, 0, w, h);
  const baseData = ctx.getImageData(0, 0, w, h);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) throw new Error('Could not acquire mask 2D context');
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

  const tex = new THREE.CanvasTexture(out);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function applyBroodlordPhase(phase: 1 | 2): void {
  modelRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || node.parent?.name.startsWith('__rig-marker-')) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      if (!broodlordPhase1Emissive && mat.emissiveMap) {
        broodlordPhase1Emissive = mat.emissiveMap;
      }
      if (phase === 2 && broodlordPhase2Emissive) {
        mat.emissiveMap = broodlordPhase2Emissive;
        mat.emissiveIntensity = 1.65;
        mat.needsUpdate = true;
      } else if (phase === 1 && broodlordPhase1Emissive) {
        mat.emissiveMap = broodlordPhase1Emissive;
        mat.emissiveIntensity = 1.0;
        mat.needsUpdate = true;
      }
    }
  });
}

function pickPairedMountClip(headClipName: string): THREE.AnimationClip | null {
  if (mountClips.length === 0) return null;
  const find = (name: string) => mountClips.find((c) => c.name === name) ?? null;

  if (currentMount === 'surface-clamp') {
    if (headClipName === 'deploy') return find('deploy_lock');
    return find('idle_locked') ?? mountClips[0] ?? null;
  }
  if (currentMount === 'hover-pod') {
    if (headClipName === 'deploy') return find('deploy_ignite');
    if (headClipName === 'emp_disrupted') return find('emp_stall');
    return find('hover_idle') ?? mountClips[0] ?? null;
  }
  return null;
}

function syncAnimationUi(): void {
  const pills = clipPillsEl.querySelectorAll<HTMLButtonElement>('.clip-pill');
  for (const pill of pills) {
    pill.classList.toggle('active', pill.dataset.clip === activeClipName);
  }
  animPlayBtn.textContent = animPaused ? 'Play' : 'Pause';
}

function playClipByName(name: string): void {
  if (!mixer || activeClips.length === 0) return;
  const clip = activeClips.find((c) => c.name === name) ?? activeClips[0];
  if (!clip) return;

  activeClipName = clip.name;
  mixer.stopAllAction();
  activeAction = mixer.clipAction(clip);
  activeAction.reset();
  activeAction.timeScale = playbackSpeed;
  activeAction.paused = animPaused;
  activeAction.play();

  if (mountMixer) {
    mountMixer.stopAllAction();
    const mountClip = pickPairedMountClip(clip.name);
    if (mountClip) {
      activeMountAction = mountMixer.clipAction(mountClip);
      activeMountAction.reset();
      activeMountAction.timeScale = playbackSpeed;
      activeMountAction.paused = animPaused;
      activeMountAction.play();
    } else {
      activeMountAction = null;
    }
  }

  animScrubber.max = String(Math.max(clip.duration, 0.001));
  animScrubber.value = '0';
  animTimeLabel.textContent = `0.00 / ${clip.duration.toFixed(2)}s`;
  syncAnimationUi();
}

function renderClipPills(clips: THREE.AnimationClip[]): void {
  clipPillsEl.replaceChildren();
  for (const clip of clips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'clip-pill';
    btn.dataset.clip = clip.name;
    btn.textContent = `${clip.name} (${clip.duration.toFixed(2)}s)`;
    btn.addEventListener('click', () => playClipByName(clip.name));
    clipPillsEl.appendChild(btn);
  }
}

async function loadModelAsset(asset: ModelAssetEntry, token: number): Promise<void> {
  canvasStage.hidden = false;
  imageStage.hidden = true;
  controls3d.hidden = false;
  controls2d.hidden = true;
  materialViewGroup.hidden = true;

  const hasLod1 = Boolean(asset.lod1Url);
  lodGroup.hidden = !hasLod1;
  if (!hasLod1) {
    currentLod = 0;
  }
  syncSegmentedButtons(lodGroup, 'lod', String(currentLod));

  mountGroup.hidden = !asset.isTurret;
  syncSegmentedButtons(mountGroup, 'mount', currentMount);

  bossPhaseGroup.hidden = !asset.hasBossPhase2;
  syncSegmentedButtons(bossPhaseGroup, 'phase', String(currentBossPhase));

  setError(null);
  setLoading(true, `Loading ${asset.name}…`);
  clearModelRoot();

  const url = currentLod === 1 && asset.lod1Url ? asset.lod1Url : asset.lod0Url;

  try {
    const headGltf = await gltfLoader.loadAsync(url);
    if (token !== loadToken) {
      disposeObject3D(headGltf.scene);
      return;
    }

    const assembly = new THREE.Group();
    assembly.name = asset.id;

    let mountLabel = '';
    let mountScene: THREE.Group | null = null;
    if (asset.isTurret && currentMount !== 'none') {
      const mountFile =
        currentMount === 'surface-clamp'
          ? `${BASE_MODELS}/surface-clamp/surface-clamp-lod${currentLod}.glb`
          : `${BASE_MODELS}/hover-pod-revision/hover-pod-lod${currentLod}.glb`;
      const mountGltf = await gltfLoader.loadAsync(mountFile);
      if (token !== loadToken) {
        disposeObject3D(headGltf.scene);
        disposeObject3D(mountGltf.scene);
        return;
      }
      mountScene = mountGltf.scene;
      mountClips = mountGltf.animations;
      assembly.add(mountScene);
      mountLabel = currentMount === 'surface-clamp' ? '+ Surface Clamp' : '+ Hover Pod';
    }

    assembly.add(headGltf.scene);
    assembly.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    modelRoot.add(assembly);

    if (asset.id === 'rift-portal') {
      assembly.traverse((node) => {
        if (node instanceof THREE.Mesh && node.name === 'portalInterior') {
          const oldMat = Array.isArray(node.material) ? node.material[0] : node.material;
          const vortexMap =
            oldMat instanceof THREE.MeshStandardMaterial
              ? (oldMat.emissiveMap ?? oldMat.map ?? null)
              : oldMat instanceof THREE.MeshBasicMaterial
                ? (oldMat.map ?? null)
                : null;
          const shaderMat = createRiftPortalShaderMaterial({ vortexMap, initialOpen: 1 });
          node.material = shaderMat;
          node.castShadow = false;
          node.receiveShadow = false;
          if (oldMat) oldMat.dispose();
          activePortalShader = shaderMat;
          activePortalInterior = node;
        }
      });
    }

    frameObject(assembly, asset.id === 'rift-portal');
    buildRigOverlay(assembly);
    applyWireframe(wireframeEnabled);

    // Animations
    activeClips = headGltf.animations;
    if (activeClips.length > 0) {
      animBar.hidden = false;
      renderClipPills(activeClips);
      mixer = new THREE.AnimationMixer(headGltf.scene);
      if (mountScene && mountClips.length > 0) {
        mountMixer = new THREE.AnimationMixer(mountScene);
      }
      animPaused = false;
      const startClip =
        activeClips.find((c) => c.name === asset.defaultClip)?.name ?? activeClips[0]?.name ?? '';
      playClipByName(startClip);
    } else {
      animBar.hidden = true;
    }

    if (asset.hasBossPhase2) {
      broodlordPhase2Emissive = await buildBroodlordPhase2Texture();
      if (token !== loadToken) return;
      applyBroodlordPhase(currentBossPhase);
    }

    const stats = measureModel(assembly);
    const rigChip =
      stats.bones > 0 ? `Skeletal · ${stats.bones} bones` : `Articulated · ${stats.joints} pivots`;
    const chips = [
      `LOD${currentLod}${mountLabel ? ` ${mountLabel}` : ''}`,
      `${stats.triangles.toLocaleString()} tris`,
      `${stats.materials} mat${stats.materials === 1 ? '' : 's'}`,
      rigChip,
      stats.dims,
      `${activeClips.length} anim clip${activeClips.length === 1 ? '' : 's'}`,
    ];
    renderLiveStats(chips);
    setLoading(false);
  } catch (err) {
    if (token !== loadToken) return;
    setLoading(false);
    setError(`Could not load ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadMaterialAsset(asset: MaterialAssetEntry, token: number): Promise<void> {
  lodGroup.hidden = true;
  mountGroup.hidden = true;
  animBar.hidden = true;
  bossPhaseGroup.hidden = true;
  materialViewGroup.hidden = false;
  syncSegmentedButtons(materialViewGroup, 'matview', currentMatView);

  if (currentMatView === 'proof') {
    canvasStage.hidden = true;
    imageStage.hidden = false;
    controls3d.hidden = false;
    controls2d.hidden = true;
    imageStageInner.replaceChildren();
    const img = document.createElement('img');
    img.src = asset.proofUrl;
    img.alt = asset.name;
    img.className = 'preview-hero-img';
    imageStageInner.appendChild(img);
    return;
  }

  canvasStage.hidden = false;
  imageStage.hidden = true;
  controls3d.hidden = false;
  controls2d.hidden = true;

  setError(null);
  setLoading(true, `Decoding KTX2 maps for ${asset.name}…`);
  clearModelRoot();

  try {
    const loads: Promise<THREE.CompressedTexture | null>[] = [
      ktx2Loader.loadAsync(asset.basecolorUrl),
      ktx2Loader.loadAsync(asset.normalUrl),
      ktx2Loader.loadAsync(asset.ormUrl),
      asset.emissiveUrl ? ktx2Loader.loadAsync(asset.emissiveUrl) : Promise.resolve(null),
    ];
    const [baseTex, normalTex, ormTex, emissiveTex] = await Promise.all(loads);
    if (token !== loadToken) {
      baseTex?.dispose();
      normalTex?.dispose();
      ormTex?.dispose();
      emissiveTex?.dispose();
      return;
    }

    const allTex = [baseTex, normalTex, ormTex, emissiveTex].filter(
      (t): t is THREE.CompressedTexture => t !== null,
    );
    for (const tex of allTex) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 2);
      tex.needsUpdate = true;
    }
    if (baseTex) baseTex.colorSpace = THREE.SRGBColorSpace;
    if (normalTex) normalTex.colorSpace = THREE.NoColorSpace;
    if (ormTex) ormTex.colorSpace = THREE.NoColorSpace;
    if (emissiveTex) emissiveTex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshStandardMaterial({
      map: baseTex,
      normalMap: normalTex,
      aoMap: ormTex,
      roughnessMap: ormTex,
      metalnessMap: ormTex,
      roughness: 1,
      metalness: 1,
      emissive: emissiveTex ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
      emissiveMap: emissiveTex,
      emissiveIntensity: emissiveTex ? 1.5 : 0,
    });

    const group = new THREE.Group();

    const sphereGeo = new THREE.SphereGeometry(0.36, 48, 32);
    sphereGeo.setAttribute('uv2', sphereGeo.attributes.uv);
    const sphere = new THREE.Mesh(sphereGeo, mat);
    sphere.position.set(-0.42, 0.36, 0);
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    group.add(sphere);

    const tileGeo = new THREE.BoxGeometry(0.68, 0.68, 0.08);
    tileGeo.setAttribute('uv2', tileGeo.attributes.uv);
    const tile = new THREE.Mesh(tileGeo, mat);
    tile.position.set(0.42, 0.36, 0);
    tile.castShadow = true;
    tile.receiveShadow = true;
    group.add(tile);

    modelRoot.add(group);
    applyWireframe(wireframeEnabled);
    frameObject(group, false);

    renderLiveStats([
      'Live KTX2 UASTC',
      '2×2 tile repeat',
      emissiveTex ? 'BaseColor + Normal + ORM + Emissive' : 'BaseColor + Normal + ORM',
    ]);
    setLoading(false);
  } catch (err) {
    if (token !== loadToken) return;
    setLoading(false);
    setError(`Could not decode KTX2 material: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadImageAsset(asset: ImageAssetEntry): void {
  clearModelRoot();
  animBar.hidden = true;
  canvasStage.hidden = true;
  imageStage.hidden = false;
  controls3d.hidden = true;
  controls2d.hidden = false;
  imageStageInner.replaceChildren();

  if (asset.kind === 'icon') {
    const wrap = document.createElement('div');
    wrap.className = 'icon-showcase';

    const specs: readonly { label: string; size: number; cardClass: string }[] = [
      { label: '128 px · Dark', size: 128, cardClass: 'dark-card' },
      { label: '128 px · Light', size: 128, cardClass: 'light-card' },
      { label: '48 px · Radial', size: 48, cardClass: 'dark-card' },
      { label: '24 px · HUD Dark', size: 24, cardClass: 'dark-card' },
      { label: '24 px · HUD Light', size: 24, cardClass: 'light-card' },
    ];

    for (const spec of specs) {
      const card = document.createElement('div');
      card.className = `icon-card ${spec.cardClass}`;
      const img = document.createElement('img');
      img.src = asset.imageUrl;
      img.alt = asset.name;
      img.width = spec.size;
      img.height = spec.size;
      const lbl = document.createElement('span');
      lbl.className = 'icon-card-label';
      lbl.textContent = spec.label;
      card.append(img, lbl);
      wrap.appendChild(card);
    }
    imageStageInner.appendChild(wrap);
  } else {
    const img = document.createElement('img');
    img.src = asset.imageUrl;
    img.alt = asset.name;
    img.className = 'preview-hero-img';
    imageStageInner.appendChild(img);
  }
}

function syncSegmentedButtons(container: HTMLElement, dataAttr: string, activeValue: string): void {
  const buttons = container.querySelectorAll<HTMLButtonElement>(`button[data-${dataAttr}]`);
  for (const btn of buttons) {
    btn.classList.toggle('active', btn.dataset[dataAttr] === activeValue);
  }
}

function selectAsset(id: string): void {
  const asset = ASSETS.find((a) => a.id === id) ?? filteredAssets[0] ?? ASSETS[0];
  if (!asset) return;

  selectedAssetId = asset.id;
  loadToken += 1;
  const token = loadToken;

  const idxInFiltered = filteredAssets.findIndex((a) => a.id === asset.id);
  const displayIdx = idxInFiltered >= 0 ? idxInFiltered + 1 : ASSETS.indexOf(asset) + 1;
  const displayTotal = idxInFiltered >= 0 ? filteredAssets.length : ASSETS.length;

  assetIndexEl.textContent = `${displayIdx} / ${displayTotal}`;
  assetCategoryEl.textContent = asset.category;
  assetScoreEl.textContent = `Approved · ${asset.score}/100`;
  assetNameEl.textContent = asset.name;
  assetSubtitleEl.textContent = asset.subtitle;

  history.replaceState(null, '', `#${asset.id}`);

  const items = assetListEl.querySelectorAll<HTMLButtonElement>('.asset-item');
  for (const item of items) {
    const isActive = item.dataset.id === asset.id;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', String(isActive));
    if (isActive) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }

  if (asset.kind === 'model') {
    void loadModelAsset(asset, token);
  } else if (asset.kind === 'material') {
    void loadMaterialAsset(asset, token);
  } else {
    loadImageAsset(asset);
  }
}

function stepAsset(delta: number): void {
  if (filteredAssets.length === 0) return;
  const currentIdx = filteredAssets.findIndex((a) => a.id === selectedAssetId);
  const baseIdx = currentIdx >= 0 ? currentIdx : 0;
  const nextIdx = (baseIdx + delta + filteredAssets.length) % filteredAssets.length;
  const target = filteredAssets[nextIdx];
  if (target) {
    selectAsset(target.id);
  }
}

function renderSidebar(): void {
  const q = searchQuery.trim().toLowerCase();
  filteredAssets = ASSETS.filter((asset) => {
    if (activeCategory !== 'All' && asset.category !== activeCategory) return false;
    if (!q) return true;
    return (
      asset.name.toLowerCase().includes(q) ||
      asset.id.toLowerCase().includes(q) ||
      asset.category.toLowerCase().includes(q)
    );
  });

  assetListEl.replaceChildren();
  for (const asset of filteredAssets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'asset-item';
    btn.role = 'option';
    btn.dataset.id = asset.id;
    const isActive = asset.id === selectedAssetId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));

    const main = document.createElement('div');
    main.className = 'asset-item-main';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'asset-item-name';
    nameSpan.textContent = asset.name;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'asset-item-meta';
    metaSpan.textContent = asset.kind === 'model' ? asset.rigSummary : asset.category;

    main.append(nameSpan, metaSpan);

    const tag = document.createElement('span');
    tag.className = 'asset-item-tag';
    tag.textContent = asset.kind === 'model' ? '3D▸' : asset.kind === 'material' ? 'PBR' : '2D';

    btn.append(main, tag);
    btn.addEventListener('click', () => selectAsset(asset.id));
    assetListEl.appendChild(btn);
  }
}

function renderCategoryTabs(): void {
  categoryTabsEl.replaceChildren();
  for (const cat of CATEGORIES) {
    const count = cat === 'All' ? ASSETS.length : ASSETS.filter((a) => a.category === cat).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-tab';
    btn.classList.toggle('active', cat === activeCategory);
    btn.textContent = `${cat} (${count})`;
    btn.addEventListener('click', () => {
      activeCategory = cat;
      renderCategoryTabs();
      renderSidebar();
      if (filteredAssets.length > 0 && !filteredAssets.some((a) => a.id === selectedAssetId)) {
        const first = filteredAssets[0];
        if (first) selectAsset(first.id);
      } else {
        selectAsset(selectedAssetId);
      }
    });
    categoryTabsEl.appendChild(btn);
  }
}

function setLightingPreset(preset: 'studio' | 'dramatic' | 'bright'): void {
  if (preset === 'studio') {
    renderer.toneMappingExposure = 1.15;
    hemiLight.intensity = 0.75;
    keyLight.intensity = 2.4;
    rimLight.intensity = 1.15;
    fillLight.intensity = 0.55;
  } else if (preset === 'dramatic') {
    renderer.toneMappingExposure = 1.0;
    hemiLight.intensity = 0.25;
    keyLight.intensity = 3.2;
    rimLight.intensity = 2.2;
    fillLight.intensity = 0.2;
  } else {
    renderer.toneMappingExposure = 1.45;
    hemiLight.intensity = 1.35;
    keyLight.intensity = 2.6;
    rimLight.intensity = 1.1;
    fillLight.intensity = 1.0;
  }
}

function toggleAnimPlay(): void {
  animPaused = !animPaused;
  if (activeAction) activeAction.paused = animPaused;
  if (activeMountAction) activeMountAction.paused = animPaused;
  syncAnimationUi();
}

// Event bindings
prevBtn.addEventListener('click', () => stepAsset(-1));
nextBtn.addEventListener('click', () => stepAsset(1));

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderSidebar();
});

lodGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-lod]');
  if (!btn) return;
  currentLod = btn.dataset.lod === '1' ? 1 : 0;
  selectAsset(selectedAssetId);
});

mountGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mount]');
  if (!btn) return;
  const val = btn.dataset.mount;
  if (val === 'surface-clamp' || val === 'hover-pod' || val === 'none') {
    currentMount = val;
    selectAsset(selectedAssetId);
  }
});

bossPhaseGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-phase]');
  if (!btn) return;
  currentBossPhase = btn.dataset.phase === '2' ? 2 : 1;
  syncSegmentedButtons(bossPhaseGroup, 'phase', String(currentBossPhase));
  applyBroodlordPhase(currentBossPhase);
});

materialViewGroup.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-matview]');
  if (!btn) return;
  currentMatView = btn.dataset.matview === 'proof' ? 'proof' : '3d';
  selectAsset(selectedAssetId);
});

animPlayBtn.addEventListener('click', toggleAnimPlay);

animBar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-speed]');
  if (!btn) return;
  const parsed = Number.parseFloat(btn.dataset.speed ?? '1');
  if (Number.isFinite(parsed) && parsed > 0) {
    playbackSpeed = parsed;
    if (activeAction) activeAction.timeScale = playbackSpeed;
    if (activeMountAction) activeMountAction.timeScale = playbackSpeed;
    syncSegmentedButtons(animBar, 'speed', String(parsed));
  }
});

animScrubber.addEventListener('pointerdown', () => {
  isScrubbing = true;
});
animScrubber.addEventListener('pointerup', () => {
  isScrubbing = false;
});
animScrubber.addEventListener('input', () => {
  const t = Number.parseFloat(animScrubber.value);
  if (!Number.isFinite(t) || !activeAction) return;
  activeAction.time = t;
  if (mixer) mixer.update(0);
  if (activeMountAction && mountMixer) {
    const mDur = activeMountAction.getClip().duration;
    activeMountAction.time = mDur > 0 ? t % mDur : 0;
    mountMixer.update(0);
  }
  const dur = activeAction.getClip().duration;
  animTimeLabel.textContent = `${t.toFixed(2)} / ${dur.toFixed(2)}s`;
});

controls3d.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-light]');
  if (!btn) return;
  const val = btn.dataset.light;
  if (val === 'studio' || val === 'dramatic' || val === 'bright') {
    setLightingPreset(val);
    syncSegmentedButtons(controls3d, 'light', val);
  }
});

controls2d.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-bg]');
  if (!btn) return;
  const val = btn.dataset.bg;
  if (val === 'dark' || val === 'light' || val === 'checker') {
    imageStageInner.classList.remove('bg-dark', 'bg-light', 'bg-checker');
    imageStageInner.classList.add(`bg-${val}`);
    syncSegmentedButtons(controls2d, 'bg', val);
  }
});

rigBtn.addEventListener('click', () => setRigOverlayVisible(!rigOverlayVisible));

rotateBtn.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  rotateBtn.classList.toggle('active', controls.autoRotate);
});

wireframeBtn.addEventListener('click', () => {
  wireframeEnabled = !wireframeEnabled;
  wireframeBtn.classList.toggle('active', wireframeEnabled);
  applyWireframe(wireframeEnabled);
});

gridBtn.addEventListener('click', () => {
  floorGroup.visible = !floorGroup.visible;
  gridBtn.classList.toggle('active', floorGroup.visible);
});

resetCamBtn.addEventListener('click', () => {
  camera.position.copy(defaultCamPos);
  controls.target.copy(defaultCamTarget);
  controls.update();
});

window.addEventListener('keydown', (e) => {
  if (document.activeElement === searchInput) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepAsset(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepAsset(-1);
  } else if (e.key === 'p' || e.key === 'P') {
    if (!animBar.hidden) {
      e.preventDefault();
      toggleAnimPlay();
    }
  } else if (e.key === 'r' || e.key === 'R') {
    if (!canvasStage.hidden) {
      e.preventDefault();
      setRigOverlayVisible(!rigOverlayVisible);
    }
  } else if (e.key === ' ' && !canvasStage.hidden) {
    e.preventDefault();
    controls.autoRotate = !controls.autoRotate;
    rotateBtn.classList.toggle('active', controls.autoRotate);
  }
});

// Resize & Render loop
function resizeRenderer(): void {
  const rect = canvasStage.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  renderer.setSize(rect.width, rect.height, false);
}

const resizeObserver = new ResizeObserver(resizeRenderer);
resizeObserver.observe(canvasStage);
window.addEventListener('resize', resizeRenderer);

function updatePortalShaderUniforms(dt: number): void {
  if (!activePortalShader || !activePortalInterior) return;
  const uniforms = activePortalShader.uniforms as RiftPortalShaderUniforms;
  portalShaderTime += dt * (animPaused ? 0.35 : playbackSpeed);
  uniforms.uTime.value = portalShaderTime;

  const openVal = THREE.MathUtils.clamp(activePortalInterior.scale.x, 0, 1);
  uniforms.uOpen.value = openVal;

  let surge = 0;
  if (activeAction && activeClipName === 'spawn_surge') {
    const dur = Math.max(activeAction.getClip().duration, 0.001);
    const u = (activeAction.time % dur) / dur;
    surge = Math.sin(Math.PI * u) ** 1.35;
  }
  uniforms.uSurge.value = surge;
}

const clock = new THREE.Clock();
function tick(): void {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!isScrubbing) {
    if (mixer) mixer.update(dt);
    if (mountMixer) mountMixer.update(dt);
    if (activeAction) {
      const dur = activeAction.getClip().duration;
      const cur = dur > 0 ? activeAction.time % dur : 0;
      animScrubber.value = String(cur);
      animTimeLabel.textContent = `${cur.toFixed(2)} / ${dur.toFixed(2)}s`;
    }
  }
  updatePortalShaderUniforms(dt);
  controls.update();
  if (!canvasStage.hidden) {
    renderer.render(scene, camera);
  }
}

// Init
renderCategoryTabs();
renderSidebar();
resizeRenderer();

const hashId = window.location.hash.replace(/^#/, '');
const initial = ASSETS.find((a) => a.id === hashId)?.id ?? ASSETS[0]?.id ?? 'core-bastion';
selectAsset(initial);
tick();
