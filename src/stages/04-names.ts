// Stage 4: Iconic location ingestion and cluster naming
// Matches spawn clusters to iconic location labels

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { NamedPOIs, SpawnClusters, IconicLabel, Position, StageContext } from '../lib/types.js';
import { euclideanDistance } from '../lib/clustering.js';

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

    // Load spawn clusters from stage 3
    const clustersPath = join(this.context.workDir, 'stage3', 'spawn-clusters.json');
    const clustersContent = await readFile(clustersPath, 'utf-8');
    const spawnClusters: SpawnClusters = JSON.parse(clustersContent);

    // Load iconic location data
    const iconicLocations = await this.loadIconicLocations();

    const result: NamedPOIs = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      maps: {},
    };

    for (const [mapId, mapData] of Object.entries(spawnClusters.maps)) {
      console.log(`  Processing map: ${mapId}`);

      const mapIconicLabels = iconicLocations[mapId] || [];
      const spawnClusterNames: Record<string, { name: string; source: 'iconic_match' | 'synthetic' }> = {};

      // Attempt to name each spawn cluster
      for (const cluster of mapData.clusters) {
        const match = this.findNearestIconicLabel(
          cluster.centroid,
          mapIconicLabels,
          this.context.config.naming.iconic_match_radius_m,
          this.context.config.naming.layer_aware_matching
        );

        if (match) {
          spawnClusterNames[cluster.cluster_id] = {
            name: match.name,
            source: 'iconic_match',
          };
          console.log(`    Cluster ${cluster.cluster_id} -> "${match.name}" (iconic match)`);
        } else {
          const syntheticName = this.generateSyntheticName(cluster.cluster_id);
          spawnClusterNames[cluster.cluster_id] = {
            name: syntheticName,
            source: 'synthetic',
          };
          console.log(`    Cluster ${cluster.cluster_id} -> "${syntheticName}" (synthetic)`);
        }
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

  private async loadIconicLocations(): Promise<Record<string, RawIconicLocation[]>> {
    try {
      const iconicPath = join(this.context.workDir, 'raw', 'the-hideout', 'iconic-locations.json');
      const content = await readFile(iconicPath, 'utf-8');
      const data = JSON.parse(content);
      // Filter out _meta key
      const result: Record<string, RawIconicLocation[]> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key !== '_meta' && Array.isArray(value)) {
          result[key] = value as RawIconicLocation[];
        }
      }
      return result;
    } catch {
      console.warn('  No iconic location data found, using empty data');
      return {};
    }
  }

  private findNearestIconicLabel(
    position: Position,
    labels: RawIconicLocation[],
    maxRadius: number,
    layerAware: boolean
  ): RawIconicLocation | null {
    let nearest: RawIconicLocation | null = null;
    let nearestDistance = Infinity;

    for (const label of labels) {
      // Layer-aware check: position Y must be within the label's layer range
      if (layerAware) {
        const [yMin, yMax] = label.layer_range_y;
        if (position.y < yMin || position.y > yMax) {
          continue;
        }
      }

      const distance = euclideanDistance(position, label.center);
      if (distance <= maxRadius && distance < nearestDistance) {
        nearest = label;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  private generateSyntheticName(clusterId: string): string {
    // Extract map and index from cluster_id pattern: "<map_id>-spawn-<index>"
    const parts = clusterId.split('-spawn-');
    if (parts.length === 2) {
      return `Spawn Area ${parts[1]}`;
    }
    return clusterId;
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