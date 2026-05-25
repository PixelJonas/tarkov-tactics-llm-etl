# Prompt for Claude Code — Generate spec-kit specifications for the Tarkov Tactics ranking system

## Context

You are working in the `tarkov-tactics/tarkov-tactics-app` repository. The repo uses GitHub's spec-kit for spec-driven development (see the `.specify/` directory).

The file `ranking-system-spec-context.md` (attached / in the working directory) is the authoritative design document for the ranking system. It is implementation-agnostic and describes the behavior the system must exhibit. Treat it as the single source of truth for **what** the ranking system does. Your job is to translate it into spec-kit feature specifications.

The wiki pages `Component-Architecture`, `Core-Concepts`, `Goals-System`, `Data-Availability`, `Tarkov-dev-API`, and `TarkovTracker-API` provide additional product context. The spec-context document already incorporates them; consult the wiki only if something in the spec-context is ambiguous.

## Phase 1 — Orient yourself before generating anything

Do **not** create or modify any spec files yet. First:

1. List the contents of `.specify/` and read its templates and scripts. Identify which slash commands are available (`/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, etc., or the equivalents for this repo's spec-kit version).
2. Read `/memory/constitution.md` if it exists. Note any project principles that constrain the ranking system's design.
3. List the contents of `specs/` (or wherever existing feature specs live). Read any existing specs that might overlap with the ranking system to avoid duplication.
4. Read `ranking-system-spec-context.md` end-to-end.
5. Report back with: a summary of the existing spec-kit setup, any existing specs you found, and any constitution principles that affect the ranking system.

## Phase 2 — Propose a feature decomposition

The ranking system is too large for one feature spec. Propose a decomposition into spec-kit features. Likely candidates (you may adjust):

1. **Requirement Impact Scoring** — Stage 1 (`R(r)`), including the Requirement DAG, gating value `G(r)`, passive-quest unlock value `P_passive(r)` with constraint decomposition, and the availability/key gates `A(r)`/`K(r)`. References §5, §6 of the spec-context.
2. **Item Priority Scoring** — Stage 2 (`I(i)`), the roll-up from requirement impact to items, with FIR handling and the stash blind spot. References §7.
3. **POI Cluster Generation and Scoring** — Stage 3 cluster generation, `P(c)` scoring with loot/objective/boss components, named POI layer. References §8.1, §8.2, §8.5.
4. **Key Economics Module** — Stage 3 sub-module: amortized key cost, degraded sub-clusters for unobtainable keys, loadout cost integration. References §8.3.
5. **Loot Probability Data ETL** — offline ingestion of community game-file data into the per-container probability table. References §8.4.
6. **Map Scoring and Route Optimization** — Stage 4 (`M(m)`), route construction within time budget, vibe and risk modifiers, active constrained-quest map bonus. References §9.
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
4. List edge cases explicitly. The spec-context surfaces many: stash data unavailable, key unobtainable, quest with no purchase path, loadout infeasibility for an active quest, runner-up map within tolerance, etc.
5. Where the spec-context explicitly identifies a configuration parameter (see §13), record it in the spec as a configurable input with a description of its purpose — but do not hardcode values into the spec.
6. Mark anything ambiguous as `[NEEDS CLARIFICATION: <question>]` rather than guessing.

After each feature spec is generated:
- Validate it against the spec-kit Specification Quality Checklist (the template generates one): no implementation details, requirements testable and unambiguous, success criteria measurable and technology-agnostic, edge cases identified, scope bounded.
- Confirm there are no leaked implementation details (search the spec for forbidden words: "DBSCAN", "PageRank", "Orienteering", "TypeScript", "Python", "GraphQL", "DAG" as an algorithmic term, any library names).

## Phase 4 — Stop and summarize

After all feature specs are generated, do **not** run `/speckit.plan`, `/speckit.tasks`, or `/speckit.implement`. Those come after I review the specs.

Produce a final summary containing:

- A table mapping each feature to its spec file path and the spec-context sections it derives from.
- Any `[NEEDS CLARIFICATION]` markers across all specs, grouped by feature.
- A recommendation of any decisions from the spec-context's Design Decisions Log (§16) that should be promoted to the project's `constitution.md` because they apply across multiple features (e.g., "all scoring components must be normalized to [0, 1]" is a cross-cutting principle).
- A recommendation of the order in which the features should be planned and implemented, based on dependencies.

## Hard constraints

- Do not modify any source code in `src/`.
- Do not run `/speckit.plan` or any later commands.
- Do not invent product requirements that are not present in `ranking-system-spec-context.md`. If you think something is missing, mark it as `[NEEDS CLARIFICATION]` and surface it in the summary.
- The spec-context's Open Questions section (§17) lists unresolved items. Each one must appear in the appropriate feature spec as a `[NEEDS CLARIFICATION]` marker, not silently resolved.
