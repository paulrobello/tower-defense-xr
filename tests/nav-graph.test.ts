import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/prng.ts';
import { createVirtualRoomModel } from '../src/mr/virtual-room.ts';
import {
  buildNavigationGraph,
  computeDisruptorDetourPath,
  DEFAULT_DISRUPTOR_EMP_RADIUS_M,
  distanceVec3,
  distanceXZ2D,
  getDistanceToCore,
  isPointInPolygon2D,
  type NavCoreAnchorInput,
  type NavPortalAnchorInput,
  type NavSurfaceInput,
  recoverStuckCrawler,
  samplePathAtDistance,
  segmentIntersectsPolygonInterior2D,
} from '../src/nav/graph.ts';
import { selectPortalAnchors } from '../src/xr/calibration.ts';

function makeRectNavSurface(params: {
  id: string;
  kind: NavSurfaceInput['kind'];
  center: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  width: number;
  depth: number;
}): NavSurfaceInput {
  const hw = params.width / 2;
  const hd = params.depth / 2;
  const { center, normal } = params;

  if (Math.abs(normal.y) > 0.7) {
    return {
      id: params.id,
      kind: params.kind,
      center,
      normal,
      polygon: [
        { x: center.x - hw, y: center.y, z: center.z - hd },
        { x: center.x + hw, y: center.y, z: center.z - hd },
        { x: center.x + hw, y: center.y, z: center.z + hd },
        { x: center.x - hw, y: center.y, z: center.z + hd },
      ],
    };
  }

  if (Math.abs(normal.z) > 0.7) {
    return {
      id: params.id,
      kind: params.kind,
      center,
      normal,
      polygon: [
        { x: center.x - hw, y: center.y - hd, z: center.z },
        { x: center.x + hw, y: center.y - hd, z: center.z },
        { x: center.x + hw, y: center.y + hd, z: center.z },
        { x: center.x - hw, y: center.y + hd, z: center.z },
      ],
    };
  }

  return {
    id: params.id,
    kind: params.kind,
    center,
    normal,
    polygon: [
      { x: center.x, y: center.y - hd, z: center.z - hw },
      { x: center.x, y: center.y - hd, z: center.z + hw },
      { x: center.x, y: center.y + hd, z: center.z + hw },
      { x: center.x, y: center.y + hd, z: center.z - hw },
    ],
  };
}

describe('P2-T1 Hybrid 3D Room Navigation Graph (src/nav/graph.ts)', () => {
  it('contains ZERO Three.js imports in src/nav/graph.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/nav/graph.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]three['"]/);
    expect(source).not.toMatch(/import\s*\(\s*['"]three['"]\s*\)/);
    expect(source).not.toMatch(/THREE\./);
  });

  it('builds wall and ceiling portal descent splines reaching walkable floor surfaces with climb/drop/floor modes', () => {
    const floor = makeRectNavSurface({
      id: 'floor-main',
      kind: 'floor',
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      width: 5.2,
      depth: 4.8,
    });
    const ceiling = makeRectNavSurface({
      id: 'ceiling-main',
      kind: 'ceiling',
      center: { x: 0, y: 2.8, z: 0 },
      normal: { x: 0, y: -1, z: 0 },
      width: 5.2,
      depth: 4.8,
    });
    const northWall = makeRectNavSurface({
      id: 'wall-north',
      kind: 'wall',
      center: { x: 0, y: 1.4, z: -2.4 },
      normal: { x: 0, y: 0, z: 1 },
      width: 5.2,
      depth: 2.8,
    });

    const coreAnchor: NavCoreAnchorInput = {
      position: { x: 0, y: 0, z: 1.5 },
      surfaceId: 'floor-main',
      surfaceKind: 'floor',
      radius: 0.38,
    };

    const wallPortal: NavPortalAnchorInput = {
      id: 'portal-wall-north',
      position: { x: -0.8, y: 1.55, z: -2.4 },
      normal: { x: 0, y: 0, z: 1 },
      surfaceId: 'wall-north',
      hostKind: 'wall',
    };

    const ceilingPortal: NavPortalAnchorInput = {
      id: 'portal-ceiling-top',
      position: { x: 0.9, y: 2.8, z: -1.1 },
      normal: { x: 0, y: -1, z: 0 },
      surfaceId: 'ceiling-main',
      hostKind: 'ceiling',
    };

    const graph = buildNavigationGraph({
      surfaces: [floor, ceiling, northWall],
      coreAnchor,
      portalAnchors: [wallPortal, ceilingPortal],
    });

    for (const portal of [wallPortal, ceilingPortal]) {
      const path = graph.getSurfacePath(portal.id);
      expect(path).toBeDefined();
      if (!path) continue;

      // Starts at the portal aperture on the wall or ceiling
      const startSample = samplePathAtDistance(path, 0);
      expect(distanceVec3(startSample.position, portal.position)).toBeLessThan(1e-4);
      expect(startSample.locomotionMode).toBe('climb');
      expect(startSample.reachedCore).toBe(false);

      // Reaches the walkable floor surface at landingPosition
      expect(path.landingPosition.y).toBeCloseTo(graph.floorY, 4);
      expect(path.landingWaypointIndex).toBeGreaterThan(0);
      expect(path.landingWaypointIndex).toBeLessThan(path.waypoints.length - 1);

      // Carries 'climb', 'drop', and 'floor' locomotion modes with unit-length surface normals
      const modes = new Set(path.segments.map((seg) => seg.locomotionMode));
      expect(modes.has('climb')).toBe(true);
      expect(modes.has('drop')).toBe(true);
      expect(modes.has('floor')).toBe(true);

      for (const seg of path.segments) {
        const normalLen = Math.hypot(seg.normal.x, seg.normal.y, seg.normal.z);
        const tangentLen = Math.hypot(seg.tangent.x, seg.tangent.y, seg.tangent.z);
        expect(normalLen).toBeCloseTo(1, 4);
        expect(tangentLen).toBeCloseTo(1, 4);
      }

      // All segments after landingWaypointIndex move along the horizontal floor with +Y normal
      for (let i = path.landingWaypointIndex; i < path.segments.length; i += 1) {
        const floorSeg = path.segments[i];
        if (!floorSeg) continue;
        expect(floorSeg.locomotionMode).toBe('floor');
        expect(floorSeg.start.y).toBeCloseTo(graph.floorY, 4);
        expect(floorSeg.end.y).toBeCloseTo(graph.floorY, 4);
        expect(floorSeg.normal.y).toBeCloseTo(1, 4);
      }

      // Terminates at the Core Bastion XZ position on the floor
      const endSample = samplePathAtDistance(path, path.totalLength);
      expect(endSample.reachedCore).toBe(true);
      expect(endSample.distanceToCore).toBe(0);
      expect(endSample.position.x).toBeCloseTo(coreAnchor.position.x, 3);
      expect(endSample.position.z).toBeCloseTo(coreAnchor.position.z, 3);
    }
  });

  it('routes surface crawlers around table obstacle footprints with zero segments intersecting obstacle interiors', () => {
    const virtualModel = createVirtualRoomModel();
    // Place the Core on the floor behind the central and console tables so both tables act as
    // blocking furniture obstacles between the front/side walls and the Core.
    const coreOnFloor: NavCoreAnchorInput = {
      position: { x: 0, y: 0, z: 1.55 },
      surfaceId: 'virtual-floor',
      surfaceKind: 'floor',
      radius: 0.38,
    };

    const portals = selectPortalAnchors({
      surfaces: virtualModel.surfaces,
      coreAnchor: coreOnFloor,
      playerYaw: 0,
      playArc: 'full-360',
    });

    // Also add a portal directly across the central table from the Core (North wall center x=0, z=-2.1)
    const directNorthPortal: NavPortalAnchorInput = {
      id: 'portal-north-direct',
      position: { x: 0, y: 1.4, z: -2.1 },
      normal: { x: 0, y: 0, z: 1 },
      surfaceId: 'virtual-wall-north',
      hostKind: 'wall',
    };

    const graph = buildNavigationGraph({
      roomModel: virtualModel,
      coreAnchor: coreOnFloor,
      portalAnchors: [...portals, directNorthPortal],
    });

    expect(graph.obstacles.length).toBe(2);

    for (const portal of graph.portals) {
      const path = graph.getSurfacePath(portal.id);
      expect(path).toBeDefined();
      if (!path) continue;

      // Verify every floor segment and waypoint stays strictly outside every obstacle interior
      for (const obs of graph.obstacles) {
        for (let i = path.landingWaypointIndex; i < path.waypoints.length; i += 1) {
          const wp = path.waypoints[i];
          if (!wp) continue;
          expect(isPointInPolygon2D(wp.position.x, wp.position.z, obs.polygonXZ, -1e-4)).toBe(
            false,
          );
        }

        for (const seg of path.segments) {
          const intersectsInterior = segmentIntersectsPolygonInterior2D(
            { x: seg.start.x, z: seg.start.z },
            { x: seg.end.x, z: seg.end.z },
            obs.polygonXZ,
            0,
          );
          expect(intersectsInterior).toBe(false);
        }
      }

      // The direct North portal path must deflect around the central table (|x| > 0.7 m)
      if (portal.id === 'portal-north-direct') {
        const maxAbsX = Math.max(...path.waypoints.map((w) => Math.abs(w.position.x)));
        expect(maxAbsX).toBeGreaterThan(0.75);
      }
    }
  });

  it('builds 3D obstacle-clearing aerial flight corridors with distinct lateral lane separation', () => {
    const virtualModel = createVirtualRoomModel();
    const corePos = { x: 0, y: 0.78, z: 0.8 };
    const northPortal: NavPortalAnchorInput = {
      id: 'portal-air-north',
      position: { x: 0, y: 1.5, z: -2.1 },
      normal: { x: 0, y: 0, z: 1 },
      surfaceId: 'virtual-wall-north',
      hostKind: 'wall',
    };

    const graph = buildNavigationGraph({
      roomModel: virtualModel,
      coreAnchor: corePos,
      portalAnchors: [northPortal],
      aerialLaneIndices: [-2, -1, 0, 1, 2],
    });

    const laneIndices = [-2, -1, 0, 1, 2];
    const midCorridorPositions: Array<{ lane: number; x: number; y: number; z: number }> = [];

    for (const lane of laneIndices) {
      const airPath = graph.getAirPath(northPortal.id, lane);
      expect(airPath).toBeDefined();
      if (!airPath) continue;

      expect(airPath.layer).toBe('air');
      expect(airPath.laneIndex).toBe(lane);

      // Every segment uses 'fly' locomotion mode and stays below the ceiling
      for (const seg of airPath.segments) {
        expect(seg.locomotionMode).toBe('fly');
        expect(seg.start.y).toBeLessThan(graph.ceilingY);
        expect(seg.end.y).toBeLessThan(graph.ceilingY);
      }

      // Mid-corridor sample (50% distance) clears obstacle tops and separates laterally by lane
      const midSample = samplePathAtDistance(airPath, airPath.totalLength * 0.5);
      for (const obs of graph.obstacles) {
        expect(midSample.position.y).toBeGreaterThan(obs.maxY + 0.2);
      }
      midCorridorPositions.push({
        lane,
        x: midSample.position.x,
        y: midSample.position.y,
        z: midSample.position.z,
      });
    }

    // Verify adjacent lateral lanes are strictly separated in the mid-corridor (never stacked)
    for (let i = 0; i + 1 < midCorridorPositions.length; i += 1) {
      const a = midCorridorPositions[i];
      const b = midCorridorPositions[i + 1];
      if (!a || !b) continue;
      const horizSep = distanceXZ2D(a, b);
      expect(horizSep).toBeGreaterThan(0.25);
      expect(a.x).toBeLessThan(b.x);
    }
  });

  it('routes Rift Disruptor detour paths near active turrets within EMP radius before continuing to the Core', () => {
    const virtualModel = createVirtualRoomModel();
    const corePos = { x: 0, y: 0.78, z: 1.3 };
    const portalPos = { x: 0, y: 1.5, z: -2.1 };
    const northPortal: NavPortalAnchorInput = {
      id: 'portal-disruptor',
      position: portalPos,
      normal: { x: 0, y: 0, z: 1 },
      surfaceId: 'virtual-wall-north',
      hostKind: 'wall',
    };

    const graph = buildNavigationGraph({
      roomModel: virtualModel,
      coreAnchor: corePos,
      portalAnchors: [northPortal],
    });

    const activeTurrets = [
      { x: -1.15, y: 0.8, z: -0.9 },
      { x: 1.05, y: 0.74, z: 0.2 },
    ];

    const detourPath = computeDisruptorDetourPath(portalPos, activeTurrets, corePos, graph);

    expect(detourPath.layer).toBe('air');
    expect(detourPath.totalLength).toBeGreaterThan(distanceVec3(portalPos, corePos));

    // Verify the Disruptor passes well inside the 1.2 m EMP radius of each active turret
    for (const turretPos of activeTurrets) {
      let minDistanceToTurret = Number.POSITIVE_INFINITY;
      const sampleCount = 48;
      for (let i = 0; i <= sampleCount; i += 1) {
        const s = (i / sampleCount) * detourPath.totalLength;
        const sample = samplePathAtDistance(detourPath, s);
        const d = distanceVec3(sample.position, turretPos);
        if (d < minDistanceToTurret) minDistanceToTurret = d;
      }
      expect(minDistanceToTurret).toBeLessThan(DEFAULT_DISRUPTOR_EMP_RADIUS_M * 0.65);
    }

    // Verify the path still finishes at the Core with strictly monotonic distanceToCore
    let prevDistToCore = detourPath.totalLength + 1;
    for (let i = 0; i <= 32; i += 1) {
      const s = (i / 32) * detourPath.totalLength;
      const sample = samplePathAtDistance(detourPath, s);
      expect(sample.distanceToCore).toBeLessThan(prevDistToCore);
      prevDistToCore = sample.distanceToCore;
    }
    const finalSample = samplePathAtDistance(detourPath, detourPath.totalLength);
    expect(finalSample.reachedCore).toBe(true);
    expect(finalSample.distanceToCore).toBe(0);
    expect(distanceXZ2D(finalSample.position, corePos)).toBeLessThan(1e-4);
  });

  it('recovers stuck crawlers via a 3D leap bridge when a furniture obstacle completely splits the floor', () => {
    const floor = makeRectNavSurface({
      id: 'floor-split',
      kind: 'floor',
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      width: 4.8,
      depth: 4.2,
    });
    // Wall-to-wall furniture barrier across z = 0 completely splitting the North and South floor halves
    const splittingBarrier = makeRectNavSurface({
      id: 'table-splitting-barrier',
      kind: 'table',
      center: { x: 0, y: 0.75, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      width: 5.4,
      depth: 0.6,
    });

    const coreAnchor: NavCoreAnchorInput = {
      position: { x: 0, y: 0, z: 1.45 },
      surfaceId: 'floor-split',
      surfaceKind: 'floor',
      radius: 0.38,
    };

    const northPortal: NavPortalAnchorInput = {
      id: 'portal-north-cut-off',
      position: { x: 0, y: 1.4, z: -2.0 },
      normal: { x: 0, y: 0, z: 1 },
      surfaceId: null,
      hostKind: 'wall',
    };

    const graph = buildNavigationGraph({
      surfaces: [floor, splittingBarrier],
      coreAnchor,
      portalAnchors: [northPortal],
    });

    // Crawler stranded on the North side of the room-splitting obstacle (and another inside the obstacle)
    const strandedPositions = [
      { x: -0.6, y: 0, z: -1.2 },
      { x: 0.2, y: 0, z: 0.0 },
    ];

    for (const pos of strandedPositions) {
      const recovered = recoverStuckCrawler(pos, graph);
      expect(recovered.usedLeap).toBe(true);
      expect(recovered.bridgeWaypoints.length).toBeGreaterThanOrEqual(2);

      // The leap bridge lands on the Core-connected South side of the barrier (z > 0.3 m)
      expect(recovered.targetWaypoint.z).toBeGreaterThan(0.3);
      expect(recovered.targetWaypoint.y).toBeCloseTo(graph.floorY, 4);

      // The leap arc clears the barrier height (0.75 m) in 3D
      const maxLeapY = Math.max(...recovered.bridgeWaypoints.map((w) => w.position.y));
      expect(maxLeapY).toBeGreaterThan(0.75);

      // All post-landing floor segments remain strictly outside the splitting barrier interior
      for (let i = recovered.landingWaypointIndex; i < recovered.segments.length; i += 1) {
        const seg = recovered.segments[i];
        if (!seg) continue;
        expect(seg.locomotionMode).toBe('floor');
        for (const obs of graph.obstacles) {
          expect(
            segmentIntersectsPolygonInterior2D(
              { x: seg.start.x, z: seg.start.z },
              { x: seg.end.x, z: seg.end.z },
              obs.polygonXZ,
              0,
            ),
          ).toBe(false);
        }
      }

      // Reaches the Core with strictly monotonic distanceToCore
      const endSample = samplePathAtDistance(recovered, recovered.totalLength);
      expect(endSample.reachedCore).toBe(true);
      expect(endSample.distanceToCore).toBe(0);
      expect(distanceXZ2D(endSample.position, coreAnchor.position)).toBeLessThan(1e-4);
    }
  });

  it('guarantees strictly monotonic O(1) distanceToCore across 5 randomized room layouts (using createRng)', () => {
    const masterRng = createRng(0x5eed_2026);

    for (let layoutIdx = 0; layoutIdx < 5; layoutIdx += 1) {
      const layoutSeed = masterRng.int(1, 0x7fff_ffff);
      const rng = createRng(layoutSeed);

      const roomW = rng.range(4.4, 6.2);
      const roomD = rng.range(4.2, 5.8);
      const roomH = rng.range(2.6, 3.2);
      const hw = roomW / 2;
      const hd = roomD / 2;

      const surfaces: NavSurfaceInput[] = [
        makeRectNavSurface({
          id: `floor-${layoutIdx}`,
          kind: 'floor',
          center: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          width: roomW,
          depth: roomD,
        }),
        makeRectNavSurface({
          id: `ceiling-${layoutIdx}`,
          kind: 'ceiling',
          center: { x: 0, y: roomH, z: 0 },
          normal: { x: 0, y: -1, z: 0 },
          width: roomW,
          depth: roomD,
        }),
        makeRectNavSurface({
          id: `wall-north-${layoutIdx}`,
          kind: 'wall',
          center: { x: 0, y: roomH / 2, z: -hd },
          normal: { x: 0, y: 0, z: 1 },
          width: roomW,
          depth: roomH,
        }),
        makeRectNavSurface({
          id: `wall-south-${layoutIdx}`,
          kind: 'wall',
          center: { x: 0, y: roomH / 2, z: hd },
          normal: { x: 0, y: 0, z: -1 },
          width: roomW,
          depth: roomH,
        }),
        makeRectNavSurface({
          id: `wall-west-${layoutIdx}`,
          kind: 'wall',
          center: { x: -hw, y: roomH / 2, z: 0 },
          normal: { x: 1, y: 0, z: 0 },
          width: roomD,
          depth: roomH,
        }),
        makeRectNavSurface({
          id: `wall-east-${layoutIdx}`,
          kind: 'wall',
          center: { x: hw, y: roomH / 2, z: 0 },
          normal: { x: -1, y: 0, z: 0 },
          width: roomD,
          depth: roomH,
        }),
      ];

      const corePos = {
        x: rng.range(-0.35, 0.35),
        y: 0,
        z: rng.range(hd * 0.45, hd * 0.68),
      };

      // Add 2 to 4 randomized table/furniture obstacles that do not overlap the Core position
      const obstacleCount = rng.int(2, 4);
      for (let obsIdx = 0; obsIdx < obstacleCount; obsIdx += 1) {
        const tw = rng.range(0.55, 1.15);
        const td = rng.range(0.5, 0.95);
        const tx = rng.range(-hw + tw, hw - tw);
        const tz = rng.range(-hd * 0.55, corePos.z - td - 0.45);
        const ty = rng.range(0.65, 0.9);

        surfaces.push(
          makeRectNavSurface({
            id: `table-${layoutIdx}-${obsIdx}`,
            kind: rng.chance(0.75) ? 'table' : 'other',
            center: { x: tx, y: ty, z: tz },
            normal: { x: 0, y: 1, z: 0 },
            width: tw,
            depth: td,
          }),
        );
      }

      const portals: NavPortalAnchorInput[] = [
        {
          id: `portal-north-${layoutIdx}`,
          position: { x: rng.range(-hw * 0.5, hw * 0.5), y: rng.range(1.2, 1.8), z: -hd },
          normal: { x: 0, y: 0, z: 1 },
          surfaceId: `wall-north-${layoutIdx}`,
          hostKind: 'wall',
        },
        {
          id: `portal-west-${layoutIdx}`,
          position: { x: -hw, y: rng.range(1.2, 1.8), z: rng.range(-hd * 0.4, hd * 0.2) },
          normal: { x: 1, y: 0, z: 0 },
          surfaceId: `wall-west-${layoutIdx}`,
          hostKind: 'wall',
        },
        {
          id: `portal-east-${layoutIdx}`,
          position: { x: hw, y: rng.range(1.2, 1.8), z: rng.range(-hd * 0.4, hd * 0.2) },
          normal: { x: -1, y: 0, z: 0 },
          surfaceId: `wall-east-${layoutIdx}`,
          hostKind: 'wall',
        },
        {
          id: `portal-ceiling-${layoutIdx}`,
          position: {
            x: rng.range(-hw * 0.4, hw * 0.4),
            y: roomH,
            z: rng.range(-hd * 0.6, -0.3),
          },
          normal: { x: 0, y: -1, z: 0 },
          surfaceId: `ceiling-${layoutIdx}`,
          hostKind: 'ceiling',
        },
      ];

      const graph = buildNavigationGraph({
        surfaces,
        coreAnchor: { position: corePos, surfaceId: `floor-${layoutIdx}`, surfaceKind: 'floor' },
        portalAnchors: portals,
      });

      for (const portal of portals) {
        const pathsToVerify = [
          graph.getSurfacePath(portal.id),
          graph.getAirPath(portal.id, -1),
          graph.getAirPath(portal.id, 0),
          graph.getAirPath(portal.id, 1),
        ];

        for (const path of pathsToVerify) {
          expect(path).toBeDefined();
          if (!path) continue;
          expect(path.totalLength).toBeGreaterThan(1.0);

          // Waypoint distancesToCore must be strictly decreasing from totalLength down to 0
          for (let w = 0; w + 1 < path.waypoints.length; w += 1) {
            const curr = path.waypoints[w];
            const next = path.waypoints[w + 1];
            if (!curr || !next) continue;
            expect(next.cumulativeDistance).toBeGreaterThan(curr.cumulativeDistance);
            expect(next.distanceToCore).toBeLessThan(curr.distanceToCore);
          }

          // Sample 40 points along the path and assert strictly monotonic distanceToCore
          const sampleSteps = 40;
          let prevDistanceToCore = Number.POSITIVE_INFINITY;
          for (let step = 0; step <= sampleSteps; step += 1) {
            const s = (step / sampleSteps) * path.totalLength;
            const sample = samplePathAtDistance(path, s);
            const o1Dist = getDistanceToCore(path, s);

            expect(sample.distanceToCore).toBeCloseTo(o1Dist, 6);
            expect(sample.distanceToCore).toBeLessThan(prevDistanceToCore);
            prevDistanceToCore = sample.distanceToCore;
          }

          // Surface floor segments in every random layout must never intersect obstacle interiors
          if (path.layer === 'surface') {
            for (let i = path.landingWaypointIndex; i < path.segments.length; i += 1) {
              const seg = path.segments[i];
              if (!seg) continue;
              for (const obs of graph.obstacles) {
                expect(
                  segmentIntersectsPolygonInterior2D(
                    { x: seg.start.x, z: seg.start.z },
                    { x: seg.end.x, z: seg.end.z },
                    obs.polygonXZ,
                    0,
                  ),
                ).toBe(false);
              }
            }
          }
        }
      }
    }
  });
});
