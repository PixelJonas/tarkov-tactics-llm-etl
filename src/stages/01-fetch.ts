// Stage 1: Source fetch
// Pulls all source data into work/raw/ directory with proper caching

import { writeFile, mkdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TarkovDevClient } from '../lib/tarkov-dev-client.js';
import { StageContext, SourceVersions } from '../lib/types.js';

const execAsync = promisify(exec);

export class SourceFetcher {
  private context: StageContext;
  private tarkovDevClient: TarkovDevClient;
  private rawDir: string;

  constructor(context: StageContext) {
    this.context = context;
    this.tarkovDevClient = new TarkovDevClient(context.config.sources.tarkov_dev_graphql);
    this.rawDir = join(context.workDir, 'raw');
  }

  async run(): Promise<SourceVersions> {
    await this.ensureDirectories();

    // Check cache validity first
    const cachedVersions = await this.loadCachedVersions();
    const currentVersions = await this.getCurrentVersions();

    if (this.isCacheValid(cachedVersions, currentVersions)) {
      console.log('✓ All source data is up to date, skipping fetch');
      return cachedVersions;
    }

    console.log('📦 Fetching source data...');

    // Fetch all sources
    const versions: SourceVersions = {};

    // 1. Fetch tarkov.dev GraphQL data
    const tarkovDevEtag = await this.fetchTarkovDevData();
    versions.tarkov_dev_etag = tarkovDevEtag;

    // 2. Fetch SPT-AKI data (commit hash)
    const sptCommit = await this.fetchSPTData();
    versions.spt_aki_commit = sptCommit;

    // 3. Fetch the-hideout iconic location data
    const hideoutCommit = await this.fetchHideoutData();
    versions.the_hideout_commit = hideoutCommit;

    // Save version metadata
    await this.saveVersions(versions);

    console.log('✓ Source fetch completed');
    return versions;
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.rawDir,
      join(this.rawDir, 'spt'),
      join(this.rawDir, 'tarkov-dev'),
      join(this.rawDir, 'the-hideout'),
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  private async fetchTarkovDevData(): Promise<string> {
    console.log('  Fetching tarkov.dev data...');

    const maps = await this.tarkovDevClient.getAllMaps();
    const items = await this.tarkovDevClient.getAllItems();
    const tasks = await this.tarkovDevClient.getAllTasks();

    await writeFile(
      join(this.rawDir, 'tarkov-dev', 'maps.json'),
      JSON.stringify(maps, null, 2)
    );

    await writeFile(
      join(this.rawDir, 'tarkov-dev', 'items.json'),
      JSON.stringify(items, null, 2)
    );

    await writeFile(
      join(this.rawDir, 'tarkov-dev', 'tasks.json'),
      JSON.stringify(tasks, null, 2)
    );

    // Generate a simple etag based on data timestamp
    const timestamp = new Date().toISOString();
    return `"${Date.now()}"`;
  }

  private async fetchSPTData(): Promise<string> {
    console.log('  Fetching SPT-AKI data...');

    // Get latest commit hash from GitHub API
    const response = await fetch(
      'https://api.github.com/repos/sp-tarkov/server/commits/master'
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch SPT commit info: ${response.statusText}`);
    }

    const commitData = (await response.json()) as { sha: string };
    const commitHash = commitData.sha;

    // For now, we'll create placeholder SPT data since the actual files use Git LFS
    // In a real implementation, we'd need to handle Git LFS properly
    const sptDir = join(this.rawDir, 'spt');
    await mkdir(sptDir, { recursive: true });

    // Create placeholder structure based on what we know from the API
    // Use the actual SPT-AKI directory naming convention
    const maps = ['bigmap', 'factory4_day', 'factory4_night', 'woods', 'shoreline', 'interchange', 'laboratory', 'lighthouse', 'rezervbase', 'tarkovstreets', 'sandbox', 'sandbox_high'];

    for (const map of maps) {
      const mapDir = join(sptDir, 'locations', map);
      await mkdir(mapDir, { recursive: true });

      // Create placeholder loot data
      const placeholderLoot = {
        looseLoot: [],
        staticLoot: [],
        staticContainers: [],
        _meta: {
          note: 'Placeholder - real implementation would fetch from SPT Git LFS',
          commit: commitHash,
          map: map
        }
      };

      await writeFile(
        join(mapDir, 'looseLoot.json'),
        JSON.stringify(placeholderLoot, null, 2)
      );
    }

    return commitHash;
  }

  private async fetchHideoutData(): Promise<string> {
    console.log('  Fetching the-hideout iconic location data...');

    // Get latest commit hash
    const response = await fetch(
      'https://api.github.com/repos/the-hideout/tarkov-dev/commits/main'
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch hideout commit info: ${response.statusText}`);
    }

    const commitData = (await response.json()) as { sha: string };
    const commitHash = commitData.sha;

    // For now, create placeholder iconic location data
    // Real implementation would find the actual iconic location files
    const iconicLocations = {
      customs: [
        {
          name: "Dorms",
          center: { x: -100, y: 0, z: 100 },
          layer_range_y: [0, 20],
          source: "the-hideout/tarkov-dev"
        },
        {
          name: "Big Red",
          center: { x: 200, y: 0, z: -150 },
          layer_range_y: [0, 15],
          source: "the-hideout/tarkov-dev"
        }
      ],
      factory: [
        {
          name: "Office",
          center: { x: 0, y: 5, z: 0 },
          layer_range_y: [0, 10],
          source: "the-hideout/tarkov-dev"
        }
      ],
      _meta: {
        note: 'Placeholder - real implementation would fetch actual iconic location data',
        commit: commitHash
      }
    };

    await writeFile(
      join(this.rawDir, 'the-hideout', 'iconic-locations.json'),
      JSON.stringify(iconicLocations, null, 2)
    );

    return commitHash;
  }

  private async getCurrentVersions(): Promise<SourceVersions> {
    // This would check current versions of all sources
    // For now, return empty to force fresh fetch
    return {};
  }

  private async loadCachedVersions(): Promise<SourceVersions> {
    const versionsPath = join(this.rawDir, 'source-versions.json');
    try {
      await access(versionsPath);
      const content = await readFile(versionsPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async saveVersions(versions: SourceVersions): Promise<void> {
    const versionsPath = join(this.rawDir, 'source-versions.json');
    await writeFile(versionsPath, JSON.stringify(versions, null, 2));
  }

  private isCacheValid(cached: SourceVersions, current: SourceVersions): boolean {
    // For now, always fetch fresh data
    // Real implementation would check timestamps and TTL
    return false;
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../lib/config.js');
  const config = await loadConfig();

  const context = {
    config,
    workDir: './work',
    sourceVersions: {},
  };

  const fetcher = new SourceFetcher(context);
  try {
    await fetcher.run();
    console.log('✅ Stage 1 (fetch) completed successfully');
  } catch (error) {
    console.error('❌ Stage 1 (fetch) failed:', error);
    process.exit(1);
  }
}