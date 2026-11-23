/**
 * AAA Dimensional Rift Portal GLSL Shader (`src/render/portal-shader.ts`).
 *
 * Renders multi-layer view-parallax violet/teal dimensional vortex depth inside
 * the elliptical Rift Portal aperture with:
 * - True local-space parallax layers (deep abyss, swirling violet plasma, counter-rotating teal tendrils)
 * - Blazing event-horizon rim corona flush against the Rift Portal bezel (zero flat seam)
 * - Uniform-driven center-out radial opening/closing plasma iris (`uOpen`)
 * - Uniform-driven invader breach shockwave surge (`uSurge`)
 *
 * All dynamic states are purely uniform-driven (zero runtime defines/recompiles).
 */

import * as THREE from 'three';

export interface RiftPortalShaderUniforms {
  [uniform: string]: THREE.IUniform<unknown>;
  uTime: THREE.IUniform<number>;
  uOpen: THREE.IUniform<number>;
  uSurge: THREE.IUniform<number>;
  uVortexMap: THREE.IUniform<THREE.Texture | null>;
  uHasVortexMap: THREE.IUniform<number>;
}

export interface RiftPortalShaderOptions {
  readonly vortexMap?: THREE.Texture | null;
  readonly initialOpen?: number;
}

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
varying vec3 vLocalPos;
varying vec3 vLocalViewDir;

void main() {
  vUv = uv;
  vLocalPos = position;

  // Transform camera position into portal-local space for true view-dependent parallax depth
  vec3 camLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vLocalViewDir = normalize(camLocal - position);

  vec3 transformed = position;
  #include <project_vertex>
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uOpen;
uniform float uSurge;
uniform sampler2D uVortexMap;
uniform float uHasVortexMap;

varying vec2 vUv;
varying vec3 vLocalPos;
varying vec3 vLocalViewDir;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float val = 0.0;
  float amp = 0.52;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    val += amp * noise2D(p);
    p = rot * p * 2.04 + vec2(13.1, 7.7);
    amp *= 0.5;
  }
  return val;
}

vec2 swirlCoord(vec2 p, float r, float spinSpeed, float twist) {
  float angle = atan(p.y, p.x);
  float a = angle + twist / (r + 0.22) - uTime * spinSpeed;
  return vec2(cos(a), sin(a)) * r;
}

float starField(vec2 uv, float t) {
  vec2 g = uv * 9.5;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id);
  if (h < 0.86) return 0.0;
  vec2 offset = vec2(hash21(id + 17.3), hash21(id + 31.7)) - 0.5;
  float d = length(f - offset * 0.55);
  float twinkle = 0.55 + 0.45 * sin(t * 3.8 + h * 48.0);
  return smoothstep(0.11, 0.01, d) * twinkle;
}

void main() {
  // Normalized elliptical coordinates: r = 0 at center, r = 1 cleanly along the bezel ring
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.02) discard;

  // Parallax offset from viewing angle (clamped for grazing stability)
  vec3 vDir = normalize(vLocalViewDir);
  float invZ = 1.0 / max(abs(vDir.z), 0.32);
  vec2 para = clamp(vDir.xy * invZ * vec2(0.55, 0.42), vec2(-0.65), vec2(0.65));

  float speedBoost = 1.0 + uSurge * 1.35;
  float t = uTime * speedBoost;

  // Layer 0: Deep dimensional abyss + crisp pinprick cosmic stars
  vec2 pDeep = p - para * 0.42;
  float rDeep = length(pDeep);
  vec2 deepSwirl = swirlCoord(pDeep, rDeep, 0.30, 1.4);
  float abyss = fbm(deepSwirl * 2.4 + vec2(0.0, t * 0.16));
  float stars = starField(pDeep - vec2(t * 0.03, -t * 0.02), t);

  // Layer 1: Mid swirling violet-magenta vortex arms
  vec2 pMid = p - para * 0.22;
  float rMid = length(pMid);
  float angMid = atan(pMid.y, pMid.x);
  float spiralArms = sin(angMid * 3.0 - rMid * 6.8 + t * 2.4) * 0.5 + 0.5;
  vec2 midWarp = swirlCoord(pMid, rMid, 0.88, 2.5);
  float plasma = fbm(midWarp * 3.4 - vec2(t * 0.36, -t * 0.24));
  float midRibbon = smoothstep(0.24, 0.84, plasma * 0.72 + spiralArms * 0.42);

  // Layer 2: Near electric cyan-teal dimensional filaments
  vec2 pNear = p - para * 0.08;
  float rNear = length(pNear);
  vec2 nearWarp = swirlCoord(pNear, rNear, -1.30, -1.95);
  float tendrilNoise = fbm(nearWarp * 5.2 + vec2(t * 0.58, t * 0.32));
  float tendrils = pow(smoothstep(0.45, 0.87, tendrilNoise), 1.85);

  // Optional baked vortex map blend for extra artistic texture richness
  vec3 bakedVortex = vec3(0.0);
  if (uHasVortexMap > 0.5) {
    float rotA = t * 0.42;
    mat2 rm = mat2(cos(rotA), -sin(rotA), sin(rotA), cos(rotA));
    vec2 vUvRot = rm * (pMid * 0.48) + 0.5;
    bakedVortex = texture2D(uVortexMap, clamp(vUvRot, 0.01, 0.99)).rgb;
  }

  // Color palette aligned to Rift Bastion art bible (obsidian void, violet rift, cyan-teal rim)
  vec3 cAbyss = vec3(0.028, 0.014, 0.075);
  vec3 cViolet = vec3(0.44, 0.14, 0.88);
  vec3 cMagenta = vec3(0.74, 0.20, 0.94);
  vec3 cTeal = vec3(0.10, 0.84, 0.96);
  vec3 cCoreHot = vec3(0.68, 0.95, 1.0);

  vec3 col = mix(cAbyss, cViolet * 0.52, abyss);
  col += vec3(0.68, 0.88, 1.0) * stars * (1.0 - smoothstep(0.68, 0.96, r));
  col = mix(col, mix(cViolet, cMagenta, plasma), midRibbon * 0.78);
  col += bakedVortex * 0.32;
  col += cTeal * tendrils * (0.62 + 0.52 * r);

  // Singularity core depth & glow (pulses gently on surge/opening)
  float openMask = clamp(uOpen, 0.0, 1.0);
  float coreGlow = exp(-r * r * (5.6 - uSurge * 1.8));
  col += mix(cViolet, cTeal, 0.55) * coreGlow * (0.38 + 0.62 * uSurge + (1.0 - openMask) * 0.55);

  // Traveling electric cyan shockwave ring on spawn surge
  float surgeWaveR = fract(uTime * 1.35);
  float surgeRing = exp(-pow((r - surgeWaveR) * 14.0, 2.0)) * uSurge;
  col += mix(cTeal, cCoreHot, 0.5) * surgeRing * 0.95;

  // Feathered energy rim corona (modulated by polar noise so it feels alive, never flat white)
  float rimNoise = fbm(vec2(atan(p.y, p.x) * 4.0, t * 2.1));
  float rimBand = smoothstep(0.74, 0.95, r) * (0.65 + 0.55 * rimNoise);
  float rimElectric = smoothstep(0.89, 0.985, r) * (0.55 + 0.65 * rimNoise);
  col += cViolet * rimBand * 0.65;
  col += cTeal * rimElectric * (0.85 + uSurge * 0.45);
  col += cCoreHot * smoothstep(0.955, 0.995, r) * rimNoise * (0.42 + uSurge * 0.25);

  // Organic feathered plasma burn edge while expanding/collapsing from center (uOpen < 0.99)
  float irisActive = 1.0 - smoothstep(0.90, 1.0, openMask);
  float rNoisy = r + (rimNoise - 0.5) * 0.16 * irisActive;
  float burnBand = exp(-pow((rNoisy - 0.86) * 9.5, 2.0)) * irisActive;
  col += mix(cViolet, cTeal, rimNoise) * burnBand * 1.05;
  col += cCoreHot * exp(-pow((rNoisy - 0.90) * 16.0, 2.0)) * irisActive * 0.48;

  // Smooth elliptical opacity fade (feathered while expanding, flush at bezel when fully open)
  float edgeFadeStart = mix(0.76, 0.96, openMask);
  float edgeAlpha = 1.0 - smoothstep(edgeFadeStart, 1.005, rNoisy);
  float openAlpha = smoothstep(0.0, 0.10, openMask);
  float alpha = edgeAlpha * openAlpha * clamp(0.90 + rimElectric * 0.1, 0.0, 1.0);
  // RB_PORTAL_ALPHA_HOOK

  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * Creates a GPU-efficient Three.js ShaderMaterial for the Dimensional Rift Portal aperture.
 */
export function createRiftPortalShaderMaterial(
  options: RiftPortalShaderOptions = {},
): THREE.ShaderMaterial {
  const uniforms: RiftPortalShaderUniforms = {
    uTime: { value: 0 },
    uOpen: { value: options.initialOpen ?? 1 },
    uSurge: { value: 0 },
    uVortexMap: { value: options.vortexMap ?? null },
    uHasVortexMap: { value: options.vortexMap ? 1 : 0 },
  };

  return new THREE.ShaderMaterial({
    name: 'RiftPortalApertureShader',
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
