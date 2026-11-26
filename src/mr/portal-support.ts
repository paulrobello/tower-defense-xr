import { Box3, Ray, type Triangle, Vector3 } from 'three';
import { getRoomMeshTree } from './mesh-raycast.ts';
import type { RoomSurface } from './room-scan.ts';

const FLAT_DEPTH_TOLERANCE_M = 0.035;
const HOST_PLANE_TOLERANCE_M = 0.065;
const PROTRUSION_CHECK_M = 0.24;
const REQUIRED_NORMAL_DOT = 0.92;

/** Checks the room-facing geometry in front of the fitted wall or ceiling plane. */
export function createPortalSupportProbe(surfaces: readonly RoomSurface[]) {
  const meshes = surfaces.flatMap((surface) => {
    const { meshVertices, meshIndices, meshWorldMatrix } = surface;
    if (!meshVertices || !meshIndices || !meshWorldMatrix) return [];
    const size = surface.bounds.getSize(new Vector3());
    const broadFace = [size.x, size.y, size.z].filter((axis) => axis > 1.5).length >= 2;
    return [
      {
        id: surface.id,
        bounds: surface.bounds,
        broadMesh: surface.kind === 'other' && broadFace,
        worldToMesh: meshWorldMatrix.clone().invert(),
        tree: getRoomMeshTree(meshVertices, meshIndices, surface.lastChangedTime),
      },
    ];
  });

  const segment = new Box3();
  const localSegment = new Box3();
  const ray = new Ray();
  const endpoint = new Vector3();
  const localNormal = new Vector3();
  const hit = new Vector3();
  const triNormal = new Vector3();
  const triangles: Triangle[] = [];

  function closestSurface(point: Vector3, normal: Vector3, front: number, back: number) {
    ray.origin.copy(point).addScaledVector(normal, front);
    endpoint.copy(point).addScaledVector(normal, -back);
    segment.min.copy(ray.origin).min(endpoint);
    segment.max.copy(ray.origin).max(endpoint);
    segment.expandByScalar(1e-5);

    let depth = -Infinity;
    let alignment = 0;
    for (const mesh of meshes) {
      if (!segment.intersectsBox(mesh.bounds)) continue;
      localNormal.copy(normal).transformDirection(mesh.worldToMesh);
      ray.origin.copy(point).addScaledVector(normal, front).applyMatrix4(mesh.worldToMesh);
      ray.direction.copy(localNormal).negate();
      endpoint.copy(ray.origin).addScaledVector(ray.direction, front + back);
      localSegment.min.copy(ray.origin).min(endpoint);
      localSegment.max.copy(ray.origin).max(endpoint);
      localSegment.expandByScalar(1e-5);
      triangles.length = 0;
      mesh.tree.getBoxTriangles(localSegment, triangles);
      for (const tri of triangles) {
        if (!ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit)) continue;
        const candidate = front - ray.origin.distanceTo(hit);
        if (candidate < -back || candidate <= depth) continue;
        depth = candidate;
        alignment = Math.abs(tri.getNormal(triNormal).dot(localNormal));
      }
    }
    return { depth, alignment };
  }

  return {
    /** A positive result shifts a fitted plane forward to its scanned face. */
    getMountOffset(points: readonly Vector3[], normal: Vector3, host: RoomSurface): number | null {
      if (meshes.length === 0) return 0;
      let minDepth = Infinity;
      let maxDepth = -Infinity;
      let hitCount = 0;
      for (const point of points) {
        const { depth, alignment } = closestSurface(
          point,
          normal,
          PROTRUSION_CHECK_M,
          HOST_PLANE_TOLERANCE_M + FLAT_DEPTH_TOLERANCE_M,
        );
        if (depth === -Infinity) continue;
        if (alignment < REQUIRED_NORMAL_DOT || Math.abs(depth) > HOST_PLANE_TOLERANCE_M)
          return null;
        minDepth = Math.min(minDepth, depth);
        maxDepth = Math.max(maxDepth, depth);
        hitCount += 1;
      }
      if (hitCount === 0) {
        const center = points[0] as Vector3;
        const expectsMesh = meshes.some(
          (mesh) =>
            mesh.id === host.id ||
            (mesh.broadMesh && mesh.bounds.distanceToPoint(center) <= HOST_PLANE_TOLERANCE_M),
        );
        return expectsMesh ? null : 0;
      }
      if (hitCount !== points.length || maxDepth - minDepth > FLAT_DEPTH_TOLERANCE_M) return null;
      return Math.max(0, (maxDepth + minDepth) * 0.5);
    },

    crossesRoomMesh(points: readonly Vector3[], normal: Vector3): boolean {
      return points.some((point) => closestSurface(point, normal, 0.1, 0.1).depth !== -Infinity);
    },
  };
}
