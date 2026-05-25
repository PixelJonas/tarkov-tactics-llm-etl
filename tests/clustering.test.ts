import { describe, it, expect } from 'vitest';
import {
  euclideanDistance,
  calculateCentroid,
  proximityCluster,
  enforceClusterLimits,
  ClusterablePoint,
} from '../src/lib/clustering.js';

function point(x: number, y: number, z: number): ClusterablePoint {
  return { position: { x, y, z } };
}

describe('euclideanDistance', () => {
  it('returns 0 for same point', () => {
    const p = { x: 1, y: 2, z: 3 };
    expect(euclideanDistance(p, p)).toBe(0);
  });

  it('calculates distance correctly', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 3, y: 4, z: 0 };
    expect(euclideanDistance(a, b)).toBe(5);
  });

  it('handles 3D distance', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { x: 4, y: 6, z: 3 };
    expect(euclideanDistance(a, b)).toBe(5);
  });
});

describe('calculateCentroid', () => {
  it('returns origin for empty array', () => {
    const result = calculateCentroid([]);
    expect(result).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('returns the point for single-element array', () => {
    const result = calculateCentroid([point(5, 10, 15)]);
    expect(result).toEqual({ x: 5, y: 10, z: 15 });
  });

  it('computes average for multiple points', () => {
    const result = calculateCentroid([point(0, 0, 0), point(10, 10, 10)]);
    expect(result).toEqual({ x: 5, y: 5, z: 5 });
  });
});

describe('proximityCluster', () => {
  it('returns empty for empty input', () => {
    const result = proximityCluster([], 50);
    expect(result).toEqual([]);
  });

  it('creates one cluster for nearby points', () => {
    const points = [point(0, 0, 0), point(5, 0, 0), point(10, 0, 0)];
    const result = proximityCluster(points, 20);
    expect(result).toHaveLength(1);
    expect(result[0].members).toHaveLength(3);
  });

  it('creates separate clusters for distant points', () => {
    const points = [point(0, 0, 0), point(5, 0, 0), point(200, 0, 0), point(205, 0, 0)];
    const result = proximityCluster(points, 20);
    expect(result).toHaveLength(2);
  });

  it('is deterministic', () => {
    const points = [point(0, 0, 0), point(50, 0, 0), point(100, 0, 0), point(300, 0, 0)];
    const result1 = proximityCluster(points, 75);
    const result2 = proximityCluster(points, 75);
    expect(result1).toEqual(result2);
  });
});

describe('enforceClusterLimits', () => {
  it('merges clusters when above max', () => {
    const points = [
      point(0, 0, 0),
      point(100, 0, 0),
      point(200, 0, 0),
      point(300, 0, 0),
      point(400, 0, 0),
      point(500, 0, 0),
    ];
    const clusters = proximityCluster(points, 10); // Each point is its own cluster
    expect(clusters.length).toBe(6);

    const limited = enforceClusterLimits(clusters, 1, 4);
    expect(limited.length).toBe(4);
  });

  it('preserves clusters within limits', () => {
    const points = [point(0, 0, 0), point(100, 0, 0), point(200, 0, 0)];
    const clusters = proximityCluster(points, 10);
    const limited = enforceClusterLimits(clusters, 1, 4);
    expect(limited.length).toBe(3);
  });

  it('merges closest pair first', () => {
    const points = [point(0, 0, 0), point(10, 0, 0), point(1000, 0, 0)];
    const clusters = proximityCluster(points, 5);
    expect(clusters.length).toBe(3);

    const limited = enforceClusterLimits(clusters, 1, 2);
    expect(limited.length).toBe(2);
    // The two close points should be merged, leaving the distant one separate
    const farCluster = limited.find(c => c.centroid.x > 500);
    expect(farCluster).toBeDefined();
    expect(farCluster!.members).toHaveLength(1);
  });
});
