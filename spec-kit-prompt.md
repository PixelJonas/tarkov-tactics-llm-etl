# Prompt for Claude Code — Generate spec-kit specifications for the Tarkov Tactics ranking system

## Context

You are working in the `tarkov-tactics/tarkov-tactics-app` repository. The repo uses GitHub's spec-kit for spec-driven development (see the `.specify/` directory).

The file `ranking-system-spec-context.md` (attached / in the working directory) is the authoritative design document for the ranking system. It is implementation-agnostic and describes the behavior the system must exhibit. Treat it as the single source of truth for **what** the ranking system does. Your job is to translate it into spec-kit feature specifications.

The wiki pages `Component-Architecture`, `Core-Concepts`, `Goals-System`, `Data-Availability`, `Tarkov-dev-API`, and `TarkovTracker-API` provide additional product context. The spec-context document already incorporates them; consult the wiki only if something in the spec-context is ambiguous.

## ETL Data Availability

A companion pipeline (`tarkov-tactics/tarkov-tactics-llm-etl`) pre-computes and publishes several data artifacts that the ranking system consumes. These are available as static JSON files served via GitHub Pages at a configurable base URL (default: `https://tarkov-tactics.github.io/tarkov-tactics-llm-etl/`).

### Published data contracts

The app reads `latest/manifest.json` first, validates SHA-256 hashes of each file it downloads, and refuses to use mismatched files. All files use schema version `"1.0"`.

| File | Spec reference | Content | Current state |
|------|---------------|---------|---------------|
| `manifest.json` | §5.5 | Version, game patch, source provenance (SPT commit, tarkov.dev query time, the-hideout commit), SHA-256 hashes of all files | Available |
| `spawn-clusters.json` | §5.2, §9.1 | Pre-computed PMC spawn clusters per map (16 maps, 52 clusters). Filtered `sides ∋ "Pmc" AND categories ∋ "Player"`, spatially clustered with per-map proximity thresholds, capped at 4 clusters/map. Each cluster has centroid, members, radius, zone names. | Available |
| `named-pois.json` | §5.3, §8.5 | Human-readable names for every spawn cluster. Uses extract/switch positions from tarkov.dev API, with directional proximity fallback ("Near Old Gas Station", "SE of Bridge V-Ex"). | Available |
| `loot-probabilities.json` | §5.1, §8.4 | Per-map, per-container-type item probability distributions normalized to sum to 1. Cross-referenced against tarkov.dev item catalog. Confidence flags: `spt_direct`, `uniform_prior`, `id_unmatched`, `reconciled`. | Available (container loot from SPT `staticLoot.json`; loose loot pending Git LFS resolution) |
| `quest-enhancements.json` | §5.4, §10 | Structured constraint extraction from quest objective text. Per-objective constraint axes: maps, zone, body_parts, weapon_class, weapon_specific_item, weapon_mods_required, wearing_required, not_wearing, distance_min/max, time_of_day, shot_type, health_state, required_keys. Only includes quests that need enrichment (265 of 499). | Available (LLM-enriched version with 517/517 objectives enriched at 0% error rate; deterministic fallback version also available) |

### Defensive consumption requirements

The consuming app **must not break** if the ETL data is unavailable, stale, or partially populated. For each data file:

- **`spawn-clusters.json` unavailable**: The app must fall back to fetching `Map.spawns` from tarkov.dev at runtime, filtering to PMC player spawns, and clustering on-the-fly. This is slower but functionally equivalent. Cache the result for the session.
- **`named-pois.json` unavailable**: Use synthetic identifiers (`<map-name>-spawn-<index>`) for cluster names. The ranking system still functions; only the user-facing display degrades.
- **`loot-probabilities.json` unavailable**: Use uniform priors (`1 / item_count_per_container_type`) for all loot scoring. Set confidence to `"uniform_prior"` across the board. Log a warning visible to the user that loot scoring accuracy is reduced.
- **`quest-enhancements.json` unavailable**: Use only the structured fields from tarkov.dev's `TaskObjective` type (map restriction and objective type). Quests with missing constraint data degrade gracefully: their objectives contribute zero to POI matching by location and rely on map-level matching only. This is the deterministic fallback described in spec §10.
- **`manifest.json` unavailable or SHA-256 mismatch**: Refuse to use any ETL data. Fall back to all-runtime behavior as described above. Surface a non-blocking warning to the user.
- **Partial data**: If some files are available but others are not, use what's available. Each file is independently consumable.

### Data loader contract

The app must implement a data loader module that:

1. Reads `latest/manifest.json` from the configured ETL base URL (environment variable).
2. Validates the `schema_version` matches what the app expects (`"1.0"`).
3. Fetches each file listed in `manifest.files`, validates its SHA-256 against the manifest.
4. Caches the loaded data for the app's lifetime (no re-fetching per request).
5. Exposes a typed API that the ranking system stages consume, with each accessor returning either the ETL data or a `null`/fallback indicator.
6. Logs provenance: the ETL version, game patch, and source timestamps, so the user knows what data version they're operating on.

## Phase 1 — Orient yourself before generating anything

Do **not** create or modify any spec files yet. First:

1. List the contents of `.specify/` and read its templates and scripts. Identify which slash commands are available (`/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, etc., or the equivalents for this repo's spec-kit version).
2. Read `/memory/constitution.md` if it exists. Note any project principles that constrain the ranking system's design.
3. List the contents of `specs/` (or wherever existing feature specs live). Read any existing specs that might overlap with the ranking system to avoid duplication.
4. Read `ranking-system-spec-context.md` end-to-end.
5. Report back with: a summary of the existing spec-kit setup, any existing specs you found, and any constitution principles that affect the ranking system.

## Phase 2 — Propose a feature decomposition

The ranking system is too large for one feature spec. Propose a decomposition into spec-kit features. Likely candidates (you may adjust):

1. **ETL Data Loader** — The module that fetches, validates, and caches the pre-computed ETL data from GitHub Pages. Must implement defensive fallback for every data file. References the "ETL Data Availability" section above, §5 output contracts, §12.1 cache layers.
2. **Requirement Impact Scoring** — Stage 1 (`R(r)`), including the Requirement DAG, gating value `G(r)`, passive-quest unlock value `P_passive(r)` with constraint decomposition, and the availability/key gates `A(r)`/`K(r)`. References §5, §6 of the spec-context. The passive-quest scoring consumes `quest-enhancements.json` for constraint axes when available; falls back to tarkov.dev structured fields otherwise.
3. **Item Priority Scoring** — Stage 2 (`I(i)`), the roll-up from requirement impact to items, with FIR handling and the stash blind spot. References §7.
4. **POI Cluster Generation and Scoring** — Stage 3 cluster generation, `P(c)` scoring with loot/objective/boss components, named POI layer. Loot scoring consumes `loot-probabilities.json` from the ETL; falls back to uniform priors. Named POI layer consumes `named-pois.json`; falls back to synthetic identifiers. References §8.1, §8.2, §8.5.
5. **Key Economics Module** — Stage 3 sub-module: amortized key cost, degraded sub-clusters for unobtainable keys, loadout cost integration. References §8.3.
6. **Map Scoring and Route Optimization** — Stage 4 (`M(m)`), route construction within time budget, vibe and risk modifiers, active constrained-quest map bonus. Spawn clusters are consumed from `spawn-clusters.json` pre-computed by the ETL; falls back to runtime clustering from tarkov.dev `Map.spawns`. References §9.
7. **Ranking-to-Loadout Interface Contract** — the structured payload from ranking output to the loadout engine. References §11.

**Output for Phase 2.** Present the proposed decomposition with: feature name, the spec-context sections each feature derives from, and your rationale for the grouping. Wait for my confirmation before proceeding.

## Phase 3 — Generate feature specifications

After I confirm the decomposition, for each feature:

1. Invoke `/speckit.specify` (or the repo's equivalent) with a feature description derived from the relevant spec-context sections.
2. Fill in the generated spec template using **only behavioral and structural requirements**. Specifically:
   - **No** specific algorithm names from this document (e.g., do not name DBSCAN, PageRank, Orienteering Problem). Describe behavior: "the system must group points by spatial proximity," "the system must propagate values backward through the unlock graph with exponential decay."
   - **No** language, framework, library, or API choices.
   - **No** code, pseudocode, or type definitions. Mathematical relationships expressed as formulas are acceptable; specific data-structure layouts are not.
   - **No** mention of internal class or module names.
3. Capture the acceptance examples in the spec-context (such as the passiveness calculation examples in §6.4.4 and the Key Economics POI access scenarios in §8.3) as **acceptance criteria / scenarios** in the spec.
4. List edge cases explicitly. The spec-context surfaces many: stash data unavailable, key unobtainable, quest with no purchase path, loadout infeasibility for an active quest, runner-up map within tolerance, etc. **Additionally, every feature that consumes ETL data must include edge cases for: data unavailable, data stale (older than configurable threshold), data schema version mismatch, individual file SHA-256 mismatch, and partial data availability.**
5. Where the spec-context explicitly identifies a configuration parameter (see §13), record it in the spec as a configurable input with a description of its purpose — but do not hardcode values into the spec.
6. For features consuming ETL data, specify:
   - Which ETL file(s) the feature reads.
   - The exact fallback behavior when that file is unavailable.
   - How the feature surfaces data provenance (ETL version, staleness) to the user.
7. Mark anything ambiguous as `[NEEDS CLARIFICATION: <question>]` rather than guessing.

After each feature spec is generated:
- Validate it against the spec-kit Specification Quality Checklist (the template generates one): no implementation details, requirements testable and unambiguous, success criteria measurable and technology-agnostic, edge cases identified, scope bounded.
- Confirm there are no leaked implementation details (search the spec for forbidden words: "DBSCAN", "PageRank", "Orienteering", "TypeScript", "Python", "GraphQL", "DAG" as an algorithmic term, any library names).

## Phase 4 — Stop and summarize

After all feature specs are generated, do **not** run `/speckit.plan`, `/speckit.tasks`, or `/speckit.implement`. Those come after I review the specs.

Produce a final summary containing:

- A table mapping each feature to its spec file path and the spec-context sections it derives from.
- Any `[NEEDS CLARIFICATION]` markers across all specs, grouped by feature.
- A recommendation of any decisions from the spec-context's Design Decisions Log (§16) that should be promoted to the project's `constitution.md` because they apply across multiple features (e.g., "all scoring components must be normalized to [0, 1]" is a cross-cutting principle).
- A recommendation of the order in which the features should be planned and implemented, based on dependencies. **The ETL Data Loader must be implemented first**, as all other features optionally depend on it.

## Hard constraints

- Do not modify any source code in `src/`.
- Do not run `/speckit.plan` or any later commands.
- Do not invent product requirements that are not present in `ranking-system-spec-context.md`. If you think something is missing, mark it as `[NEEDS CLARIFICATION]` and surface it in the summary.
- The spec-context's Open Questions section (§17) lists unresolved items. Each one must appear in the appropriate feature spec as a `[NEEDS CLARIFICATION]` marker, not silently resolved.
- Every feature that consumes ETL data must specify defensive behavior: the app must function (with degraded quality) when any or all ETL data is missing.
