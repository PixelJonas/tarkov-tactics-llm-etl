# Tarkov Tactics — LLM-ETL Pipeline Build Brief

**Audience:** Claude Code building this application from scratch.

**What this is.** A standalone data pipeline that pulls Escape from Tarkov game data from multiple external sources, normalizes and enriches it, and publishes JSON snapshots that the Tarkov Tactics app loads at startup. One stage of the pipeline uses LLM inference for quest-text enrichment and item-mapping diff/validation; that stage runs offline and **requires human review before publication**.

**Companion documents.** This brief depends on `ranking-system-spec-context.md`. The output schemas defined here are the input contracts for §8.4 (loot probability data sourcing), §8.5 (named POI layer), §9.1 (spawn clustering), and §10 (quest-text parsing) of that document. Read it before building.

**What this is not.** A user-facing app. A live API. A runtime dependency at request time. The Tarkov Tactics app must never invoke this pipeline; it consumes the published outputs only.

---

## 1. What to build

A pipeline application that:

1. Fetches source data from SPT-AKI (community game-file data), tarkov.dev (live GraphQL API), and the-hideout/tarkov-dev (community-curated labels).
2. Runs a chain of transformation stages, each producing inspectable intermediate state.
3. Includes one LLM-enriched stage with mandatory human-review gating.
4. Validates outputs against schemas before publication.
5. Publishes JSON artifacts to a stable public URL the main Tarkov Tactics app fetches at startup.

The pipeline runs on a schedule and on manual trigger via GitHub Actions. It is not invoked by user actions.

---

## 2. Architecture overview

The pipeline is six stages. Each transforms or annotates the data; intermediate state lives in a working directory and is committed only as artifacts of a successful run. The final publish step produces a small set of public JSON files plus a manifest.

```
External Sources
        │
        ▼
[1] Source fetch        SPT-AKI + tarkov.dev GraphQL + the-hideout/tarkov-dev
        │
        ▼
[2] Loot probability normalization
        │
        ▼
[3] Spawn cluster pre-computation
        │
        ▼
[4] Iconic location ingestion + cluster naming
        │
        ▼
[5] Quest structured-field enrichment       ← LLM stage (human review gated)
        │
        ▼
[6] Cross-reference validation + manifest generation
        │
        ▼
Publish → public URL → Tarkov Tactics app reads at startup
```

Each stage must be:

- **Deterministic given its input** — or, for stage 5, reproducible given the same LLM model and seed.
- **Cacheable** — re-runs that find no source changes must skip the stage and reuse prior output.
- **Inspectable** — intermediate state must be plain JSON or NDJSON, human-readable.
- **Replayable** — a single stage must be re-runnable in isolation against its frozen input.

---

## 3. Source data

| Source | Location | What we take | Refresh |
|---|---|---|---|
| SPT-AKI server repo | `github.com/sp-tarkov/server` (read-only, shallow clone or raw file fetch) | `project/assets/database/locations/<map>/looseLoot.json`, `staticLoot.json`, `staticContainers.json` per map | Per game patch |
| tarkov.dev GraphQL API | `https://api.tarkov.dev/graphql` (POST, no auth) | Items (with prices), maps (with spawns, locks, named positions, extracts), tasks (with objectives), bosses, item-properties for keys | Per ETL run |
| the-hideout/tarkov-dev repo | `github.com/the-hideout/tarkov-dev` | Iconic location label data (community-curated, MIT) — exact file path resolves at build time | Per upstream change |
| Tarkov Tactics app repo | This pipeline's own repo or sibling | Configuration (constraint axis taxonomy, vibe definitions) — used as inputs to validation only | On change |

For each source, the pipeline must record the exact commit hash or response timestamp it consumed. This metadata feeds the manifest (§5.6).

---

## 4. Pipeline stages

### 4.1 Stage 1: Source fetch

Pull all source data into a `work/raw/` directory. Each source's output is namespaced (e.g., `work/raw/spt/locations/customs/looseLoot.json`, `work/raw/tarkov-dev/maps.json`, `work/raw/the-hideout/iconic-locations.json`).

For tarkov.dev, the fetch must batch related queries to minimize round-trips. Queries must always pass `lang: en` to get canonical English names.

Cache responses by source-version (SPT commit hash, tarkov.dev response Etag if available, the-hideout commit hash). A subsequent run that finds no changes skips all downstream stages.

### 4.2 Stage 2: Loot probability normalization

**Input:** SPT-AKI raw location files.

**Output:** `loot-probabilities.json` (schema in §5.1).

Process each map's loot data:

1. For each static container type, normalize the item-probability distribution so it sums to 1. Record the source's raw weight for traceability.
2. For each loose-loot region, do the same.
3. Cross-reference SPT item IDs (which use BSG `tpl` IDs) against the tarkov.dev item catalog. Mark rows where the ID is not found in tarkov.dev with `confidence: "id_unmatched"` — these will need LLM-assisted reconciliation in stage 5 or human review.
4. Where SPT has no data for a container type that exists in tarkov.dev's map definition, emit a uniform-prior row: probability = `1 / count of container's allowed item types`, `confidence: "uniform_prior"`.

### 4.3 Stage 3: Spawn cluster pre-computation

**Input:** `Map.spawns` from tarkov.dev (filtered).

**Output:** `spawn-clusters.json` (schema in §5.2).

Per map:

1. Filter spawns: `sides ∋ "Pmc"` AND `categories ∋ "Player"`. Discard everything else.
2. Spatially cluster the filtered points with the map's proximity threshold (configuration value, per-map override allowed; default 75 meters). Use a deterministic algorithm — any reasonable distance-based clustering works as long as the same input always produces the same output.
3. Enforce the cluster-count constraint: minimum 1, maximum `MAX_SPAWN_CLUSTERS` (configuration, default 4). If clustering produces more than the max, repeatedly merge the two closest clusters until the count is satisfied. If clustering produces zero (no PMC spawns found), record the map but produce no clusters — the consumer must handle this.
4. For each cluster, record: centroid, member spawn positions, member `zoneName` values (for downstream labeling), bounding radius.

### 4.4 Stage 4: Iconic location ingestion and cluster naming

**Input:** `iconic-locations.json` raw from the-hideout, plus stage-3 spawn clusters and tarkov.dev's named map positions (extracts, switches, etc.).

**Output:** `named-pois.json` (schema in §5.3).

Process:

1. Re-export the-hideout's iconic labels into the canonical schema, preserving the multi-floor `layer` field (vertical-range disambiguation).
2. For each stage-3 spawn cluster, attempt to attach a name from the iconic labels (nearest-neighbor match within configurable radius, layer-aware). If none matches, fall through.
3. For unmatched clusters, emit a synthetic identifier (`<map>-spawn-<index>`). No LLM is used here unless explicitly configured; cluster naming for spawn points is operational/internal, not user-facing.
4. Optionally: for POI clusters (a separate concept from spawn clusters — these come from the ranking-system app at runtime, not from this ETL), this stage may produce a `poi-name-hints.json` containing pre-resolved iconic labels per spatial region of the map. The runtime app uses this for naming POI clusters it generates.

### 4.5 Stage 5: Quest structured-field enrichment

**Input:** Quest data from tarkov.dev (`tasks` query with full objective fields).

**Output:** `quest-enhancements.json` (schema in §5.4) plus a `quest-enhancements.diff.md` human-review document.

This is the LLM stage. Process:

1. Identify quests where the structured `TaskObjective*` fields are incomplete relative to the constraint axes the ranking system expects (per ranking-system-spec-context.md §6.4.1: map restriction, zone restriction, body parts, weapon specific, weapon class, weapon mods, wearing required, not wearing, distance, time of day, shot type, health state, required keys).
2. For each such quest, call the LLM with: the quest description text, the objective description text, the expected constraint-axis taxonomy, and an explicit instruction to return structured JSON matching the schema in §5.4.
3. The LLM call must be deterministic (`temperature: 0` or equivalent) and must include a model identifier in the output for provenance.
4. Validate each LLM response against the schema. Reject responses that fail schema validation; mark the quest as `enrichment_status: "schema_invalid"` for human review.
5. For each successful enrichment, also emit a diff entry in `quest-enhancements.diff.md`: the original objective text, the structured fields the LLM produced, and the constraint axes it set. This document is the human-review artifact.

**Critical safety constraint:** the output of this stage must not be published until a human reviews `quest-enhancements.diff.md` and approves. The GitHub Actions workflow must open a Pull Request rather than committing to the publish branch directly (see §8).

**Item-ID reconciliation extension:** if stage 2 produced rows with `confidence: "id_unmatched"`, this stage may also include an LLM-assisted item-ID-mapping pass: given an unmatched SPT ID and the surrounding context (container, map), the LLM proposes a tarkov.dev item ID match with confidence. Output goes to `item-id-reconciliation.json` and is reviewed the same way.

### 4.6 Stage 6: Cross-reference validation and manifest generation

**Input:** All outputs from stages 2-5.

**Output:** `manifest.json` (schema in §5.5). The stage also writes a `validation-report.md` that fails the workflow if errors are found.

Validations the pipeline must enforce:

- Every item ID referenced in `loot-probabilities.json` exists in the tarkov.dev item catalog OR is marked with a non-clean confidence.
- Every map ID referenced anywhere exists in the tarkov.dev map catalog.
- Every spawn cluster has at least one member spawn point.
- Every quest enhancement references a quest ID that exists in tarkov.dev's task catalog.
- All published files validate against their schemas.

If any validation fails, the workflow must fail. Validation warnings (non-fatal issues like uniform-prior fallbacks) must be summarized in the validation report.

The manifest records the version (game patch + ETL run timestamp), SHA-256 of each published file, source commit hashes, and the LLM model used in stage 5 if applicable.

---

## 5. Output contracts

These schemas are the contract with the consuming Tarkov Tactics app. Changes here must coordinate with §8.4, §8.5, §9.1, and §10 of the ranking-system spec.

All published files use UTF-8 JSON. All IDs are strings. All positions are `{ x: number, y: number, z: number }` in the game's world coordinate system (meters). All probabilities are floats in `[0, 1]`.

### 5.1 `loot-probabilities.json`

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "2026-05-25T10:00:00Z",
  "game_patch": "0.16.5.1.40234",
  "maps": {
    "<map_id>": {
      "containers": {
        "<container_type_id>": {
          "items": [
            {
              "item_id": "<tarkov_dev_item_id>",
              "probability": 0.0123,
              "confidence": "spt_direct" | "uniform_prior" | "id_unmatched" | "reconciled"
            }
          ]
        }
      },
      "loose_loot_regions": [
        {
          "region_id": "<region_id>",
          "center": { "x": 0, "y": 0, "z": 0 },
          "radius": 25.0,
          "items": [
            { "item_id": "<id>", "probability": 0.01, "confidence": "spt_direct" }
          ]
        }
      ]
    }
  }
}
```

### 5.2 `spawn-clusters.json`

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "2026-05-25T10:00:00Z",
  "config": {
    "max_clusters_per_map": 4,
    "min_clusters_per_map": 1,
    "default_proximity_threshold_m": 75
  },
  "maps": {
    "<map_id>": {
      "proximity_threshold_used_m": 75,
      "clusters": [
        {
          "cluster_id": "<map_id>-spawn-1",
          "centroid": { "x": 0, "y": 0, "z": 0 },
          "radius_m": 25.0,
          "member_count": 5,
          "zone_names": ["ZoneOLI", "ZoneOLI"],
          "members": [
            { "position": { "x": 0, "y": 0, "z": 0 }, "zone_name": "ZoneOLI" }
          ]
        }
      ]
    }
  }
}
```

### 5.3 `named-pois.json`

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "2026-05-25T10:00:00Z",
  "maps": {
    "<map_id>": {
      "iconic_labels": [
        {
          "name": "Dorms",
          "center": { "x": 0, "y": 0, "z": 0 },
          "layer_range_y": [0, 10],
          "source": "the-hideout/tarkov-dev"
        }
      ],
      "spawn_cluster_names": {
        "<cluster_id>": {
          "name": "Boiler Side",
          "source": "iconic_match" | "synthetic"
        }
      }
    }
  }
}
```

### 5.4 `quest-enhancements.json`

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "2026-05-25T10:00:00Z",
  "llm_model": "<provider>:<model>:<version>",
  "quests": {
    "<quest_id>": {
      "enrichment_status": "complete" | "schema_invalid" | "skipped" | "review_pending",
      "objectives": [
        {
          "objective_id": "<objective_id>",
          "constraints": {
            "maps": ["<map_id>"],
            "zone": null,
            "body_parts": null,
            "weapon_specific_item": null,
            "weapon_class": "Assault rifles",
            "weapon_mods_required": [],
            "wearing_required": [],
            "not_wearing": [],
            "distance_min_m": 50,
            "distance_max_m": null,
            "time_of_day": null,
            "shot_type": null,
            "health_state": null,
            "required_keys": []
          },
          "source_text": "<verbatim from tarkov.dev>",
          "reviewed_by": "<github username, populated after PR merge>",
          "reviewed_at": "<ISO timestamp, populated after PR merge>"
        }
      ]
    }
  }
}
```

### 5.5 `manifest.json`

```jsonc
{
  "schema_version": "1.0",
  "version": "0.16.5.1.40234+20260525T1000Z",
  "game_patch": "0.16.5.1.40234",
  "generated_at": "2026-05-25T10:00:00Z",
  "sources": {
    "spt_aki_commit": "<hash>",
    "tarkov_dev_query_time": "2026-05-25T09:55:00Z",
    "the_hideout_commit": "<hash>"
  },
  "llm": {
    "model": "<provider:model:version>",
    "stage_5_completed": true
  },
  "files": [
    {
      "name": "loot-probabilities.json",
      "sha256": "<hex>",
      "size_bytes": 12345678
    }
  ]
}
```

The consuming app reads the manifest first, validates the SHA-256 of each file it downloads, and refuses to use mismatched files.

### 5.6 Cache-busting

Published files live at a versioned URL: `https://<base>/v/<version>/<filename>`, plus a `latest/` alias that redirects (HTTP or symlink, depending on hosting) to the most recent version. The consuming app reads `latest/manifest.json`, learns the version, then fetches versioned files. This decouples cache invalidation from the consumer.

---

## 6. LLM integration boundaries

The pipeline uses LLM inference at exactly one stage (§4.5), with optional secondary use for item-ID reconciliation. All LLM use in this pipeline must satisfy:

1. **Offline only.** LLM calls happen during the ETL run, never at user request time. The published JSON is the only thing users see.
2. **Deterministic configuration.** Temperature 0 (or equivalent), explicit seed where the API supports it, model ID recorded in the output.
3. **Schema-validated output.** Every LLM response must validate against §5.4 before being accepted. Schema-invalid responses are surfaced as `enrichment_status: "schema_invalid"` for human review.
4. **Human review gate.** No LLM-enriched output may be published without a human approving the diff in `quest-enhancements.diff.md`. GitHub Actions must open a PR with the enrichment as a separate commit; merging the PR is the explicit human approval.
5. **Provider-agnostic.** The LLM call must read its endpoint, model, and credentials from environment variables. Support at minimum: hosted APIs (Anthropic, OpenAI, OpenRouter) and self-hosted endpoints (Ollama-style or OpenAI-compatible). The same prompt must work across providers without behavior-altering modifications.

**Prompt design constraint.** The LLM prompt for quest enrichment must:

- State the exact JSON schema the response must match (the per-objective fragment from §5.4).
- Enumerate the constraint axes and their allowed values where applicable.
- Instruct the model not to invent constraints not present in the source text.
- Include 2-3 worked examples spanning the constraint-axis range (e.g., one quest with weapon class + distance constraints, one quest with no constraints, one quest with map + time-of-day constraints). Examples must be drawn from real quests with verified correct outputs, not synthetic ones.

**If LLM access is not configured at run time,** the pipeline must still complete all other stages and publish the outputs. Quest enhancement is skipped; the consuming app falls back to the unenhanced tarkov.dev quest data per ranking-system spec §10's deterministic-fallback rules.

---

## 7. Hosting and distribution

**Recommended: GitHub Pages from a `gh-pages` branch of this ETL repo.** Rationale:

- Free CDN serving with reasonable latency worldwide.
- Public access, no auth handshake from the consuming app.
- Independent of the main Tarkov Tactics repo — data updates do not require main-repo PRs.
- Easy to update via GitHub Actions: write to `gh-pages` branch, force-push, done.

**Published URL layout:**

```
https://<owner>.github.io/<etl-repo>/
├── latest/
│   ├── manifest.json
│   ├── loot-probabilities.json
│   ├── spawn-clusters.json
│   ├── named-pois.json
│   └── quest-enhancements.json
└── v/
    └── <version>/
        └── (same files, immutable per version)
```

**Alternatives** (note as options if Pages is unsuitable):

- **GitHub Releases as binary assets:** good for very large data; less convenient for the consuming app to fetch.
- **A `data/` subdirectory in the main app repo:** simplest, but bloats the main repo and couples data updates to code releases.
- **Separate data repo:** clean separation, but adds a third coordination point. Only worth it if data sharing across multiple consumers becomes a thing.

Use GitHub Pages unless there's a specific reason not to.

---

## 8. Operations

### 8.1 Update cadence

- **On Tarkov patch:** trigger ETL manually within ~24h of the patch landing. SPT-AKI typically updates within hours to days; wait for their data update before re-running.
- **Weekly drift check:** automated GitHub Actions cron job runs the pipeline; if no source changes are detected, it exits early. If changes are detected without a patch event, it opens a PR for human review.
- **On demand:** any contributor with push access can trigger the workflow manually via `workflow_dispatch`.

### 8.2 GitHub Actions workflow outline

The workflow must:

1. Check out the ETL repo with full history (need it for caching source versions).
2. Restore the source-fetch cache.
3. Run stage 1; exit early if no source changes.
4. Run stages 2-4 (deterministic, no LLM).
5. **If LLM credentials are present in repo secrets:** run stage 5. Open a PR against the publish branch with the enhanced quest data. Stop here.
6. **If LLM credentials are absent:** skip stage 5 (mark `quest-enhancements.json` as `enrichment_status: "skipped"` for all affected quests).
7. Run stage 6 (validation + manifest).
8. If a PR was opened in step 5, wait for human merge. Otherwise, push the publish branch directly.
9. Publish to GitHub Pages.

The workflow must surface human-review artifacts (`quest-enhancements.diff.md`, `validation-report.md`) as PR comments or step summaries.

### 8.3 Secrets and credentials

The workflow needs:

- `LLM_API_BASE`, `LLM_MODEL`, `LLM_API_KEY` (optional — pipeline runs without these, just skipping stage 5).
- A GitHub token with `contents: write` on the ETL repo (for publishing) and `pull-requests: write` (for review PRs). The default `GITHUB_TOKEN` is sufficient.

---

## 9. Configuration

A single `etl.config.json` (or `.yaml`) committed to the repo. Required keys:

- **`spawn_clustering`**: `default_proximity_threshold_m` (number), `max_clusters_per_map` (integer), per-map overrides (map of `<map_id>` → `{ proximity_threshold_m }`).
- **`loot_probability`**: `uniform_prior_fallback_enabled` (boolean).
- **`naming`**: `iconic_match_radius_m` (number), `layer_aware_matching` (boolean).
- **`llm`**: `enabled` (boolean — falls back to env-var presence if unset), `prompt_template_path` (string), `expected_schema_path` (string).
- **`validation`**: `fail_on_unmatched_item_ids` (boolean), `fail_on_missing_iconic_labels` (boolean).

No values should be hardcoded in the pipeline source. Every numerical threshold lives in this config.

---

## 10. Quality gates

Before any publish:

1. **Schema validation** on every output file (§5).
2. **Cross-reference validation** (§4.6).
3. **Diff inspection** — for any LLM-enriched data, the diff must be reviewed and approved by a human reviewer via PR merge.
4. **Size check** — total published payload must be under a configurable cap (default 50 MB) to keep startup latency reasonable for the main app.
5. **Backward-compatibility check** — schema version must match what the most recent main-app release expects, OR the main app must be updated first. The workflow surfaces the schema version it would publish and the version the main app currently expects (read from main app's repo) for the reviewer to compare.

---

## 11. Repository structure recommendation

```
tarkov-tactics-etl/
├── README.md
├── etl.config.json
├── src/
│   ├── stages/
│   │   ├── 01-fetch.ts
│   │   ├── 02-loot.ts
│   │   ├── 03-spawns.ts
│   │   ├── 04-names.ts
│   │   ├── 05-quests-llm.ts
│   │   └── 06-validate-manifest.ts
│   ├── llm/
│   │   ├── client.ts             # provider-agnostic LLM client
│   │   └── prompts/
│   │       └── quest-enrichment.md
│   ├── schemas/
│   │   ├── loot-probabilities.schema.json
│   │   ├── spawn-clusters.schema.json
│   │   ├── named-pois.schema.json
│   │   ├── quest-enhancements.schema.json
│   │   └── manifest.schema.json
│   └── lib/
│       ├── clustering.ts
│       ├── tarkov-dev-client.ts
│       └── spt-source.ts
├── work/                         # gitignored; intermediate state
├── .github/
│   └── workflows/
│       ├── etl.yml               # main pipeline
│       └── publish.yml           # gh-pages publish (separate so PR review gates work)
└── tests/
    ├── fixtures/                 # frozen source snapshots for regression tests
    └── ...
```

Language choice: TypeScript on Node is recommended for consistency with the consuming Next.js app and to share the schemas across both. Python is acceptable if a contributor has a strong preference; the LLM-client and clustering libraries are mature in both ecosystems. The workflow and output contracts are language-agnostic.

---

## 12. Claude Code workflow

Phases for Claude Code to execute:

### Phase 1: Orient

1. Read `ranking-system-spec-context.md` end-to-end. Pay particular attention to §6.4.1 (constraint axes), §8.3 (Key Economics), §8.4 (loot probability sourcing), §8.5 (named POI layer), §9.1 (spawn clustering), §10 (LLM boundaries).
2. Read this brief end-to-end.
3. Identify the host repo for the ETL pipeline. Likely options: a new sibling repo `tarkov-tactics-etl`, or an `etl/` subdirectory of `tarkov-tactics-app`. Recommend one with rationale; await my confirmation before scaffolding.
4. Verify the tarkov.dev GraphQL schema is reachable and matches the field names this brief assumes (`Map.spawns.sides`, `Map.spawns.categories`, `Map.spawns.zoneName`, `Item.buyFor`, `Map.locks`, `ItemPropertiesKey.uses`, etc.). Report discrepancies before building against assumptions.
5. Identify the path to the-hideout/tarkov-dev's iconic location labels in the current repo state. The file location may have changed since this brief was written.

### Phase 2: Propose scaffolding

Based on Phase 1, propose:

- Host location (separate repo vs subdirectory).
- Language choice (TypeScript recommended; flag if you'd choose otherwise).
- Stage decomposition (default is the 6 stages in §4; you may merge or split with rationale).
- Initial `etl.config.json` shape with placeholder defaults.

Wait for my confirmation.

### Phase 3: Build stages 1, 2, 3, 6 first

These are the deterministic, non-LLM stages. Build them first so the pipeline can produce useful output before LLM integration is in place. Each stage gets:

- Implementation in `src/stages/`.
- JSON schema in `src/schemas/`.
- A small fixture-based test in `tests/` that exercises the stage against a frozen sample.
- An entry in the GitHub Actions workflow.

After these are working end-to-end (pipeline produces a valid `manifest.json` + non-LLM outputs), report and pause.

### Phase 4: Build stage 4 (named POIs)

This stage depends on stage 3 output and the iconic-label data. It does not require LLM. Build after Phase 3 is confirmed working.

### Phase 5: Build stage 5 (LLM quest enrichment)

Last. Implement:

- The LLM client with provider-agnostic configuration.
- The prompt template, with 2-3 verified worked examples.
- Schema validation of LLM responses.
- The PR-opening workflow with diff artifact.
- The "no LLM credentials, skip stage" fallback.

Validate stage 5 end-to-end with at least one real quest from the current patch where the structured data is incomplete. Surface the LLM output for me to review before considering the stage done.

### Phase 6: Publish workflow and consumer integration

1. Set up the `gh-pages` publish workflow.
2. Document the URL layout in the README.
3. Write a small TypeScript module in the main Tarkov Tactics app (separate PR) that reads `latest/manifest.json`, validates SHA-256s, and loads the JSON files at startup with the published URL configurable via env var.

### Constraints throughout

- Do not commit anything to the consuming app's repo without my explicit approval.
- Do not invent fields not present in this brief; flag missing requirements as `[NEEDS CLARIFICATION]` and surface in your phase report.
- Do not run real LLM calls with my credentials during scaffolding — use a mock client until I confirm.
- Every published file must validate against its schema before being written to the publish branch.
- Maintain the human-review gate on LLM-enriched output without exception.

### What to ask me about, not invent

- The exact LLM provider and model to target first (Anthropic Claude, OpenAI GPT, OpenRouter, self-hosted Ollama — Jonas runs his own stack and may want to use it).
- Whether `quest-enhancements.json` should ship with all quests (including those that need no enhancement, marked `enrichment_status: "complete"` with the original tarkov.dev fields passed through) or only the enriched ones.
- The acceptable startup-latency budget for the consuming app — this affects the size cap in §10.

---

*End of build brief.*
