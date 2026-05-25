// Main ETL pipeline orchestrator
// Runs all 6 stages in sequence with caching and error handling

import { mkdir } from 'fs/promises';
import { loadConfig } from './lib/config.js';
import { SourceFetcher } from './stages/01-fetch.js';
import { LootNormalizer } from './stages/02-loot.js';
import { SpawnClusterer } from './stages/03-spawns.js';
import { NameResolver } from './stages/04-names.js';
import { QuestEnricher } from './stages/05-quests-llm.js';
import { Validator } from './stages/06-validate-manifest.js';
import { StageContext } from './lib/types.js';

async function main() {
  console.log('=== Tarkov Tactics ETL Pipeline ===\n');

  const config = await loadConfig();
  const workDir = process.env.ETL_WORK_DIR || './work';
  await mkdir(workDir, { recursive: true });

  const context: StageContext = {
    config,
    workDir,
    sourceVersions: {},
  };

  try {
    // Stage 1: Source fetch
    const fetcher = new SourceFetcher(context);
    context.sourceVersions = await fetcher.run();
    console.log('');

    // Stage 2: Loot probability normalization
    const lootNormalizer = new LootNormalizer(context);
    await lootNormalizer.run();
    console.log('');

    // Stage 3: Spawn cluster pre-computation
    const spawnClusterer = new SpawnClusterer(context);
    await spawnClusterer.run();
    console.log('');

    // Stage 4: Named POI resolution
    const nameResolver = new NameResolver(context);
    await nameResolver.run();
    console.log('');

    // Stage 5: Quest enrichment (LLM, if configured)
    const questEnricher = new QuestEnricher(context);
    await questEnricher.run();
    console.log('');

    // Stage 6: Validation + manifest
    const validator = new Validator(context);
    await validator.run();

    console.log('\n=== ETL Pipeline completed successfully ===');
    console.log(`Output files in: ${workDir}/publish/`);
  } catch (error) {
    console.error('\n=== ETL Pipeline failed ===');
    console.error(error);
    process.exit(1);
  }
}

main();