// Spatial clustering utilities

import { Position } from './types.js';

export interface ClusterablePoint {
  position: Position;
  [key: string]: unknown; // Allow additional properties
}

export interface Cluster<T extends ClusterablePoint> {
  centroid: Position;
  members: T[];
  radius: number;
}

export function euclideanDistance(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function calculateCentroid<T extends ClusterablePoint>(points: T[]): Position {
  if (points.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }

  const sum = points.reduce(
    (acc, point) => ({
      x: acc.x + point.position.x,
      y: acc.y + point.position.y,
      z: acc.z + point.position.z,
    }),
    { x: 0, y: 0, z: 0 }
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
    z: sum.z / points.length,
  };
}

export function calculateClusterRadius<T extends ClusterablePoint>(
  centroid: Position,
  members: T[]
): number {
  if (members.length === 0) {
    return 0;
  }

  return Math.max(...members.map(member => euclideanDistance(centroid, member.position)));
}

/**
 * Simple agglomerative clustering based on proximity threshold
 */
export function proximityCluster<T extends ClusterablePoint>(
  points: T[],
  proximityThreshold: number
): Cluster<T>[] {
  if (points.length === 0) {
    return [];
  }

  // Start with each point as its own cluster
  const clusters: Cluster<T>[] = points.map(point => ({
    centroid: { ...point.position },
    members: [point],
    radius: 0,
  }));

  // Keep merging closest clusters until no more merges are possible
  let merged = true;
  while (merged) {
    merged = false;
    let minDistance = Infinity;
    let mergeIndices: [number, number] | null = null;

    // Find the closest pair of clusters
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const distance = euclideanDistance(clusters[i].centroid, clusters[j].centroid);
        if (distance < proximityThreshold && distance < minDistance) {
          minDistance = distance;
          mergeIndices = [i, j];
        }
      }
    }

    // Merge the closest pair if found
    if (mergeIndices) {
      const [i, j] = mergeIndices;
      const mergedMembers = [...clusters[i].members, ...clusters[j].members];
      const mergedCentroid = calculateCentroid(mergedMembers);
      const mergedRadius = calculateClusterRadius(mergedCentroid, mergedMembers);

      // Replace cluster i with merged cluster and remove cluster j
      clusters[i] = {
        centroid: mergedCentroid,
        members: mergedMembers,
        radius: mergedRadius,
      };
      clusters.splice(j, 1);
      merged = true;
    }
  }

  // Recalculate final radii
  return clusters.map(cluster => ({
    ...cluster,
    radius: calculateClusterRadius(cluster.centroid, cluster.members),
  }));
}

/**
 * Enforce cluster count constraints by merging closest clusters
 */
export function enforceClusterLimits<T extends ClusterablePoint>(
  clusters: Cluster<T>[],
  minClusters: number,
  maxClusters: number
): Cluster<T>[] {
  let result = [...clusters];

  // If we have too many clusters, merge the closest ones
  while (result.length > maxClusters) {
    let minDistance = Infinity;
    let mergeIndices: [number, number] | null = null;

    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const distance = euclideanDistance(result[i].centroid, result[j].centroid);
        if (distance < minDistance) {
          minDistance = distance;
          mergeIndices = [i, j];
        }
      }
    }

    if (mergeIndices) {
      const [i, j] = mergeIndices;
      const mergedMembers = [...result[i].members, ...result[j].members];
      const mergedCentroid = calculateCentroid(mergedMembers);
      const mergedRadius = calculateClusterRadius(mergedCentroid, mergedMembers);

      result[i] = {
        centroid: mergedCentroid,
        members: mergedMembers,
        radius: mergedRadius,
      };
      result.splice(j, 1);
    } else {
      // Should not happen, but break to prevent infinite loop
      break;
    }
  }

  // Ensure minimum cluster count (this is just a safeguard)
  if (result.length < minClusters) {
    console.warn(
      `Warning: Only ${result.length} clusters generated, which is below minimum ${minClusters}`
    );
  }

  return result;
}