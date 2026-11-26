import { type Matrix4, Ray, Triangle, Vector3 } from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import type { Vec3 } from '../core/action-bus.ts';
import type { RoomSurface, RoomSurfaceModel } from './room-scan.ts';

const localTrees = new WeakMap<
  Float32Array,
  { indices: Uint32Array; revision: number; tree: Octree }
>();

export function getRoomMeshTree(
  vertices: Float32Array,
  indices: Uint32Array,
  revision: number,
): Octree {
  const cached = localTrees.get(vertices);
  if (cached?.indices === indices && cached.revision === revision) return cached.tree;
  const points = Array.from({ length: Math.floor(vertices.length / 3) }, (_, i) =>
    new Vector3().fromArray(vertices, i * 3),
  );
  const tree = new Octree();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = points[indices[i] as number];
    const b = points[indices[i + 1] as number];
    const c = points[indices[i + 2] as number];
    if (a && b && c) tree.addTriangle(new Triangle(a, b, c));
  }
  if (tree.triangles.length > 0) tree.build();
  localTrees.set(vertices, { indices, revision, tree });
  return tree;
}

interface TrackedMesh {
  readonly surface: RoomSurface;
  readonly worldToMesh: Matrix4;
  readonly tree: Octree;
}

/** A room-space ray through the tracked triangles, independent of the occlusion rendering mode. */
export function createRoomMeshRaycast(roomModel: RoomSurfaceModel) {
  let revision = -1;
  let meshes: readonly TrackedMesh[] = [];
  const worldRay = new Ray();
  const localRay = new Ray();
  const point = new Vector3();
  const triangles: Triangle[] = [];

  return (
    origin: Readonly<Vec3>,
    direction: Readonly<Vec3>,
    maxDistance: number,
  ): number | null => {
    if (roomModel.revision !== revision) {
      revision = roomModel.revision;
      meshes = roomModel.surfaces.flatMap((surface) => {
        const { meshVertices, meshIndices, meshWorldMatrix } = surface;
        return meshVertices && meshIndices && meshWorldMatrix
          ? [
              {
                surface,
                worldToMesh: meshWorldMatrix.clone().invert(),
                tree: getRoomMeshTree(meshVertices, meshIndices, surface.lastChangedTime),
              },
            ]
          : [];
      });
    }
    worldRay.origin.set(origin.x, origin.y, origin.z);
    worldRay.direction.set(direction.x, direction.y, direction.z).normalize();
    if (worldRay.direction.lengthSq() === 0) return null;

    let distance = Infinity;
    for (const mesh of meshes) {
      if (!worldRay.intersectBox(mesh.surface.bounds, point)) continue;
      if (
        !mesh.surface.bounds.containsPoint(worldRay.origin) &&
        point.distanceTo(worldRay.origin) > Math.min(distance, maxDistance)
      )
        continue;
      localRay.copy(worldRay).applyMatrix4(mesh.worldToMesh);
      triangles.length = 0;
      mesh.tree.getRayTriangles(localRay, triangles);
      for (const triangle of triangles) {
        if (!localRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, point)) continue;
        const hitDistance = point.distanceTo(localRay.origin);
        if (hitDistance > 0.02 && hitDistance <= maxDistance)
          distance = Math.min(distance, hitDistance);
      }
    }
    return Number.isFinite(distance) ? distance : null;
  };
}
