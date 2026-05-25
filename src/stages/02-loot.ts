// Stage 2: Loot probability normalization
// Processes SPT-AKI raw location files into normalized loot probabilities

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { LootProbabilities, LootItem, LootConfidence, Position, StageContext } from '../lib/types.js';

// SPT-AKI raw data structures
interface SPTLooseLootPoint {
  template: string;
  position: { x: number; y: number; z: number };
  itemDistribution: Array<{ tpl: string; relativeProbability: number }>;
}

interface SPTLooseLootData {
  spawnpoints?: SPTLooseLootPoint[];
  spawnpointsForced?: SPTLooseLootPoint[];
  looseLoot?: SPTLooseLootPoint[];
  _meta?: Record<string, unknown>;
}

interface SPTStaticLootItem {
  tpl: string;
  relativeProbability: number;
}

interface SPTStaticContainer {
  containerId?: string;
  containerTypeId?: string;
  items?: SPTStaticLootItem[];
  itemDistribution?: SPTStaticLootItem[];
}

interface SPTStaticLootData {
  staticContainers?: SPTStaticContainer[];
  staticLoot?: Record<string, { itemDistribution?: SPTStaticLootItem[] }>;
  _meta?: Record<string, unknown>;
}

// Map of known SPT internal map directory names to tarkov.dev IDs
const SPT_MAP_ID_MAP: Record<string, string> = {
  bigmap: '56f40101d2720b2a4d8b45d6',        // Customs
  factory4_day: '55f2d3fd4bdc2d5f408b4567',   // Factory (Day)
  factory4_night: '59fc81d786f774390775787e',  // Factory (Night)
  interchange: '5714dbc024597771384a510d',      // Interchange
  laboratory: '5b0fc42d86f7744a585f9105',       // The Lab
  lighthouse: '5704e4dad2720bb55b8b4567',       // Lighthouse
  rezervbase: '5704e5fad2720bc05b8b4567',       // Reserve
  shoreline: '5704e554d2720bac5b8b456e',        // Shoreline
  tarkovstreets: '653e6760052c01c1c805532f',    // Streets of Tarkov
  woods: '5704e3c2d2720bac5b8b4567',            // Woods
  sandbox: '65b8d6f5cdde2479cb2a3125',          // Ground Zero
  sandbox_high: '65b8d6f5cdde2479cb2a3125',     // Ground Zero (High level)
};

export class LootNormalizer {
  private context: StageContext;
  private itemIndex: Map<string, string> = new Map(); // BSG tpl -> tarkov.dev ID

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<LootProbabilities> {
    console.log('📊 Stage 2: Normalizing loot probabilities...');

    await this.loadItemIndex();

    const rawDir = join(this.context.workDir, 'raw');
    const outputDir = join(this.context.workDir, 'stage2');
    await mkdir(outputDir, { recursive: true });

    const result: LootProbabilities = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      game_patch: await this.getGamePatch(),
      maps: {},
    };

    // Process each map's loot data
    const sptLocationsDir = join(rawDir, 'spt', 'locations');
    let mapDirs: string[];
    try {
      mapDirs = await readdir(sptLocationsDir);
    } catch {
      console.warn('  No SPT location data found, using empty loot data');
      mapDirs = [];
    }

    for (const mapDir of mapDirs) {
      const mapId = SPT_MAP_ID_MAP[mapDir] || mapDir;
      console.log(`  Processing map: ${mapDir} -> ${mapId}`);

      const mapResult = await this.processMap(join(sptLocationsDir, mapDir), mapId);
      if (mapResult) {
        result.maps[mapId] = mapResult;
      }
    }

    // Write output
    const outputPath = join(outputDir, 'loot-probabilities.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 2 completed');

    return result;
  }

  private async loadItemIndex(): Promise<void> {
    try {
      const itemsPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'items.json');
      const content = await readFile(itemsPath, 'utf-8');
      const items = JSON.parse(content) as Array<{ id: string; name: string }>;

      // tarkov.dev uses its own item IDs which happen to be BSG _id values
      for (const item of items) {
        this.itemIndex.set(item.id, item.id);
      }

      console.log(`  Loaded ${this.itemIndex.size} items from tarkov.dev catalog`);
    } catch {
      console.warn('  Could not load tarkov.dev item catalog');
    }
  }

  private async processMap(
    mapPath: string,
    mapId: string
  ): Promise<LootProbabilities['maps'][string] | null> {
    const containers: Record<string, { items: LootItem[] }> = {};
    const looseRegions: LootProbabilities['maps'][string]['loose_loot_regions'] = [];

    // Process loose loot
    try {
      const looseLootPath = join(mapPath, 'looseLoot.json');
      const content = await readFile(looseLootPath, 'utf-8');
      const data = JSON.parse(content) as SPTLooseLootData;

      const spawnpoints = data.spawnpoints || data.looseLoot || [];
      for (const point of spawnpoints) {
        if (!point.itemDistribution || point.itemDistribution.length === 0) continue;

        const normalizedItems = this.normalizeDistribution(point.itemDistribution);
        looseRegions.push({
          region_id: point.template || `region-${looseRegions.length}`,
          center: point.position || { x: 0, y: 0, z: 0 },
          radius: 1.0,
          items: normalizedItems,
        });
      }
    } catch {
      // No loose loot data for this map
    }

    // Process static loot
    try {
      const staticLootPath = join(mapPath, 'looseLoot.json');
      const content = await readFile(staticLootPath, 'utf-8');
      const data = JSON.parse(content) as SPTStaticLootData;

      if (data.staticLoot) {
        for (const [containerType, containerData] of Object.entries(data.staticLoot)) {
          if (containerData.itemDistribution && containerData.itemDistribution.length > 0) {
            containers[containerType] = {
              items: this.normalizeDistribution(containerData.itemDistribution),
            };
          }
        }
      }

      if (data.staticContainers) {
        for (const container of data.staticContainers) {
          const typeId = container.containerTypeId || container.containerId || 'unknown';
          const dist = container.itemDistribution || container.items || [];
          if (dist.length > 0) {
            containers[typeId] = {
              items: this.normalizeDistribution(dist),
            };
          }
        }
      }
    } catch {
      // No static loot data for this map
    }

    return {
      containers,
      loose_loot_regions: looseRegions,
    };
  }

  private normalizeDistribution(
    distribution: Array<{ tpl: string; relativeProbability: number }>
  ): LootItem[] {
    const totalWeight = distribution.reduce((sum, item) => sum + item.relativeProbability, 0);

    if (totalWeight === 0) return [];

    return distribution.map(item => {
      const tarkovDevId = this.itemIndex.has(item.tpl) ? item.tpl : item.tpl;
      const confidence: LootConfidence = this.itemIndex.has(item.tpl)
        ? 'spt_direct'
        : 'id_unmatched';

      return {
        item_id: tarkovDevId,
        probability: item.relativeProbability / totalWeight,
        confidence,
      };
    });
  }

  private async getGamePatch(): Promise<string> {
    // Try to determine game patch from source data
    try {
      const versionsPath = join(this.context.workDir, 'raw', 'source-versions.json');
      const content = await readFile(versionsPath, 'utf-8');
      const versions = JSON.parse(content);
      return versions.game_patch || '0.16.5.1.40234';
    } catch {
      return '0.16.5.1.40234';
    }
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

  const normalizer = new LootNormalizer(context);
  try {
    await normalizer.run();
    console.log('✅ Stage 2 (loot) completed successfully');
  } catch (error) {
    console.error('❌ Stage 2 (loot) failed:', error);
    process.exit(1);
  }
}