import { Box3, Ray, Triangle, Vector3 } from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import type { RoomSurface } from '../mr/room-scan.ts';
import type { AerialSpanBlocked } from './graph.ts';

const PORTAL_EXIT_TOLERANCE_M = 0.015;

/** Tests flight spans against the steep faces of scanned meshes, including unlabeled room meshes. */
export function createRoomMeshFlightTest(
  surfaces: readonly Pick<RoomSurface, 'meshVertices' | 'meshIndices' | 'meshWorldMatrix'>[],
): AerialSpanBlocked | undefined {
  const tree = new Octree();
  const normal = new Vector3();
  for (const surface of surfaces) {
    const { meshVertices, meshIndices, meshWorldMatrix } = surface;
    if (!meshVertices || !meshIndices || !meshWorldMatrix) continue;
    const vertices = Array.from({ length: Math.floor(meshVertices.length / 3) }, (_, index) =>
      new Vector3().fromArray(meshVertices, index * 3).applyMatrix4(meshWorldMatrix),
    );
    for (let i = 0; i + 2 < meshIndices.length; i += 3) {
      const a = vertices[meshIndices[i] as number];
      const b = vertices[meshIndices[i + 1] as number];
      const c = vertices[meshIndices[i + 2] as number];
      if (!a || !b || !c) continue;
      Triangle.getNormal(a, b, c, normal);
      if (normal.lengthSq() === 0 || Math.abs(normal.y) >= 0.65) continue;
      tree.addTriangle(new Triangle(a, b, c));
    }
  }
  if (tree.triangles.length === 0) return undefined;
  tree.build();

  const ray = new Ray();
  const endpoint = new Vector3();
  const hit = new Vector3();
  const bounds = new Box3();
  const candidates: Triangle[] = [];
  return (start, end, leavingPortal) => {
    ray.origin.set(start.x, start.y, start.z);
    endpoint.set(end.x, end.y, end.z);
    ray.direction.subVectors(endpoint, ray.origin);
    const length = ray.direction.length();
    const tolerance = leavingPortal ? PORTAL_EXIT_TOLERANCE_M : 0;
    if (length <= tolerance + 1e-6) return false;
    ray.direction.multiplyScalar(1 / length);

    bounds.min.copy(ray.origin).min(endpoint);
    bounds.max.copy(ray.origin).max(endpoint);
    candidates.length = 0;
    tree.getBoxTriangles(bounds, candidates);
    return candidates.some((triangle) => {
      if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) return false;
      const distance = ray.origin.distanceTo(hit);
      return distance >= tolerance && distance <= length + 1e-6;
    });
  };
}
