// Stage 5: Quest structured-field enrichment (LLM stage)
// Human review gated — outputs a diff document for PR review

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  QuestEnhancements,
  QuestConstraints,
  QuestObjectiveEnhancement,
  EnrichmentStatus,
  StageContext,
} from '../lib/types.js';
import { callLLM, isLLMConfigured, getLLMModelIdentifier, LLMMessage } from '../llm/client.js';
import { schemaValidator, initializeSchemas } from '../lib/schema-validator.js';

// Constraint axes from ranking-system-spec §6.4.1
const CONSTRAINT_AXES = [
  'maps', 'zone', 'body_parts', 'weapon_specific_item', 'weapon_class',
  'weapon_mods_required', 'wearing_required', 'not_wearing',
  'distance_min_m', 'distance_max_m', 'time_of_day', 'shot_type',
  'health_state', 'required_keys',
] as const;

// Objective types that may benefit from enrichment
const ENRICHABLE_TYPES = ['shoot', 'mark', 'plantItem', 'visitPlace', 'extract'];

interface RawTask {
  id: string;
  name: string;
  objectives: Array<{
    id: string;
    type: string;
    description: string;
    maps?: Array<{ id: string; name: string }>;
  }>;
}

export class QuestEnricher {
  private context: StageContext;
  private promptTemplate: string = '';

  constructor(context: StageContext) {
    this.context = context;
  }

  async run(): Promise<QuestEnhancements> {
    console.log('📝 Stage 5: Quest enrichment...');

    const outputDir = join(this.context.workDir, 'stage5');
    await mkdir(outputDir, { recursive: true });

    const llmConfigured = isLLMConfigured() && this.context.config.llm.enabled;
    const modelId = getLLMModelIdentifier();

    const result: QuestEnhancements = {
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      llm_model: modelId,
      quests: {},
    };

    // Load task data
    const tasksPath = join(this.context.workDir, 'raw', 'tarkov-dev', 'tasks.json');
    const tasksContent = await readFile(tasksPath, 'utf-8');
    const tasks: RawTask[] = JSON.parse(tasksContent);

    if (!llmConfigured) {
      console.log('  LLM not configured, marking all quests as skipped');
      for (const task of tasks) {
        result.quests[task.id] = {
          enrichment_status: 'skipped',
          objectives: task.objectives.map(obj => ({
            objective_id: obj.id,
            constraints: this.extractDeterministicConstraints(obj),
            source_text: obj.description,
            reviewed_by: null,
            reviewed_at: null,
          })),
        };
      }
    } else {
      console.log(`  LLM configured: ${modelId}`);
      this.promptTemplate = await this.loadPromptTemplate();

      const diffEntries: string[] = [];

      for (const task of tasks) {
        const needsEnrichment = this.needsEnrichment(task);

        if (!needsEnrichment) {
          // Extract what we can deterministically
          result.quests[task.id] = {
            enrichment_status: 'complete',
            objectives: task.objectives.map(obj => ({
              objective_id: obj.id,
              constraints: this.extractDeterministicConstraints(obj),
              source_text: obj.description,
              reviewed_by: null,
              reviewed_at: null,
            })),
          };
          continue;
        }

        // LLM enrichment
        try {
          const objectives: QuestObjectiveEnhancement[] = [];

          for (const obj of task.objectives) {
            if (!ENRICHABLE_TYPES.includes(obj.type)) {
              objectives.push({
                objective_id: obj.id,
                constraints: this.extractDeterministicConstraints(obj),
                source_text: obj.description,
                reviewed_by: null,
                reviewed_at: null,
              });
              continue;
            }

            const llmConstraints = await this.enrichObjectiveWithLLM(obj);

            if (llmConstraints) {
              // Merge deterministic data with LLM enrichment
              const deterministicConstraints = this.extractDeterministicConstraints(obj);
              const mergedConstraints = this.mergeConstraints(deterministicConstraints, llmConstraints);

              objectives.push({
                objective_id: obj.id,
                constraints: mergedConstraints,
                source_text: obj.description,
                reviewed_by: null,
                reviewed_at: null,
              });

              // Add diff entry
              diffEntries.push(this.formatDiffEntry(task, obj, mergedConstraints));
            } else {
              objectives.push({
                objective_id: obj.id,
                constraints: this.extractDeterministicConstraints(obj),
                source_text: obj.description,
                reviewed_by: null,
                reviewed_at: null,
              });
            }
          }

          result.quests[task.id] = {
            enrichment_status: 'review_pending',
            objectives,
          };
        } catch (error) {
          console.error(`  Error enriching task ${task.id}: ${error}`);
          result.quests[task.id] = {
            enrichment_status: 'schema_invalid',
            objectives: task.objectives.map(obj => ({
              objective_id: obj.id,
              constraints: this.extractDeterministicConstraints(obj),
              source_text: obj.description,
              reviewed_by: null,
              reviewed_at: null,
            })),
          };
        }
      }

      // Write diff document for human review
      if (diffEntries.length > 0) {
        const diffContent = this.formatDiffDocument(diffEntries);
        await writeFile(join(outputDir, 'quest-enhancements.diff.md'), diffContent);
        console.log(`  Generated diff with ${diffEntries.length} enriched objectives`);
      }
    }

    const outputPath = join(outputDir, 'quest-enhancements.json');
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log('✓ Stage 5 completed');

    return result;
  }

  private needsEnrichment(task: RawTask): boolean {
    return task.objectives.some(obj =>
      ENRICHABLE_TYPES.includes(obj.type) &&
      obj.description.length > 0
    );
  }

  private extractDeterministicConstraints(
    obj: { id: string; type: string; description: string; maps?: Array<{ id: string; name: string }> }
  ): QuestConstraints {
    return {
      maps: obj.maps && obj.maps.length > 0 ? obj.maps.map(m => m.id) : null,
      zone: null,
      body_parts: null,
      weapon_specific_item: null,
      weapon_class: null,
      weapon_mods_required: [],
      wearing_required: [],
      not_wearing: [],
      distance_min_m: null,
      distance_max_m: null,
      time_of_day: null,
      shot_type: null,
      health_state: null,
      required_keys: [],
    };
  }

  private async enrichObjectiveWithLLM(
    obj: { id: string; type: string; description: string; maps?: Array<{ id: string; name: string }> }
  ): Promise<QuestConstraints | null> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: this.promptTemplate,
      },
      {
        role: 'user',
        content: `Extract constraints from this quest objective:\n\nObjective type: ${obj.type}\nDescription: "${obj.description}"${obj.maps ? `\nMaps: ${obj.maps.map(m => `${m.name} (${m.id})`).join(', ')}` : ''}\n\nReturn ONLY the JSON object.`,
      },
    ];

    try {
      const response = await callLLM(messages);
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn(`    No JSON found in LLM response for objective ${obj.id}`);
        return null;
      }

      const constraints = JSON.parse(jsonMatch[0]) as QuestConstraints;

      // Validate the response has the right shape
      if (!this.validateConstraints(constraints)) {
        console.warn(`    Invalid constraints from LLM for objective ${obj.id}`);
        return null;
      }

      return constraints;
    } catch (error) {
      console.warn(`    LLM call failed for objective ${obj.id}: ${error}`);
      return null;
    }
  }

  private validateConstraints(constraints: unknown): constraints is QuestConstraints {
    if (!constraints || typeof constraints !== 'object') return false;
    const c = constraints as Record<string, unknown>;

    // Verify array fields are arrays (or null where allowed)
    const arrayFields = ['weapon_mods_required', 'wearing_required', 'not_wearing', 'required_keys'];
    for (const field of arrayFields) {
      if (c[field] !== undefined && !Array.isArray(c[field])) return false;
    }

    // Verify number fields
    const numFields = ['distance_min_m', 'distance_max_m'];
    for (const field of numFields) {
      if (c[field] !== undefined && c[field] !== null && typeof c[field] !== 'number') return false;
    }

    return true;
  }

  private mergeConstraints(
    deterministic: QuestConstraints,
    llm: QuestConstraints
  ): QuestConstraints {
    // Deterministic data takes precedence (e.g., map from structured API data)
    return {
      maps: deterministic.maps || llm.maps,
      zone: llm.zone,
      body_parts: llm.body_parts,
      weapon_specific_item: llm.weapon_specific_item,
      weapon_class: llm.weapon_class,
      weapon_mods_required: llm.weapon_mods_required || [],
      wearing_required: llm.wearing_required || [],
      not_wearing: llm.not_wearing || [],
      distance_min_m: llm.distance_min_m ?? null,
      distance_max_m: llm.distance_max_m ?? null,
      time_of_day: llm.time_of_day ?? null,
      shot_type: llm.shot_type ?? null,
      health_state: llm.health_state ?? null,
      required_keys: llm.required_keys || [],
    };
  }

  private async loadPromptTemplate(): Promise<string> {
    const templatePath = this.context.config.llm.prompt_template_path;
    try {
      return await readFile(templatePath, 'utf-8');
    } catch {
      console.warn('  Could not load prompt template, using built-in');
      return 'You are a game data parser. Extract constraint fields from quest objective text. Return only JSON.';
    }
  }

  private formatDiffEntry(
    task: RawTask,
    obj: { id: string; description: string },
    constraints: QuestConstraints
  ): string {
    const activeConstraints = Object.entries(constraints)
      .filter(([_, v]) => v !== null && (!Array.isArray(v) || v.length > 0))
      .map(([k, v]) => `  - **${k}**: ${JSON.stringify(v)}`)
      .join('\n');

    return `### ${task.name} — Objective ${obj.id}\n\n**Source text:** "${obj.description}"\n\n**Extracted constraints:**\n${activeConstraints || '  (none)'}\n`;
  }

  private formatDiffDocument(entries: string[]): string {
    return `# Quest Enhancement Diff — Human Review Required\n\nGenerated: ${new Date().toISOString()}\nModel: ${getLLMModelIdentifier()}\n\nReview each entry below. Approve by merging the PR.\n\n---\n\n${entries.join('\n---\n\n')}\n`;
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

  const enricher = new QuestEnricher(context);
  try {
    await enricher.run();
    console.log('✅ Stage 5 (quests) completed successfully');
  } catch (error) {
    console.error('❌ Stage 5 (quests) failed:', error);
    process.exit(1);
  }
}