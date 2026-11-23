import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  applyDepthOcclusion,
  configurePortalInteriorMaterial,
  configurePortalRimMaterial,
  createOcclusionController,
  createPortalApertureMaskMesh,
  cutPortalApertures,
  evaluateDepthOcclusionSample,
  type OcclusionState,
  type OcclusionSurface,
  PORTAL_APERTURE_STENCIL_REF,
  type PortalAperture,
  ROOM_OCCLUDER_RENDER_ORDER,
} from '../src/mr/occlusion.ts';
import {
  buildShadowCatcherGeometry,
  createShadowCatcherManager,
  DEFAULT_SHADOW_ELEVATION_OFFSET,
  DEFAULT_SHADOW_OPACITY,
  isEligibleShadowSurface,
  SHADOW_CATCHER_RENDER_ORDER,
  type ShadowCatcherSurface,
} from '../src/mr/shadow-catchers.ts';

function makeWallPlaneSurface(
  id: string,
  zPos: number,
  width = 4.0,
  height = 2.8,
  revision = 1,
): OcclusionSurface {
  // Local XZ plane rotated +90° around X puts local +Y normal along world +Z (facing into the room)
  // and local -Z along world +Y.
  const worldMatrix = new THREE.Matrix4()
    .makeRotationX(Math.PI / 2)
    .setPosition(0, height / 2, zPos);
  const hw = width / 2;
  const hh = height / 2;
  return {
    id,
    kind: 'wall',
    source: 'plane',
    revision,
    worldMatrix,
    normal: new THREE.Vector3(0, 0, 1),
    polygon: [
      { x: -hw, z: -hh },
      { x: hw, z: -hh },
      { x: hw, z: hh },
      { x: -hw, z: hh },
    ],
  };
}

function makeWallMeshSurface(
  id: string,
  zPos: number,
  width = 4.0,
  height = 2.8,
  revision = 1,
  kind: OcclusionSurface['kind'] = 'other',
): OcclusionSurface {
  const hw = width / 2;
  const vertices = new Float32Array([
    -hw,
    0,
    zPos,
    hw,
    0,
    zPos,
    hw,
    height,
    zPos,
    -hw,
    height,
    zPos,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    id,
    kind,
    source: 'mesh',
    revision,
    worldMatrix: new THREE.Matrix4().identity(),
    vertices,
    indices,
  };
}

function makeCeilingPlaneSurface(
  id: string,
  yPos: number,
  width = 4.8,
  depth = 4.2,
  revision = 1,
): OcclusionSurface {
  // Rotate 180° around X so local +Y points down (0, -1, 0) into the room.
  const worldMatrix = new THREE.Matrix4().makeRotationX(Math.PI).setPosition(0, yPos, 0);
  const hw = width / 2;
  const hd = depth / 2;
  return {
    id,
    kind: 'ceiling',
    source: 'plane',
    revision,
    worldMatrix,
    normal: new THREE.Vector3(0, -1, 0),
    polygon: [
      { x: -hw, z: -hd },
      { x: hw, z: -hd },
      { x: hw, z: hd },
      { x: -hw, z: hd },
    ],
  };
}

function makeCeilingMeshSurface(
  id: string,
  yPos: number,
  width = 4.8,
  depth = 4.2,
  revision = 1,
): OcclusionSurface {
  const hw = width / 2;
  const hd = depth / 2;
  const vertices = new Float32Array([-hw, yPos, -hd, hw, yPos, -hd, hw, yPos, hd, -hw, yPos, hd]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    id,
    kind: 'ceiling',
    source: 'mesh',
    revision,
    worldMatrix: new THREE.Matrix4().identity(),
    vertices,
    indices,
  };
}

function makeFloorSurface(
  id: string,
  yPos = 0,
  width = 4.8,
  depth = 4.2,
  revision = 1,
  kind: ShadowCatcherSurface['kind'] = 'floor',
  visible = true,
): ShadowCatcherSurface {
  const hw = width / 2;
  const hd = depth / 2;
  return {
    id,
    kind,
    source: 'plane',
    revision,
    visible,
    worldMatrix: new THREE.Matrix4().makeTranslation(0, yPos, 0),
    normal: new THREE.Vector3(0, 1, 0),
    polygon: [
      { x: -hw, z: -hd },
      { x: hw, z: -hd },
      { x: hw, z: hd },
      { x: -hw, z: hd },
    ],
  };
}

interface FakeCpuDepthOptions {
  width?: number;
  height?: number;
  rawValueToMeters?: number;
  format?: 'luminance-alpha' | 'float32';
  normMatrix?: number[];
  fillMeters?: number;
}

function makeFakeCpuDepthInfo(opts: FakeCpuDepthOptions = {}): XRCPUDepthInformation {
  const width = opts.width ?? 4;
  const height = opts.height ?? 4;
  const format = opts.format ?? 'luminance-alpha';
  const rawValueToMeters = opts.rawValueToMeters ?? (format === 'float32' ? 1.0 : 0.001);
  const fillMeters = opts.fillMeters ?? 1.5;

  let data: ArrayBuffer;
  if (format === 'float32') {
    const arr = new Float32Array(width * height);
    arr.fill(fillMeters / rawValueToMeters);
    data = arr.buffer;
  } else {
    const arr = new Uint16Array(width * height);
    arr.fill(Math.round(fillMeters / rawValueToMeters));
    data = arr.buffer;
  }

  const matrix = new Float32Array(
    opts.normMatrix ?? [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1],
  );

  return {
    width,
    height,
    data,
    rawValueToMeters,
    normDepthBufferFromNormView: { matrix } as unknown as XRRigidTransform,
    getDepthInMeters: () => fillMeters,
  };
}

function makeFakeXrFrame(options: {
  enabledFeatures?: readonly string[];
  depthUsage?: string;
  depthDataFormat?: string;
  views?: XRView[];
  cpuDepthByView?: Map<XRView, XRCPUDepthInformation | null>;
  omitGetDepthInformation?: boolean;
}): { frame: XRFrame; referenceSpace: XRReferenceSpace; views: XRView[] } {
  const views = options.views ?? ([{ eye: 'left' }, { eye: 'right' }] as unknown as XRView[]);
  const referenceSpace = {} as XRReferenceSpace;
  const session = {
    enabledFeatures: options.enabledFeatures ?? ['depth-sensing', 'plane-detection'],
    depthUsage: options.depthUsage,
    depthDataFormat: options.depthDataFormat,
  } as unknown as XRSession;

  const frameObj: Record<string, unknown> = {
    session,
    getViewerPose: vi.fn(() => ({ views }) as unknown as XRViewerPose),
  };
  if (!options.omitGetDepthInformation) {
    frameObj.getDepthInformation = vi.fn((view: XRView) => {
      if (options.cpuDepthByView) {
        return options.cpuDepthByView.get(view) ?? null;
      }
      return makeFakeCpuDepthInfo();
    });
  }
  return {
    frame: frameObj as unknown as XRFrame,
    referenceSpace,
    views,
  };
}

describe('MR Occlusion Controller — mode transitions and fallback detection', () => {
  it('falls back cleanly from auto-depth to room-mesh when getDepthInformation is unavailable', () => {
    const controller = createOcclusionController();
    const transitions: OcclusionState[] = [];
    const unsub = controller.subscribe((state) => transitions.push(state));

    // Before any XR depth arrives, auto-depth gracefully falls back to room-mesh.
    expect(controller.requestedMode).toBe('auto-depth');
    expect(controller.effectiveMode).toBe('room-mesh');
    expect(controller.roomMeshRoot.visible).toBe(true);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(0);

    // Frame without getDepthInformation keeps room-mesh fallback active.
    const noDepth = makeFakeXrFrame({ omitGetDepthInformation: true });
    expect(controller.updateFromXrFrame(noDepth.frame, noDepth.referenceSpace)).toBe('room-mesh');
    expect(controller.state.depthAvailable).toBe(false);
    expect(controller.roomMeshRoot.visible).toBe(true);

    // Frame with working CPU depth promotes auto-depth to depth-sensing.
    const withDepth = makeFakeXrFrame({ depthDataFormat: 'luminance-alpha' });
    expect(controller.updateFromXrFrame(withDepth.frame, withDepth.referenceSpace)).toBe(
      'depth-sensing',
    );
    expect(controller.state.depthAvailable).toBe(true);
    expect(controller.state.depthSource).toBe('cpu');
    expect(controller.roomMeshRoot.visible).toBe(false);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(1);

    // Runtime transitions: auto-depth -> room-mesh -> off -> auto-depth.
    expect(controller.setMode('room-mesh')).toBe('room-mesh');
    expect(controller.roomMeshRoot.visible).toBe(true);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(0);

    expect(controller.setMode('off')).toBe('off');
    expect(controller.roomMeshRoot.visible).toBe(false);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(0);

    expect(controller.setMode('auto-depth')).toBe('depth-sensing');
    expect(controller.roomMeshRoot.visible).toBe(false);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(1);

    // Depth loss (returns null) falls back to room-mesh immediately.
    const emptyMap = new Map<XRView, XRCPUDepthInformation | null>();
    const lostDepth = makeFakeXrFrame({ cpuDepthByView: emptyMap });
    expect(controller.updateFromXrFrame(lostDepth.frame, lostDepth.referenceSpace)).toBe(
      'room-mesh',
    );
    expect(controller.state.depthAvailable).toBe(false);
    expect(controller.roomMeshRoot.visible).toBe(true);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(0);

    expect(transitions.map((s) => s.effectiveMode)).toEqual([
      'depth-sensing',
      'room-mesh',
      'off',
      'depth-sensing',
      'room-mesh',
    ]);

    unsub();
    controller.dispose();
  });

  it('falls back to room-mesh when depth-sensing is not in enabledFeatures or after resetDepth()', () => {
    const controller = createOcclusionController();
    const withDepth = makeFakeXrFrame({ depthDataFormat: 'luminance-alpha' });
    expect(controller.updateFromXrFrame(withDepth.frame, withDepth.referenceSpace)).toBe(
      'depth-sensing',
    );

    // Session without depth-sensing granted -> fallback even if frame method exists.
    const ungranted = makeFakeXrFrame({ enabledFeatures: ['plane-detection', 'local-floor'] });
    expect(controller.updateFromXrFrame(ungranted.frame, ungranted.referenceSpace)).toBe(
      'room-mesh',
    );

    // Re-enable and then simulate XR session end via resetDepth().
    expect(controller.updateFromXrFrame(withDepth.frame, withDepth.referenceSpace)).toBe(
      'depth-sensing',
    );
    controller.resetDepth();
    expect(controller.effectiveMode).toBe('room-mesh');
    expect(controller.state.depthAvailable).toBe(false);

    controller.dispose();
  });

  it('skips depth texture reads when mode is room-mesh or off', () => {
    const controller = createOcclusionController({ initialMode: 'room-mesh' });
    const fake = makeFakeXrFrame({});
    expect(controller.updateFromXrFrame(fake.frame, fake.referenceSpace)).toBe('room-mesh');
    expect(fake.frame.getDepthInformation).not.toHaveBeenCalled();

    controller.setMode('off');
    expect(controller.updateFromXrFrame(fake.frame, fake.referenceSpace)).toBe('off');
    expect(fake.frame.getDepthInformation).not.toHaveBeenCalled();

    controller.dispose();
  });
});

describe('MR Occlusion Controller — depth-uniform updates & zero-allocation texture reuse', () => {
  it('reuses the exact DataTexture and backing buffer across frames without reallocations', () => {
    const controller = createOcclusionController();
    const views = [{ eye: 'left' }, { eye: 'right' }] as unknown as XRView[];

    const leftMat1 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1];
    const rightMat1 = [0.5, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0.5, 1, 0, 1];

    const map1 = new Map<XRView, XRCPUDepthInformation | null>([
      [
        views[0] as XRView,
        makeFakeCpuDepthInfo({
          width: 8,
          height: 6,
          rawValueToMeters: 0.001,
          fillMeters: 1.25,
          normMatrix: leftMat1,
        }),
      ],
      [
        views[1] as XRView,
        makeFakeCpuDepthInfo({
          width: 8,
          height: 6,
          rawValueToMeters: 0.002,
          fillMeters: 2.5,
          normMatrix: rightMat1,
        }),
      ],
    ]);
    const frame1 = makeFakeXrFrame({
      views,
      cpuDepthByView: map1,
      depthDataFormat: 'luminance-alpha',
    });
    expect(controller.updateFromXrFrame(frame1.frame, frame1.referenceSpace)).toBe('depth-sensing');

    const slot0Before = controller.getViewDepthState(0);
    const slot1Before = controller.getViewDepthState(1);
    expect(slot0Before?.dataTexture).toBeInstanceOf(THREE.DataTexture);
    expect(slot1Before?.dataTexture).toBeInstanceOf(THREE.DataTexture);
    expect(slot0Before?.dataTexture?.format).toBe(THREE.RGFormat);
    expect(slot0Before?.dataTexture?.type).toBe(THREE.UnsignedByteType);
    expect(slot0Before?.width).toBe(8);
    expect(slot0Before?.height).toBe(6);

    const version0Before = slot0Before?.dataTexture?.version ?? 0;
    const version1Before = slot1Before?.dataTexture?.version ?? 0;

    // Verify uniforms reflect view 0 by default and switch to view 1 via bindView/bindCamera.
    expect(controller.uniforms.uRbRawValueToMeters.value).toBeCloseTo(0.001);
    expect(controller.uniforms.uRbNormDepthFromNormView.value.elements).toEqual(leftMat1);

    const leftCam = new THREE.PerspectiveCamera();
    const rightCam = new THREE.PerspectiveCamera();
    expect(controller.bindCamera(rightCam, { cameras: [leftCam, rightCam] })).toBe(1);
    expect(controller.uniforms.uRbRawValueToMeters.value).toBeCloseTo(0.002);
    expect(controller.uniforms.uRbNormDepthFromNormView.value.elements).toEqual(rightMat1);
    expect(controller.uniforms.uRbDepthTex.value).toBe(slot1Before?.dataTexture);

    // Frame 2: same dimensions & format, new depth values -> MUST reuse DataTexture + backing buffer!
    const map2 = new Map<XRView, XRCPUDepthInformation | null>([
      [
        views[0] as XRView,
        makeFakeCpuDepthInfo({
          width: 8,
          height: 6,
          rawValueToMeters: 0.001,
          fillMeters: 2.345,
          normMatrix: leftMat1,
        }),
      ],
      [
        views[1] as XRView,
        makeFakeCpuDepthInfo({
          width: 8,
          height: 6,
          rawValueToMeters: 0.001,
          fillMeters: 3.1,
          normMatrix: rightMat1,
        }),
      ],
    ]);
    const frame2 = makeFakeXrFrame({
      views,
      cpuDepthByView: map2,
      depthDataFormat: 'luminance-alpha',
    });
    controller.updateFromXrFrame(frame2.frame, frame2.referenceSpace);

    const slot0After = controller.getViewDepthState(0);
    const slot1After = controller.getViewDepthState(1);

    expect(slot0After?.dataTexture).toBe(slot0Before?.dataTexture);
    expect(slot0After?.backingBuffer).toBe(slot0Before?.backingBuffer);
    expect(slot1After?.dataTexture).toBe(slot1Before?.dataTexture);
    expect(slot1After?.backingBuffer).toBe(slot1Before?.backingBuffer);
    expect(slot0After?.dataTexture?.version).toBeGreaterThan(version0Before);
    expect(slot1After?.dataTexture?.version).toBeGreaterThan(version1Before);

    // Verify new little-endian uint16 depth value (2345 = 0x0929 -> low 0x29=41, high 0x09=9) landed in reused buffer.
    const bytes = new Uint8Array(slot0After?.backingBuffer as ArrayBuffer);
    expect(bytes[0]).toBe(2345 & 0xff);
    expect(bytes[1]).toBe((2345 >> 8) & 0xff);

    // Switching format to float32 reallocates once, disposes old texture, and updates encoding.
    const disposeSpy = vi.spyOn(slot0After?.dataTexture as THREE.DataTexture, 'dispose');
    const floatMap = new Map<XRView, XRCPUDepthInformation | null>([
      [
        views[0] as XRView,
        makeFakeCpuDepthInfo({
          width: 8,
          height: 6,
          format: 'float32',
          rawValueToMeters: 1.0,
          fillMeters: 1.85,
        }),
      ],
    ]);
    const floatFrame = makeFakeXrFrame({
      views: [views[0] as XRView],
      cpuDepthByView: floatMap,
      depthDataFormat: 'float32',
    });
    controller.updateFromXrFrame(floatFrame.frame, floatFrame.referenceSpace);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    const floatSlot = controller.getViewDepthState(0);
    expect(floatSlot?.dataTexture?.format).toBe(THREE.RedFormat);
    expect(floatSlot?.dataTexture?.type).toBe(THREE.FloatType);
    expect(new Float32Array(floatSlot?.backingBuffer as ArrayBuffer)[0]).toBeCloseTo(1.85, 4);
    expect(controller.bindView(1)).toBe(false);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(0);
    expect(controller.bindView(0)).toBe(true);
    expect(controller.uniforms.uRbOccEnabled.value).toBe(1);

    controller.dispose();
  });

  it('acquires GPU-optimized ExternalTexture depth (2D and texture-array) without reallocating', () => {
    const controller = createOcclusionController();
    const views = [{ eye: 'left' }, { eye: 'right' }] as unknown as XRView[];
    const fakeTexA = { id: 'gpu-tex-a' } as unknown as WebGLTexture;
    const fakeTexB = { id: 'gpu-tex-b' } as unknown as WebGLTexture;
    const normMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    let currentTexture = fakeTexA;
    const glBinding = {
      getDepthInformation: vi.fn((view: XRView) => ({
        width: 160,
        height: 160,
        texture: currentTexture,
        textureType: 'texture-array' as XRTextureType,
        imageIndex: view === views[0] ? 0 : 1,
        rawValueToMeters: 1.0,
        normDepthBufferFromNormView: { matrix: normMatrix } as unknown as XRRigidTransform,
      })),
    } as unknown as XRWebGLBinding;

    const fake = makeFakeXrFrame({
      views,
      depthUsage: 'gpu-optimized',
      depthDataFormat: 'float32',
      omitGetDepthInformation: true,
    });

    expect(controller.updateFromXrFrame(fake.frame, fake.referenceSpace, { glBinding })).toBe(
      'depth-sensing',
    );
    expect(controller.state.depthSource).toBe('gpu');
    const firstGpuTex = controller.getViewDepthState(0)?.texture as THREE.ExternalTexture;
    expect(firstGpuTex).toBeInstanceOf(THREE.ExternalTexture);
    expect(firstGpuTex.sourceTexture).toBe(fakeTexA);
    expect(controller.uniforms.uRbDepthArrayTex.value).toBe(firstGpuTex);
    expect(controller.uniforms.uRbDepthArrayLayer.value).toBe(0);

    // Switch to right eye layer 1.
    expect(controller.bindView(1)).toBe(true);
    expect(controller.uniforms.uRbDepthArrayLayer.value).toBe(1);

    // Frame 2 updates underlying WebGLTexture handle on the exact same ExternalTexture wrapper.
    currentTexture = fakeTexB;
    controller.updateFromXrFrame(fake.frame, fake.referenceSpace, { glBinding });
    const secondGpuTex = controller.getViewDepthState(0)?.texture as THREE.ExternalTexture;
    expect(secondGpuTex).toBe(firstGpuTex);
    expect(secondGpuTex.sourceTexture).toBe(fakeTexB);

    controller.dispose();
  });
});

describe('MR Occlusion — shader patch & portal aperture stencil/mask bypass', () => {
  it('patches Three.js materials via onBeforeCompile and configures portal stencil/mask passes', () => {
    const controller = createOcclusionController();
    const prevCompile = vi.fn();
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0x00ffff });
    enemyMat.onBeforeCompile = prevCompile;

    const binding = applyDepthOcclusion(enemyMat, controller);
    expect(binding.role).toBe('world-object');
    expect(enemyMat.customProgramCacheKey()).toContain('rb-depth-occ:world-object');

    const fakeShader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n  #include <project_vertex>\n}',
      fragmentShader: 'void main() {\n  gl_FragColor = vec4(1.0);\n}',
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    enemyMat.onBeforeCompile(fakeShader, {} as THREE.WebGLRenderer);

    expect(prevCompile).toHaveBeenCalledTimes(1);
    expect(fakeShader.uniforms.uRbDepthTex).toBe(controller.uniforms.uRbDepthTex);
    expect(fakeShader.uniforms.uRbNormDepthFromNormView).toBe(
      controller.uniforms.uRbNormDepthFromNormView,
    );
    expect(fakeShader.uniforms.uRbRawValueToMeters).toBe(controller.uniforms.uRbRawValueToMeters);
    expect(fakeShader.uniforms.uRbPortalInvWorld).toBe(controller.uniforms.uRbPortalInvWorld);
    expect(fakeShader.vertexShader).toContain('vRbOccViewZ = -mvPosition.z;');
    expect(fakeShader.fragmentShader).toContain('if ( rbShouldDiscardByDepth() ) discard;');
    expect(fakeShader.fragmentShader).toContain('normViewUv.y = 1.0 - normViewUv.y;');

    // Portal stencil mask mesh writes stencil ref 1 without color or depth writes.
    const portal: PortalAperture = {
      id: 'rift-north',
      center: new THREE.Vector3(0, 1.5, -2.0),
      normal: new THREE.Vector3(0, 0, 1),
      radius: 0.6,
    };
    const maskMesh = createPortalApertureMaskMesh(portal, controller);
    const maskMat = maskMesh.material as THREE.MeshBasicMaterial;
    expect(maskMat.colorWrite).toBe(false);
    expect(maskMat.depthWrite).toBe(false);
    expect(maskMat.stencilWrite).toBe(true);
    expect(maskMat.stencilRef).toBe(PORTAL_APERTURE_STENCIL_REF);
    expect(maskMat.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    expect(maskMat.stencilZPass).toBe(THREE.ReplaceStencilOp);
    expect(maskMesh.position.z).toBeCloseTo(-2.0, 5);

    // Recessed portal interior material tests stencil == 1.
    const interiorMat = new THREE.MeshBasicMaterial({ color: 0x5522aa });
    const interiorBinding = configurePortalInteriorMaterial(interiorMat, controller);
    expect(interiorMat.stencilWrite).toBe(true);
    expect(interiorMat.stencilRef).toBe(PORTAL_APERTURE_STENCIL_REF);
    expect(interiorMat.stencilFunc).toBe(THREE.EqualStencilFunc);
    expect(interiorMat.stencilWriteMask).toBe(0x00);

    // Portal rim material preserves foreground occlusion with wall-flush bias.
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x33ddff });
    const rimBinding = configurePortalRimMaterial(rimMat, controller);
    expect(rimBinding.role).toBe('portal-rim');

    // Disposing binding cleanly restores original callbacks & stencil state.
    binding.dispose();
    expect(enemyMat.onBeforeCompile).toBe(prevCompile);
    interiorBinding.dispose();
    expect(interiorMat.stencilWrite).toBe(false);
    rimBinding.dispose();

    maskMesh.geometry.dispose();
    maskMat.dispose();
    enemyMat.dispose();
    interiorMat.dispose();
    rimMat.dispose();
    controller.dispose();
  });

  it('bypasses physical wall depth inside portal aperture while letting foreground hands occlude rim & interior', () => {
    const portal: PortalAperture = {
      id: 'rift-wall',
      center: new THREE.Vector3(0, 1.5, -2.5),
      normal: new THREE.Vector3(0, 0, 1),
      radius: 0.55,
    };
    const cameraPosition = new THREE.Vector3(0, 1.5, 0);

    // 1. Recessed portal interior 0.6 m behind the wall (viewDepth = 3.1 m); physical wall depth is 2.5 m.
    const interiorBehindWall = evaluateDepthOcclusionSample({
      viewDepthMeters: 3.1,
      envDepthMeters: 2.5,
      worldPosition: new THREE.Vector3(0.1, 1.5, -3.1),
      cameraPosition,
      portals: [portal],
      role: 'portal-interior',
    });
    expect(interiorBehindWall).toEqual({ occluded: false, bypassedByPortal: true });

    // 2. Real player hand at 0.7 m in front of the wall DOES occlude the recessed portal interior!
    const interiorBlockedByHand = evaluateDepthOcclusionSample({
      viewDepthMeters: 3.1,
      envDepthMeters: 0.7,
      worldPosition: new THREE.Vector3(0.1, 1.5, -3.1),
      cameraPosition,
      portals: [portal],
      role: 'portal-interior',
    });
    expect(interiorBlockedByHand).toEqual({ occluded: true, bypassedByPortal: false });

    // 3. Emerging enemy inside the portal cylinder behind wall bypasses wall depth, but NOT a foreground hand.
    const enemyEmerging = evaluateDepthOcclusionSample({
      viewDepthMeters: 2.8,
      envDepthMeters: 2.5,
      worldPosition: new THREE.Vector3(0.0, 1.5, -2.8),
      cameraPosition,
      portals: [portal],
      role: 'world-object',
    });
    expect(enemyEmerging).toEqual({ occluded: false, bypassedByPortal: true });

    const enemyBehindSolidWall = evaluateDepthOcclusionSample({
      viewDepthMeters: 2.8,
      envDepthMeters: 2.5,
      worldPosition: new THREE.Vector3(1.2, 1.5, -2.8), // outside 0.55 m portal radius
      cameraPosition,
      portals: [portal],
      role: 'world-object',
    });
    expect(enemyBehindSolidWall).toEqual({ occluded: true, bypassedByPortal: false });

    // 4. Portal rim flush on the wall (2.5 m) is NOT clipped by wall depth (2.42 m),
    //    but IS occluded by a foreground hand at 0.7 m.
    const rimOnWall = evaluateDepthOcclusionSample({
      viewDepthMeters: 2.5,
      envDepthMeters: 2.42,
      worldPosition: new THREE.Vector3(0.58, 1.5, -2.5),
      cameraPosition,
      portals: [portal],
      role: 'portal-rim',
    });
    expect(rimOnWall.occluded).toBe(false);

    const rimBlockedByHand = evaluateDepthOcclusionSample({
      viewDepthMeters: 2.5,
      envDepthMeters: 0.7,
      worldPosition: new THREE.Vector3(0.58, 1.5, -2.5),
      cameraPosition,
      portals: [portal],
      role: 'portal-rim',
    });
    expect(rimBlockedByHand.occluded).toBe(true);
  });
});

describe('MR Occlusion — dual plane + offset mesh host portal aperture cutouts', () => {
  it('punches clean aligned openings through BOTH co-located wall plane AND offset mesh while keeping surrounding wall and nearby fixtures solid', () => {
    const controller = createOcclusionController({ initialMode: 'room-mesh' });

    const wallPlane = makeWallPlaneSurface('wall-plane-north', -2.0);
    // Offset room mesh sits 6 cm behind the detected plane on the exact same physical wall.
    const wallMesh = {
      ...makeWallMeshSurface('wall-mesh-north', 0),
      worldMatrix: new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 1.4, -2.06),
      meshWorldMatrix: new THREE.Matrix4().makeTranslation(0, 0, -2.06),
    };
    // Nearby fixture crate/partition 40 cm in front of the wall — MUST remain solid!
    const nearbyFixture = makeWallMeshSurface('nearby-fixture', -1.6, 0.8, 0.9, 1, 'table');

    const portal: PortalAperture = {
      id: 'rift-north-1',
      center: new THREE.Vector3(0, 1.5, -2.0),
      normal: new THREE.Vector3(0, 0, 1),
      radius: 0.55,
      hostSurfaceId: 'wall-plane-north',
      hostKind: 'wall',
    };

    controller.setPortals([portal]);
    controller.syncRoomSurfaces([wallPlane, wallMesh, nearbyFixture]);

    const planeOccluder = controller.getOccluderMesh('wall-plane-north') as THREE.Mesh;
    const meshOccluder = controller.getOccluderMesh('wall-mesh-north') as THREE.Mesh;
    const fixtureOccluder = controller.getOccluderMesh('nearby-fixture') as THREE.Mesh;

    expect(planeOccluder).toBeDefined();
    expect(meshOccluder).toBeDefined();
    expect(fixtureOccluder).toBeDefined();
    expect(planeOccluder.renderOrder).toBe(ROOM_OCCLUDER_RENDER_ORDER);

    const occMat = planeOccluder.material as THREE.MeshBasicMaterial;
    expect(occMat.colorWrite).toBe(false);
    expect(occMat.depthWrite).toBe(true);

    controller.root.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    const dualWallOccluders = [planeOccluder, meshOccluder];

    // 1. Straight rays through the center and interior of the aperture pass cleanly through BOTH hosts.
    const interiorPoints: [number, number][] = [
      [0, 1.5],
      [0.35, 1.5],
      [-0.35, 1.5],
      [0, 1.85],
      [0, 1.15],
      [0.36, 1.86], // radius ~ 0.509 < 0.55
      [-0.36, 1.14],
    ];
    for (const [x, y] of interiorPoints) {
      raycaster.set(new THREE.Vector3(x, y, 0), new THREE.Vector3(0, 0, -1));
      const hits = raycaster.intersectObjects(dualWallOccluders, false);
      expect(hits.length).toBe(0);
    }

    // 2. Oblique 45° rays passing near the edge of the portal opening ALSO pass cleanly through BOTH
    //    co-located surfaces (confirming exact alignment to the portal plane with zero oblique seam!).
    const obliqueTarget = new THREE.Vector3(0.49, 1.5, -2.0); // 0.49 < 0.55 radius
    const obliqueOrigin = new THREE.Vector3(-1.01, 1.5, -0.5); // 45° incidence toward +X, -Z
    const obliqueDir = obliqueTarget.clone().sub(obliqueOrigin).normalize();
    raycaster.set(obliqueOrigin, obliqueDir);
    expect(raycaster.intersectObjects(dualWallOccluders, false).length).toBe(0);

    // 3. Surrounding wall rays outside the aperture hit BOTH co-located surfaces solidly at z = -2.00.
    const solidWallPoints: [number, number][] = [
      [1.2, 1.5],
      [-1.2, 1.5],
      [0, 2.45],
      [0, 0.4],
      [0.62, 1.5], // just outside 0.55 m rim
    ];
    for (const [x, y] of solidWallPoints) {
      raycaster.set(new THREE.Vector3(x, y, 0), new THREE.Vector3(0, 0, -1));
      const planeHits = raycaster.intersectObject(planeOccluder, false);
      const meshHits = raycaster.intersectObject(meshOccluder, false);
      expect(planeHits.length).toBe(1);
      expect(meshHits.length).toBe(1);
      // Both hosts share the exact portal plane z = -2.00 so zero oblique passthrough gap exists.
      expect(planeHits[0]?.point.z).toBeCloseTo(-2.0, 4);
      expect(meshHits[0]?.point.z).toBeCloseTo(-2.0, 4);
    }

    // 4. Nearby fixture remains completely solid and uncut.
    raycaster.set(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0, -1));
    const fixtureHits = raycaster.intersectObject(fixtureOccluder, false);
    expect(fixtureHits.length).toBe(1);
    expect(fixtureHits[0]?.point.z).toBeCloseTo(-1.6, 4);

    controller.dispose();
  });

  it('punches openings through BOTH a ceiling plane AND a slightly offset ceiling mesh (webxr.md contract)', () => {
    const ceilingPlane = makeCeilingPlaneSurface('ceiling-plane', 2.8);
    const ceilingMesh = makeCeilingMeshSurface('ceiling-mesh', 2.74); // 6 cm offset into room

    const ceilingPortal: PortalAperture = {
      id: 'rift-ceiling',
      center: new THREE.Vector3(0.4, 2.8, -1.0),
      normal: new THREE.Vector3(0, -1, 0),
      radius: 0.5,
      hostKind: 'ceiling',
    };

    const planeCut = cutPortalApertures(ceilingPlane, [ceilingPortal]);
    const meshCut = cutPortalApertures(ceilingMesh, [ceilingPortal]);

    expect(planeCut.cutPortalIds).toEqual(['rift-ceiling']);
    expect(meshCut.cutPortalIds).toEqual(['rift-ceiling']);
    expect(meshCut.alignedToPortalPlane).toBe(true);

    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const planeObj = new THREE.Mesh(planeCut.geometry, mat);
    const meshObj = new THREE.Mesh(meshCut.geometry, mat);
    planeObj.updateMatrixWorld(true);
    meshObj.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster();
    // Ray straight up through the ceiling portal passes through both.
    raycaster.set(new THREE.Vector3(0.4, 1.2, -1.0), new THREE.Vector3(0, 1, 0));
    expect(raycaster.intersectObjects([planeObj, meshObj], false).length).toBe(0);

    // Ray outside the ceiling portal hits both at y = 2.8.
    raycaster.set(new THREE.Vector3(-1.2, 1.2, -1.0), new THREE.Vector3(0, 1, 0));
    const hitsPlane = raycaster.intersectObject(planeObj, false);
    const hitsMesh = raycaster.intersectObject(meshObj, false);
    expect(hitsPlane.length).toBe(1);
    expect(hitsMesh.length).toBe(1);
    expect(hitsPlane[0]?.point.y).toBeCloseTo(2.8, 4);
    expect(hitsMesh[0]?.point.y).toBeCloseTo(2.8, 4);

    planeCut.geometry.dispose();
    meshCut.geometry.dispose();
    mat.dispose();
  });

  it('rebuilds occluders cleanly when portals change and removes/disposes removed surfaces', () => {
    const controller = createOcclusionController({ initialMode: 'room-mesh' });
    const wall = makeWallPlaneSurface('wall-1', -2.0);
    controller.syncRoomSurfaces([wall]);
    const mesh = controller.getOccluderMesh('wall-1') as THREE.Mesh;
    const oldGeo = mesh.geometry;
    const disposeSpy = vi.spyOn(oldGeo, 'dispose');

    // Adding a portal punches a hole and disposes the previous solid geometry.
    controller.setPortals([
      {
        id: 'p1',
        center: new THREE.Vector3(0, 1.4, -2.0),
        normal: new THREE.Vector3(0, 0, 1),
        radius: 0.45,
      },
    ]);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(mesh.geometry).not.toBe(oldGeo);

    // Removing the wall surface removes the mesh and disposes its geometry.
    const nextGeoDisposeSpy = vi.spyOn(mesh.geometry, 'dispose');
    controller.syncRoomSurfaces([]);
    expect(controller.getOccluderMesh('wall-1')).toBeUndefined();
    expect(controller.state.occluderMeshCount).toBe(0);
    expect(nextGeoDisposeSpy).toHaveBeenCalledTimes(1);

    controller.dispose();
  });
});

describe('MR Shadow Catchers — creation, sync, horizontal filtering, and disposal', () => {
  it('binds ShadowMaterial planes only to horizontal floors and tables with polygonOffset and zero passthrough darkening', () => {
    const manager = createShadowCatcherManager({ opacity: 0.38 });

    expect(manager.material).toBeInstanceOf(THREE.ShadowMaterial);
    expect(manager.material.transparent).toBe(true);
    expect(manager.material.depthWrite).toBe(false);
    expect(manager.material.polygonOffset).toBe(true);
    expect(manager.material.polygonOffsetFactor).toBeLessThan(0);
    expect(manager.material.polygonOffsetUnits).toBeLessThan(0);
    expect(manager.opacity).toBeCloseTo(0.38);

    const floor = makeFloorSurface('floor-main', 0, 4.8, 4.2, 1, 'floor');
    const table = makeFloorSurface('table-center', 0.78, 1.4, 0.8, 1, 'table');
    const wall = makeWallPlaneSurface('wall-north', -2.0) as ShadowCatcherSurface;
    const ceiling = makeCeilingPlaneSurface('ceiling-top', 2.8) as ShadowCatcherSurface;
    const tiltedFakeTable: ShadowCatcherSurface = {
      id: 'tilted-panel',
      kind: 'table',
      revision: 1,
      worldMatrix: new THREE.Matrix4().makeRotationX(Math.PI / 2),
      normal: new THREE.Vector3(0, 0, 1),
      polygon: [
        { x: -1, z: -1 },
        { x: 1, z: -1 },
        { x: 1, z: 1 },
        { x: -1, z: 1 },
      ],
    };

    expect(isEligibleShadowSurface(floor)).toBe(true);
    expect(isEligibleShadowSurface(table)).toBe(true);
    expect(isEligibleShadowSurface(wall)).toBe(false);
    expect(isEligibleShadowSurface(ceiling)).toBe(false);
    expect(isEligibleShadowSurface(tiltedFakeTable)).toBe(false);

    const stats = manager.sync([floor, table, wall, ceiling, tiltedFakeTable]);
    expect(stats).toEqual({ created: 2, updated: 0, removed: 0, activeCount: 2 });
    expect(manager.count).toBe(2);
    expect(manager.getSurfaceIds().sort()).toEqual(['floor-main', 'table-center']);

    const floorMesh = manager.getMesh('floor-main') as THREE.Mesh;
    const tableMesh = manager.getMesh('table-center') as THREE.Mesh;
    expect(floorMesh.receiveShadow).toBe(true);
    expect(floorMesh.castShadow).toBe(false);
    expect(floorMesh.renderOrder).toBe(SHADOW_CATCHER_RENDER_ORDER);
    expect(floorMesh.material).toBe(manager.material);
    expect(tableMesh.material).toBe(manager.material);

    // Verify upward-facing normals and slight elevation offset above y = 0.78.
    const posAttr = tableMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const normAttr = tableMesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i += 1) {
      expect(posAttr.getY(i)).toBeCloseTo(0.78 + DEFAULT_SHADOW_ELEVATION_OFFSET, 5);
      expect(normAttr.getY(i)).toBeCloseTo(1, 5);
    }

    // Live opacity, polygonOffset, and visibility controls.
    manager.setOpacity(0.55);
    expect(manager.opacity).toBeCloseTo(0.55);
    manager.setOpacity(5);
    expect(manager.opacity).toBe(1);
    manager.setOpacity(-2);
    expect(manager.opacity).toBe(0);
    manager.setOpacity(Number.NaN);
    expect(manager.opacity).toBeCloseTo(DEFAULT_SHADOW_OPACITY);

    manager.setPolygonOffset(-4, -3);
    expect(manager.material.polygonOffsetFactor).toBe(-4);
    expect(manager.material.polygonOffsetUnits).toBe(-3);

    manager.setEnabled(false);
    expect(manager.enabled).toBe(false);
    expect(manager.root.visible).toBe(false);

    manager.dispose();
  });

  it('extracts only horizontal tabletop triangles from a 3D box mesh table and handles concave floors', () => {
    const box = new THREE.BoxGeometry(1.2, 0.75, 0.8);
    const pos = box.getAttribute('position');
    const idx = box.getIndex();
    const tableMeshSurface: ShadowCatcherSurface = {
      id: 'table-mesh',
      kind: 'table',
      source: 'mesh',
      revision: 1,
      worldMatrix: new THREE.Matrix4().makeTranslation(0, 0.375, 0),
      vertices: pos.array as Float32Array,
      indices: idx ? (idx.array as Uint16Array) : undefined,
    };

    const geo = buildShadowCatcherGeometry(tableMeshSurface);
    expect(geo).not.toBeNull();
    // Box has 12 triangles total: 2 top (+Y), 2 underside (-Y), 8 vertical sides -> only 2 top kept!
    expect((geo?.getAttribute('position').count ?? 0) / 3).toBe(2);
    const posAttr = geo?.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i += 1) {
      expect(posAttr.getY(i)).toBeCloseTo(0.75 + DEFAULT_SHADOW_ELEVATION_OFFSET, 5);
    }
    geo?.dispose();
    box.dispose();

    // Concave L-shaped floor polygon should triangulate cleanly with upward normals.
    const lFloor: ShadowCatcherSurface = {
      id: 'l-floor',
      kind: 'floor',
      revision: 1,
      worldMatrix: new THREE.Matrix4().identity(),
      polygon: [
        { x: 0, z: 0 },
        { x: 3, z: 0 },
        { x: 3, z: 1 },
        { x: 1, z: 1 },
        { x: 1, z: 3 },
        { x: 0, z: 3 },
      ],
    };
    const lGeo = buildShadowCatcherGeometry(lFloor);
    expect(lGeo).not.toBeNull();
    expect((lGeo?.getAttribute('position').count ?? 0) / 3).toBe(4);
    lGeo?.dispose();
  });

  it('syncs surface revisions, visibility tracking-loss, removal, and disposes cleanly', () => {
    const manager = createShadowCatcherManager();
    const floorV1 = makeFloorSurface('floor-1', 0, 4, 4, 1);
    const tableV1 = makeFloorSurface('table-1', 0.75, 1.2, 0.8, 1, 'table');

    expect(manager.sync([floorV1, tableV1])).toEqual({
      created: 2,
      updated: 0,
      removed: 0,
      activeCount: 2,
    });

    const floorMesh = manager.getMesh('floor-1') as THREE.Mesh;
    const tableMesh = manager.getMesh('table-1') as THREE.Mesh;
    const floorGeoV1 = floorMesh.geometry;
    const floorGeoDisposeSpy = vi.spyOn(floorGeoV1, 'dispose');
    const tableGeoDisposeSpy = vi.spyOn(tableMesh.geometry, 'dispose');
    const matDisposeSpy = vi.spyOn(manager.material, 'dispose');

    // Sync with identical revisions -> zero updates, zero geometry reallocation; visibility updates live.
    const hiddenTable = makeFloorSurface('table-1', 0.75, 1.2, 0.8, 1, 'table', false);
    expect(manager.sync([floorV1, hiddenTable])).toEqual({
      created: 0,
      updated: 0,
      removed: 0,
      activeCount: 2,
    });
    expect(floorMesh.geometry).toBe(floorGeoV1);
    expect(tableMesh.visible).toBe(false);

    // Bump floor revision & remove table -> floor geometry replaced (old disposed), table disposed.
    const floorV2 = makeFloorSurface('floor-1', 0.05, 5, 5, 2);
    expect(manager.sync([floorV2])).toEqual({
      created: 0,
      updated: 1,
      removed: 1,
      activeCount: 1,
    });
    expect(floorGeoDisposeSpy).toHaveBeenCalledTimes(1);
    expect(tableGeoDisposeSpy).toHaveBeenCalledTimes(1);
    expect(floorMesh.geometry).not.toBe(floorGeoV1);
    expect(manager.getMesh('table-1')).toBeUndefined();

    // Final dispose frees remaining geometry and shared material (and is idempotent).
    const floorGeoV2DisposeSpy = vi.spyOn(floorMesh.geometry, 'dispose');
    manager.dispose();
    manager.dispose();
    expect(floorGeoV2DisposeSpy).toHaveBeenCalledTimes(1);
    expect(matDisposeSpy).toHaveBeenCalledTimes(1);
    expect(manager.count).toBe(0);
  });
});

describe('MR Occlusion — elliptical cutouts, FrontSide polygonOffset, and per-eye stereo bind hook', () => {
  it('cuts exact elliptical portal apertures without side bleed-through and uses FrontSide + polygonOffset', () => {
    const controller = createOcclusionController({ initialMode: 'room-mesh' });
    const wall = makeWallPlaneSurface('wall-north', -2.0, 4.0, 2.8);
    const portal: PortalAperture = {
      id: 'rift-elliptical',
      center: new THREE.Vector3(0, 1.4, -2.0),
      normal: new THREE.Vector3(0, 0, 1),
      radius: 0.675,
      radiusX: 0.475,
      radiusY: 0.675,
      hostSurfaceId: 'wall-north',
      hostKind: 'wall',
    };
    controller.setPortals([portal]);
    controller.syncRoomSurfaces([wall]);

    const mesh = controller.getOccluderMesh('wall-north') as THREE.Mesh;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.side).toBe(THREE.FrontSide);
    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBeGreaterThan(0);
    expect(mat.polygonOffsetUnits).toBeGreaterThan(0);

    controller.root.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();

    // Inside horizontal ellipse (x = 0.40 < 0.475) -> passes through
    raycaster.set(new THREE.Vector3(0.4, 1.4, 0), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(mesh, false).length).toBe(0);

    // Outside horizontal ellipse (x = 0.56 > 0.475) even though < 0.675 -> hits solid wall!
    raycaster.set(new THREE.Vector3(0.56, 1.4, 0), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(mesh, false).length).toBe(1);

    // Inside vertical ellipse (y = 1.4 + 0.60, dy = 0.60 < 0.675) -> passes through
    raycaster.set(new THREE.Vector3(0, 2.0, 0), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(mesh, false).length).toBe(0);

    // Back-facing ray from behind the wall (z = -3 -> +Z) is culled by FrontSide
    raycaster.set(new THREE.Vector3(1.2, 1.4, -3), new THREE.Vector3(0, 0, 1));
    expect(raycaster.intersectObject(mesh, false).length).toBe(0);

    // Elliptical aperture mask matches (radiusX, radiusY) and renders DoubleSide
    const mask = createPortalApertureMaskMesh(portal, controller);
    mask.geometry.computeBoundingBox();
    const size = mask.geometry.boundingBox?.getSize(new THREE.Vector3());
    expect(size?.x).toBeCloseTo(0.95, 2);
    expect(size?.y).toBeCloseTo(1.35, 2);
    expect((mask.material as THREE.MeshBasicMaterial).side).toBe(THREE.DoubleSide);

    mask.geometry.dispose();
    (mask.material as THREE.Material).dispose();
    controller.dispose();
  });

  it('binds the active stereo eye depth texture via the zero-triangle onBeforeRender hook', () => {
    const controller = createOcclusionController({ initialMode: 'auto-depth' });
    const views = [{ eye: 'left' }, { eye: 'right' }] as unknown as XRView[];
    const map = new Map<XRView, XRCPUDepthInformation | null>([
      [views[0] as XRView, makeFakeCpuDepthInfo({ rawValueToMeters: 0.001 })],
      [views[1] as XRView, makeFakeCpuDepthInfo({ rawValueToMeters: 0.002 })],
    ]);
    const fake = makeFakeXrFrame({ views, cpuDepthByView: map });
    controller.updateFromXrFrame(fake.frame, fake.referenceSpace);

    const hook = controller.root.getObjectByName('mr-occlusion-eye-bind-hook') as THREE.Mesh;
    expect(hook).toBeDefined();
    expect(hook.geometry.drawRange.count).toBe(0);

    const leftCam = new THREE.PerspectiveCamera();
    const rightCam = new THREE.PerspectiveCamera();
    const fakeRenderer = {
      xr: { isPresenting: true, getCamera: () => ({ cameras: [leftCam, rightCam] }) },
    } as unknown as THREE.WebGLRenderer;

    hook.onBeforeRender(
      fakeRenderer,
      new THREE.Scene(),
      rightCam,
      hook.geometry,
      hook.material as THREE.Material,
      null as unknown as THREE.Group,
    );
    expect(controller.uniforms.uRbRawValueToMeters.value).toBeCloseTo(0.002);

    hook.onBeforeRender(
      fakeRenderer,
      new THREE.Scene(),
      leftCam,
      hook.geometry,
      hook.material as THREE.Material,
      null as unknown as THREE.Group,
    );
    expect(controller.uniforms.uRbRawValueToMeters.value).toBeCloseTo(0.001);

    controller.dispose();
  });

  it('deduplicates coplanar mesh shadow catchers when a scanned plane covers the same floor or table', () => {
    const manager = createShadowCatcherManager();
    const floorPlane = makeFloorSurface('plane-floor', 0, 4.5, 4.0, 1, 'floor');
    const floorMesh: ShadowCatcherSurface = {
      id: 'mesh-floor',
      kind: 'floor',
      source: 'mesh',
      revision: 1,
      worldMatrix: new THREE.Matrix4().makeTranslation(0, 0.01, 0),
      vertices: new Float32Array([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    };
    const separateTableMesh: ShadowCatcherSurface = {
      id: 'mesh-table',
      kind: 'table',
      source: 'mesh',
      revision: 1,
      worldMatrix: new THREE.Matrix4().makeTranslation(0, 0.78, 0),
      vertices: new Float32Array([-0.6, 0, -0.4, 0.6, 0, -0.4, 0.6, 0, 0.4, -0.6, 0, 0.4]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    };

    const stats = manager.sync([floorPlane, floorMesh, separateTableMesh]);
    expect(stats.activeCount).toBe(2);
    expect(manager.getMesh('plane-floor')).toBeDefined();
    expect(manager.getMesh('mesh-floor')).toBeUndefined();
    expect(manager.getMesh('mesh-table')).toBeDefined();

    manager.dispose();
  });

  it('injects bilinear depth sampling and soft portal-interior alpha feathering into custom portal shaders', () => {
    const controller = createOcclusionController({ initialMode: 'auto-depth' });
    const views = [{ eye: 'left' }] as unknown as XRView[];
    const map = new Map<XRView, XRCPUDepthInformation | null>([
      [views[0] as XRView, makeFakeCpuDepthInfo({ width: 160, height: 120 })],
    ]);
    const fake = makeFakeXrFrame({ views, cpuDepthByView: map });
    controller.updateFromXrFrame(fake.frame, fake.referenceSpace);
    expect(controller.uniforms.uRbDepthTexSize.value.x).toBe(160);
    expect(controller.uniforms.uRbDepthTexSize.value.y).toBe(120);

    const mat = new THREE.ShaderMaterial({
      vertexShader: 'void main() {\n  vec3 transformed = position;\n  #include <project_vertex>\n}',
      fragmentShader:
        'void main() {\n  float alpha = 1.0;\n  // RB_PORTAL_ALPHA_HOOK\n  gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);\n}',
    });
    const binding = configurePortalInteriorMaterial(mat, controller);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform<unknown>>,
      vertexShader: mat.vertexShader,
      fragmentShader: mat.fragmentShader,
    };
    mat.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('vRbOccClipPos = gl_Position;');
    expect(shader.fragmentShader).toContain('rbSampleRawDepthMeters');
    expect(shader.fragmentShader).toContain('uRbDepthTexSize');
    expect(shader.fragmentShader).toContain('alpha *= rbPortalForegroundAlpha();');
    expect(shader.uniforms.uRbDepthTexSize).toBe(controller.uniforms.uRbDepthTexSize);

    binding.dispose();
    mat.dispose();
    controller.dispose();
  });
});
