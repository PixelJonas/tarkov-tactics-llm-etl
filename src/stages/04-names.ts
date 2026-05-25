// Stage 4: Iconic location ingestion and cluster naming
// Every cluster gets a human-readable name. No raw IDs are ever exposed.
// Source hierarchy per spec §8.5:
//   1. Direct match: extract/switch/iconic label within radius -> use its name
//   2. Proximity description: nearest landmark + cardinal direction -> "NW of Dorms"

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { NamedPOIs, SpawnClusters, IconicLabel, Position, StageContext } from '../lib/types.js';
import { euclideanDistance } from '../lib/clustering.js';

interface NamedPosition {
  name: string;
  position: Position;
  source: string;
}

interface RawIconicLocation {
  name: string;
  center: Position;
  layer_range_y: [number, number];
  source: string;
}

export class NameResolver {
  private context: StageContext;

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<NamedPOIs> {
    console.log('🏷️  Stage 4: Resolving location names...');

    const outputDir = join(this.context.workDir, 'stage4');
    await mkdir(outputDir, { recursive: true });

    const clustersPath = join(this.context.workDir, 'stage3', 'spawn-clusters.json');
    const clustersContent = await readFile(clustersPath, 'utf-8');
    const spawnClusters: SpawnClusters = JSON.parse(clustersContent);

    const apiNamedPositions = await this.loadAPINamedPositions();
    const iconicLocations = await this.loadIconicLocations();

    const result: NamedPOIs = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      maps: {},
    };

    for (const [mapId, mapData] of Object.entries(spawnClusters.maps)) {
      console.log(`  Processing map: ${mapId}`);

      const mapApiPositions = apiNamedPositions.get(mapId) || [];
      const mapIconicLabels = iconicLocations[mapId] || [];

      // Build a combined pool of all named landmarks for proximity fallback
      const allLandmarks: NamedPosition[] = [
        ...mapApiPositions,
        ...mapIconicLabels.map(l => ({
          name: l.name,
          position: l.center,
          source: 'iconic',
        })),
      ];

      const spawnClusterNames: Record<string, { name: string; source: 'iconic_match' | 'synthetic' }> = {};

      for (const cluster of mapData.clusters) {
        const matchRadius = this.context.config.naming.iconic_match_radius_m;

        // 1. Direct match within radius — use the landmark's name directly
        const directMatch = this.findNearest(cluster.centroid, allLandmarks, matchRadius);

        if (directMatch) {
          spawnClusterNames[cluster.cluster_id] = {
            name: directMatch.entry.name,
            source: 'iconic_match',
          };
          console.log(`    ${cluster.cluster_id} -> "${directMatch.entry.name}" (${directMatch.entry.source}, ${Math.round(directMatch.distance)}m)`);
          continue;
        }

        // 2. Proximity description — find nearest landmark at any distance,
        //    generate "NW of Dorms" style name
        const proximityMatch = this.findNearest(cluster.centroid, allLandmarks);

        if (proximityMatch) {
          const direction = this.cardinalDirection(proximityMatch.entry.position, cluster.centroid);
          const dist = Math.round(proximityMatch.distance);
          const landmarkName = proximityMatch.entry.name;
          let name: string;

          if (dist < 150) {
            // Avoid "Near Near Kamchatskaya Arch" when the landmark already starts with "Near"
            name = landmarkName.startsWith('Near ') ? landmarkName : `Near ${landmarkName}`;
          } else {
            name = `${direction} of ${landmarkName}`;
          }

          spawnClusterNames[cluster.cluster_id] = {
            name,
            source: 'synthetic',
          };
          console.log(`    ${cluster.cluster_id} -> "${name}" (${dist}m from ${proximityMatch.entry.name})`);
          continue;
        }

        // 3. Last resort — should only happen if a map has zero extracts/switches
        spawnClusterNames[cluster.cluster_id] = {
          name: `Spawn Area ${cluster.cluster_id.split('-spawn-').pop() || '?'}`,
          source: 'synthetic',
        };
        console.log(`    ${cluster.cluster_id} -> fallback (no landmarks on map)`);
      }

      result.maps[mapId] = {
        iconic_labels: mapIconicLabels.map(label => ({
          name: label.name,
          center: label.center,
          layer_range_y: label.layer_range_y,
          source: 'the-hideout/tarkov-dev' as const,
        })),
        spawn_cluster_names: spawnClusterNames,
      };
    }

    const outputPath = join(outputDir, 'named-pois.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 4 completed');

    return result;
  }

  private async loadAPINamedPositions(): Promise<Map<string, NamedPosition[]>> {
    const result = new Map<string, NamedPosition[]>();

    try {
      const mapsPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'maps.json');
      const content = await readFile(mapsPath, 'utf-8');
      const maps = JSON.parse(content) as Array<{
        id: string;
        extracts?: Array<{ name: string; position: Position | null }>;
        switches?: Array<{ name: string; position: Position | null }>;
      }>;

      for (const map of maps) {
        const positions: NamedPosition[] = [];

        for (const extract of map.extracts || []) {
          if (extract.position && extract.name) {
            positions.push({ name: extract.name, position: extract.position, source: 'extract' });
          }
        }

        for (const sw of map.switches || []) {
          if (sw.position && sw.name) {
            positions.push({ name: sw.name, position: sw.position, source: 'switch' });
          }
        }

        result.set(map.id, positions);
      }
    } catch {
      console.warn('  Could not load tarkov.dev map data for named positions');
    }

    return result;
  }

  private async loadIconicLocations(): Promise<Record<string, RawIconicLocation[]>> {
    try {
      const iconicPath = join(this.context.workDir, 'raw', 'the-hideout', 'iconic-locations.json');
      const content = await readFile(iconicPath, 'utf-8');
      const data = JSON.parse(content);
      const result: Record<string, RawIconicLocation[]> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key !== '_meta' && Array.isArray(value)) {
          result[key] = value as RawIconicLocation[];
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  /**
   * Find nearest named position, optionally within a max radius.
   */
  private findNearest(
    position: Position,
    landmarks: NamedPosition[],
    maxRadius?: number
  ): { entry: NamedPosition; distance: number } | null {
    let nearest: NamedPosition | null = null;
    let nearestDistance = Infinity;

    for (const lm of landmarks) {
      const d = euclideanDistance(position, lm.position);
      if (d < nearestDistance && (maxRadius === undefined || d <= maxRadius)) {
        nearest = lm;
        nearestDistance = d;
      }
    }

    return nearest ? { entry: nearest, distance: nearestDistance } : null;
  }

  /**
   * Compute cardinal direction from `from` to `to` using the game's XZ plane.
   * Tarkov uses: +X = East, +Z = North (Y is vertical).
   */
  private cardinalDirection(from: Position, to: Position): string {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const angle = Math.atan2(dx, dz) * (180 / Math.PI); // 0 = North, 90 = East

    if (angle >= -22.5 && angle < 22.5) return 'N';
    if (angle >= 22.5 && angle < 67.5) return 'NE';
    if (angle >= 67.5 && angle < 112.5) return 'E';
    if (angle >= 112.5 && angle < 157.5) return 'SE';
    if (angle >= 157.5 || angle < -157.5) return 'S';
    if (angle >= -157.5 && angle < -112.5) return 'SW';
    if (angle >= -112.5 && angle < -67.5) return 'W';
    return 'NW';
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../lib/config.js');
  const config = await loadConfig();

  const context: StageContext = {
    config,
    workDir: './work',
    sourceVersions: {},
  };

  const resolver = new NameResolver(context);
  try {
    await resolver.run();
    console.log('✅ Stage 4 (names) completed successfully');
  } catch (error) {
    console.error('❌ Stage 4 (names) failed:', error);
    process.exit(1);
  }
}