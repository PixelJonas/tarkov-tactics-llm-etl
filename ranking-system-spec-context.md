# Tarkov Tactics Ranking System — Specification Context

**Purpose.** This document specifies the behavior and structure of the ranking system that turns a player's progression state plus a selected `(Goal, Vibe)` combination into a Next Raid recommendation. It is implementation-agnostic: it defines what the system must do, not how to build it.

**Audience.** Spec writers feeding the document into a spec-driven development workflow, and developers reading the wiki for context.

**Scope.** Requirement Impact scoring, Item Priority scoring, POI aggregation, Map scoring, the Key Economics Module, the Named POI Layer, the Loot Probability data source, LLM integration boundaries, ranking-to-loadout interface, and caching/explainability requirements.

---

## 1. Purpose

The Tarkov Tactics app translates a player's TarkovTracker progression state and selected `(Goal, Vibe)` into a concrete Next Raid dashboard: a recommended map, a route of POIs, an item watchlist, a loadout suggestion, and risk indicators.

The ranking system is the engine that produces this output. It must:

- Score every open requirement (quest, hideout level, item need, skill, level, currency) by its impact on the active goal.
- Roll up requirement scores to item priorities.
- Aggregate item priorities and objective values into per-POI scores per map.
- Score each candidate map by the best achievable route through its POIs within the raid time budget.
- Pass the chosen map's route, item watchlist, and active quest constraints to the loadout engine.

The system must be deterministic, explainable, configurable, and tunable.

---

## 2. Design Principles

1. **Determinism.** The same inputs must produce the same outputs. Scores must be cacheable, reproducible, debuggable, and testable. Any randomness used for tie-breaking must be seeded by a value exposed in configuration.
2. **Normalized and weighted, not fixed-point.** Every scoring component must produce a value in `[0, 1]`. Component combination must use named weights drawn from a single configuration source. There must be no hardcoded point ranges.
3. **Composability.** Goals, Vibes, and downstream consumers (Loadout) must be independently extensible. Adding a new Goal must require only a new goal-relevance function over requirements; downstream stages must not need modification.
4. **Graceful degradation.** Missing or unavailable data must collapse cleanly to a defined neutral value without breaking the pipeline.
5. **LLM is optional and additive, never required.** The system must operate fully without language-model access. When LLM access is configured by the user, the system may use it for the qualitative capabilities enumerated in §10. Each such use must have a defined deterministic fallback that produces a usable (if less polished) result without LLM access. Numerical scoring, clustering, and route optimization must be rule-based regardless of LLM availability.

---

## 3. Domain Vocabulary

These terms extend the vocabulary defined in the wiki's _Goals System_ and _Core Concepts_ pages.

**Goal.** A long-term progression target (Prestige 1–6, Kappa, Story Endings, Lightkeeper). A Goal is a set of Requirements that must all be satisfied for the Goal to complete.

**Requirement.** A unit of progress. Types: quest completion, quest objective, hideout station level, skill level, item turn-in, PMC level, currency total. A Requirement may have prerequisites and may itself unlock other Requirements — these relationships form a directed acyclic graph (the _Requirement DAG_).

**Vibe.** A short-term player intent for the next raid: Loot Run, PvP/Mixed, or Boss Rush. The Vibe modulates downstream scoring (intrinsic value weight, risk tolerance, map preference, loadout budget allocation).

**Player State.** All data about the player's current progression: completed quests, hideout levels, trader loyalty levels, player level, prestige history, inferred key ownership, and manual inputs (skill levels, currency).

**Item.** A game item with metadata (size, price, types, flea-market level requirement, durability where applicable). An item may be required by zero or more Requirements.

**POI Cluster.** A spatially coherent group of loot containers, quest objective positions, and boss spawn points on a single map. Each cluster has a centroid, a human-recognizable name where available, and a set of access requirements (keys, level gates).

**Route.** An ordered sequence of POI Clusters from a player spawn point to an extract, selected to maximize collected value within the raid time budget.

**Map.** A game location with a bounded raid duration, defined extracts, defined spawns, hostile NPC and boss populations, and a set of POI Clusters.

---

## 4. Pipeline Overview

The ranking system is a four-stage pipeline executed top-down on each dashboard request, with extensive caching between stages.

```
Player State + Game Data + Goal + Vibe
            │
            ▼
Stage 0: Open Requirements set (goal-conditional)
            │
            ▼
Stage 1: Requirement Impact Score R(r) for each open requirement
            │
            ▼
Stage 2: Item Priority Score I(i) — rolled up from R(r)
            │
            ▼
Stage 3: POI Cluster Score P(c) — per cluster per map
            │
            ▼
Stage 4: Map Score M(m) — aggregating P(c) across the optimal route
            │
            ▼
Ranking Output → Loadout Engine, Dashboard, LLM rationale layer
```

Each stage's output must be cacheable independently. Cache invalidation rules are specified in §12.

---

## 5. Stage 0 — Open Requirements

Before any ranking can occur, the system must compute the _open requirement set_ for the active Goal.

A requirement is _open_ if:

- Its status from TarkovTracker (or equivalent source) is not "satisfied" or "failed", AND
- Its definition is known (the requirement is defined in static game data or a derived requirement set).

Each open requirement must additionally be classified by _availability_:

- **Available.** All prerequisites are satisfied. The player can start work on it now.
- **Locked.** At least one prerequisite is open. The player cannot start it yet.

Both available and locked requirements remain in the open set. Locked requirements still propagate value through the DAG to their prerequisites in Stage 1.

---

## 6. Stage 1 — Requirement Impact Score R(r)

For each open requirement r, the system must compute a scalar `R(r) ∈ [0, 1]` representing the requirement's importance to advancing the active Goal.

### 6.1 Score components

`R(r)` is a weighted sum of normalized components, each producing a value in `[0, 1]`:

| Component                                   | Meaning                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `D(r)` — Direct contribution                | Does `r` directly satisfy a top-level Goal requirement?                      |
| `G(r)` — Gating value                       | How many goal-relevant requirements does `r` unblock downstream?             |
| `B(r)` — Bottleneck factor                  | Is `r` on the critical path? Reduces if alternative paths exist.             |
| `T(r)` — Trader-level pressure              | Does `r` advance a trader loyalty level that gates many future requirements? |
| `P_passive(r)` — Passive-quest unlock value | Does `r` unblock quests that progress in the background? See §6.4.           |

`R(r)` is multiplied by two gate factors:

- `A(r) ∈ [0, 1]`: availability dampener (1.0 if available; smaller for requirements deeper in the locked DAG).
- `K(r) ∈ [0, 1]`: key-block penalty (near zero if the requirement is geographically gated by an unobtainable key).

### 6.2 Component combination

```
R(r) = (w_D · D + w_G · G + w_B · B + w_T · T + w_P · P_passive) · A · K
```

Weights `w_*` must be defined in configuration. Their sum across components must equal 1.0 such that `R(r)` lies in `[0, 1]` when all components are at their maximum.

### 6.3 Gating value G(r)

`G(r)` measures the goal-relevant value of all requirements reachable from `r` in the unlock direction, with exponential decay by hop distance.

Conceptually:

```
G(r) = goal_contribution(r) + DECAY · Σ over r' in unlocks(r): G(r')
```

Where the sum excludes already-satisfied descendants, and `DECAY ∈ (0, 1)` is a configuration parameter.

After computing for all open requirements, `G` must be normalized so the maximum across the open set equals 1.

This is the central mechanism by which "items needed for next month's quest" get appropriately less weight than "items needed to unlock my next quest."

### 6.4 Passive-quest unlock value P_passive(r)

A quest is _passive_ to the extent it progresses without dedicated player effort. `P_passive(r)` measures the passive-progress opportunity that `r` unlocks downstream — the _background-progress accelerator_ effect of unlocking the right quest early.

#### 6.4.1 Per-objective passiveness

Each quest objective has a _base passiveness_ determined by its type, multiplied by _penalty factors_ for each constraint axis that narrows the scenarios in which the objective can progress.

The base value spans a spectrum:

- **High (≈ 1.0):** objectives that progress during any play (e.g., gain experience, accumulate trader rep, reach a player level).
- **Medium (≈ 0.5–0.8):** kill objectives, skill objectives.
- **Low (≈ 0.3):** extract-specific objectives.
- **Zero (0.0):** fully active objectives (e.g., Found-in-Raid item handover, place a marker, use a specific item, build a weapon).

A _constraint multiplier_ in `(0, 1]` is applied for each non-empty constraint field on the objective. The constraint axes the system must recognize are:

- Map restriction (objective limited to specific maps).
- Zone restriction (within a named zone on a map).
- Body-part restriction (e.g., headshots only).
- Weapon restriction by specific item.
- Weapon restriction by weapon class.
- Weapon mod requirement.
- Equipment-worn requirement.
- Equipment-not-worn requirement.
- Distance restriction.
- Time-of-day restriction.
- Shot-type restriction (e.g., headshot).
- Health-state restriction (player or enemy).
- Required-key restriction.

Per-objective passiveness equals the base value times the product of all applied constraint multipliers.

**All base values and all constraint multipliers must be exposed as named configuration parameters.** The system must not contain hardcoded values for these.

#### 6.4.2 Per-quest aggregation

A quest's overall passiveness is the **minimum** of its objectives' passiveness values.

Rationale: a quest only completes when all its objectives complete; the least-passive objective is the bottleneck. A quest with one passive objective and one active objective is not half-passive — it is fully gated by the active objective.

#### 6.4.3 Propagation to prerequisites

`P_passive(r)` for a requirement `r` is computed by traversing the requirements `r` unlocks recursively:

```
P_passive(r) = Σ over r' in unlocks(r) that are open:
                  quest_passiveness(r') + DECAY · P_passive(r')
```

The result must be normalized across the open requirement set.

#### 6.4.4 Acceptance examples

Given a representative constraint-multiplier configuration, the following quest-passiveness values must be approximately reproducible. Implementers may treat these as acceptance test cases (exact values depend on final configuration; ordering and rough magnitude must hold):

| Quest description                                                                    | Expected passiveness (rough) |
| ------------------------------------------------------------------------------------ | ---------------------------- |
| "Kill 5 PMCs in Lighthouse with M4 platform from 50m+" (four constraint axes active) | Very low (< 0.10)            |
| "Kill 5 PMCs as Scav" (no constraints, any map)                                      | High (≈ 0.8)                 |
| "Reach trader standing 0.20" (passive type, no constraints)                          | High (≈ 0.9)                 |
| "Deliver USB to Mechanic" (fully active type)                                        | Zero                         |

### 6.5 Bottleneck factor B(r)

`B(r)` measures whether `r` is on a critical path to goal completion (no alternative routes exist). `B(r) ∈ [0, 1]` where 1 means `r` is the sole path to some goal-required descendant.

The system must not block on `B(r)`. For MVP, `w_B` may be zero — `G(r)` captures most of this signal in practice. A future iteration may compute `B(r)` via min-cut analysis on the DAG.

### 6.6 Direct contribution D(r) and Trader pressure T(r)

`D(r)` is 1.0 if `r` is itself a top-level requirement of the active Goal, 0 otherwise.

`T(r)` is the normalized share of remaining trader loyalty levels for trader(s) that `r` advances, weighted by the count of goal-relevant items or quests gated behind those loyalty levels.

For MVP, `w_T` may be zero.

---

## 7. Stage 2 — Item Priority Score I(i)

For each item `i` in the game's item catalog, the system must compute `I(i) ∈ [0, 1]` representing the item's importance to the player's progression.

### 7.1 Roll-up formula

```
I(i) = Σ over open requirements r:  R(r) · need(r, i)   +   λ_V · V(i)
```

Where:

- `need(r, i)` is the share of `r`'s requirement for `i` still unmet: units still required divided by total units required. Zero if `i` does not satisfy `r`.
- `V(i)` is the intrinsic flea-market value of `i`, expressed as price-per-slot normalized against the maximum price-per-slot in the current item catalog.
- `λ_V` is a vibe-modulated weight: higher for Loot Run (rouble efficiency matters), lower for PvP/Mixed and Boss Rush (goal progress dominates). All vibe-specific values for `λ_V` must be configuration parameters.

After roll-up, `I` must be normalized across the catalog so the maximum equals 1.

### 7.2 Found-in-Raid handling

Items required Found-in-Raid (FIR) for a quest cannot be substituted with flea-bought copies. The system must explicitly track the FIR flag per `(requirement, item)` link. For FIR-only links, the player's flea-purchase capacity does not reduce `need`.

### 7.3 Stash inventory blind spot

Until stash inventory data becomes available, `need(r, i)` reflects only the items still required by external progression tracking, not the items the player has acquired but not yet turned in. The system must surface this limitation in the user interface so users understand the score's basis.

---

## 8. Stage 3 — POI Aggregation

### 8.1 POI cluster generation

The system must generate POI clusters per map by spatially grouping:

- Loot container positions.
- Loose-loot spawn positions.
- Quest objective positions (from objective `positions` fields or inferred from named zones).
- Boss spawn locations.

Grouping must use a spatial-proximity-based clustering approach with two configurable parameters:

- A _proximity threshold_ (the maximum distance between two points to be grouped together).
- A _minimum cluster size_ (lone high-value points such as a single boss spawn must be retained as their own cluster).

POI clusters must be generated once per game-data version and cached. Re-generation must be triggered when the upstream map data changes.

### 8.2 POI score P(c)

`P(c)` is the sum of expected goal-progress gains at cluster `c`, less the cost to access it, all modulated by extract proximity.

```
P(c) = ( E[loot_gain(c)]
       + E[objective_gain(c)]
       + E[boss_gain(c)]
       − λ_K · key_cost_amortized(c, player)
       ) · extract_proximity(c)
```

Where:

- **`E[loot_gain(c)]`** = sum over containers in `c`, sum over items: `spawn_probability(item, container) · I(item)`. Spawn probabilities are sourced per §8.4.
- **`E[objective_gain(c)]`** = sum over quest objectives whose position lies in `c`: `R(parent_quest) · completion_probability`. For most objectives the probability is 1; for stochastic objectives (e.g., "survive a raid") it is less.
- **`E[boss_gain(c)]`** = sum over boss spawn points in `c`: `spawn_chance · boss_value`. Boss value is a roll-up of boss-unique drops priced via `I(i)` plus any active boss-kill objectives.
- **`key_cost_amortized(c, player)`** — see §8.3.
- **`extract_proximity(c)`** — distance from cluster centroid to the nearest reliable extract, normalized; closer to extract scores higher.

`P(c)` must be normalized per map: `P(c) / max P(c') over c' in m`. This prevents maps with many POIs from inflating relative to maps with few but high-value POIs.

### 8.3 Key Economics Module

Keys are modeled as purchasable consumables with amortized per-raid cost. This eliminates the need for the player to manually maintain a key inventory.

#### 8.3.1 Required data

For each key item, the system must access:

- The key's per-item flea-market level requirement.
- A flag indicating whether the key is flea-tradeable at all.
- All available purchase paths and their prices (flea-market and per-trader, each with its loyalty-level requirement).
- The key's durability (some keys have finite uses; many have effectively infinite uses).
- For each map: which locked doors require which keys, with positions.

#### 8.3.2 Effective key cost

For a key `k` and a player state, the effective acquisition cost is the **minimum** price across all _available_ purchase paths:

- The flea-market path is available if (a) the key is flea-tradeable, AND (b) the player's PMC level meets the key's flea-market level requirement.
- A trader path is available if the player's loyalty level at that trader meets the requirement for that purchase.
- If no path is available, the key cost is **unobtainable** (treated as infinite in scoring).

#### 8.3.3 Per-raid amortization

The system must amortize key cost over expected usage:

- For keys with a finite use count: `cost / uses`.
- For keys with effectively infinite uses: `cost / AMORT_DEFAULT`, where `AMORT_DEFAULT` is a configuration parameter representing the amortization horizon in raids.

The system must not assume keys are lost between raids: in the game, key items are stored in the Secure Container, which survives player death. The amortization horizon therefore reflects opportunity cost and time-to-value, not literal loss risk.

#### 8.3.4 POI access with degraded sub-clusters

When a cluster `c` contains containers behind a lock whose key is unobtainable for the current player, the system must split `c` into:

- An **accessible sub-cluster** (containers reachable without the unobtainable lock) — used for scoring.
- A **locked sub-cluster** (containers behind the unobtainable lock) — excluded from scoring and surfaced in the user interface as "locked area: key unobtainable."

The player must not be penalized in scoring for inaccessible loot they were never going to reach.

#### 8.3.5 Quest-locked keys

Some keys have no purchase path (they are only obtainable as quest rewards). For these, the system must infer ownership: if the quest that rewards the key is marked complete in TarkovTracker, assume the player holds the key. This default is imperfect (the player may have lost the key after acquiring it) but is acceptable for MVP.

#### 8.3.6 Loadout integration

The amortized key cost for the chosen route's POIs must be added to the loadout total cost line item. The user must be able to see the breakdown so the rouble math is honest: a "lucrative" run where the key amortization eats half the expected return must be visible.

### 8.4 Loot probability data sourcing

Per-container item spawn probabilities are not directly exposed by the primary game-data API. The system must source this data externally.

**Source.** The Single Player Tarkov (SPT) community publishes datamined per-container loot distributions as open-source data, regularly updated per game patch. This is the recommended source.

**ETL requirements.** The system must include an offline extract/transform/load process that:

- Reads SPT per-location loot data.
- Normalizes per-container probability distributions so they sum to 1 per container type.
- Cross-references item IDs against the primary game-data API's catalog.
- Outputs a static lookup table keyed by `(map, container type, item)` → probability, plus a confidence flag per row.

The serving path must read from the produced table only. The ETL must not run at request time.

**Fallback prior.** Where SPT data is absent for some container type, the system must use a uniform prior: `1 / (count of unique items in that container type)`. The confidence flag must be marked accordingly.

**LLM assistance.** A language model may assist the ETL by diff-and-validate passes between patches (resolving renamed items and restructured container categories). LLM use here is offline and human-reviewable.

**Data-licensing note.** The SPT data is derived from game files; community convention treats this as acceptable for analytic tooling. Implementations intended for commercial use must obtain a separate licensing opinion.

### 8.5 Named POI Layer

POI clusters must be presented to the user with human-recognizable names ("Dorms", "Marked Room", "Gas Station") rather than generated identifiers.

**Source hierarchy** (each tried in order):

1. **Primary game-data API:** for spawns, extracts, switches, and named map positions, use the names exposed by the API directly.
2. **Community iconic-location labels:** an open-source label set associating names with positions and vertical-layer ranges. Multi-floor maps must disambiguate floors correctly using the layer information.
3. **One-shot generated description (optional):** if LLM access is configured, the system may produce a one-shot description from surrounding landmarks. Results must be cached for the lifetime of the cluster. If LLM access is not configured, this step is skipped.
4. **Synthetic identifier:** a generated identifier (e.g., `customs-cluster-7`) is the final fallback and the default when LLM access is not available.

**Quest-text matching.** Quest objective descriptions reference named locations directly (e.g., "in the Dorms area on Customs"). The named POI layer must enable matching quest objectives to clusters by name as an alternative to coordinate matching. This is more robust to map-data updates.

---

## 9. Stage 4 — Map Scoring with Distance and Time Budget

### 9.1 Spawn clusters and the per-spawn routing model

The player's exact spawn point within a map is not known in advance. Each map has multiple PMC spawn zones, and assignment to a spawn is randomized at raid start.

The system must therefore not produce a single route per map. Instead, for each candidate map:

1. **Filter spawns to PMC player spawns.** From the primary game-data API's `Map.spawns` collection, retain only entries where `sides` contains `"Pmc"` AND `categories` contains `"Player"`. (Note: `sides` identifies the faction allowed at the spawn — `"Pmc"`, `"Savage"`, `"Boss"`, `"All"` — _not_ a physical region of the map. `categories` identifies the role — `"Player"`, `"Bot"`, `"Boss"`, `"Group"`. Neither field exposes the in-game "physical side" / entry-point concept.)
2. **Cluster the filtered spawns spatially** with a proximity threshold. The threshold must be tunable per map: small maps (e.g., Factory) yield one cluster regardless; large maps (e.g., Streets) need a larger threshold to avoid over-splitting.
3. **Constrain cluster count.** The system must enforce a minimum of 1 and a maximum of N clusters per map, where N is a configuration parameter (default 4). If clustering produces more than N clusters, the system must merge the two closest clusters repeatedly until N is reached. The `zoneName` field (from the in-game `BotZoneName`) may serve as a secondary signal to prefer keeping same-zone spawns in the same cluster.
4. **Compute one route per cluster.** Treat each cluster's centroid as the route origin and run route construction (§9.2–§9.4) independently.
5. **Aggregate route scores into a single map score** per §9.5, with dispersion penalty applied.
6. **Output all candidate routes** to the user. After the raid begins and the player observes their actual spawn, they pick the matching route (§11).

Spawn-cluster generation must happen once per game-data version and be cached, parallel to POI cluster generation (§8.1).

**Rationale for the cluster-count cap.** BSG places PMC player spawns in physically tight groups by design — each "side" of a map (e.g., "old gas" vs "boiler" on Customs) contains a handful of spawn points within tens of meters, separated from other sides by hundreds of meters. A purely spatial clustering with a reasonable threshold therefore naturally produces a small number of broad clusters per map (typically 1–4). The cap protects against pathological cases where threshold tuning produces too many clusters.

### 9.2 The route optimization problem

A raid has a fixed time budget. From a given spawn cluster, the player can visit only a subset of POIs and must reach an extract. The system must select, per spawn cluster, the subset and order of POIs that maximizes total collected value within the budget.

This is a _prize-collecting routing problem with a time/distance budget_. The system must not be required to solve it optimally; a heuristic (e.g., greedy insertion ordered by POI score, optionally refined by local search) is acceptable, provided the result respects the budget and the configured maximum POI count per route.

The maximum POIs per route must be a configuration parameter.

### 9.3 Time and distance budget

The available time per raid is the map's raid duration minus a _safety margin_ (for extracting) minus a _vibe-dependent combat-time estimate_.

The available distance budget is the time budget times an _effective movement speed_, minus the time spent looting containers along the route.

The budget is the same across all spawn clusters on a given map — only the spawn origin (and therefore reachable POI set) changes per cluster.

All these factors must be exposed as configuration parameters.

### 9.4 Per-route score

For a given map `m` and spawn cluster `s`, the route from `s` produces a score:

```
score(m, s) = Σ over c in route(m, s):  P(c) · distance_decay(c, s)
              · vibe_modifier(m, vibe)
              · risk_modifier(m, vibe)
              − travel_cost(route(m, s))
```

- **`distance_decay(c, s)`** — discounts POIs deeper into the route from spawn cluster `s` to reflect increasing probability the player dies before reaching them. Monotonically non-increasing with cumulative distance from `s`; the specific rate is a configuration parameter.
- **`vibe_modifier(m, vibe)`** — per-vibe adjustments based on map characteristics:
  - Loot Run: bonus for low goon-spawn probability and low PMC density.
  - PvP/Mixed: bonus for high objective density.
  - Boss Rush: bonus proportional to target boss spawn probability; zero if the target boss does not spawn on this map.
- **`risk_modifier(m, vibe)`** — reduces score for maps that conflict with the chosen vibe's risk tolerance.
- **`travel_cost(route)`** — a penalty proportional to total route distance, capturing the opportunity cost of pure travel.

### 9.5 Map score aggregation across spawn clusters

The map's overall score combines its per-spawn-cluster route scores plus the map-level constraint bonus:

```
M(m) = aggregate_over_spawns({ score(m, s) | s ∈ spawn_clusters(m) })
       + m_constraint_bonus(m, player, vibe)
```

The aggregation function must penalize **route-quality dispersion**: a map where only one of four spawn clusters yields a good route should score lower than a map where all four yield consistently usable routes, because the player has only a 25 % chance of getting the good spawn. This protects the principle that the chosen map should give the player a reasonable chance of making the proposed progress regardless of which spawn they land in.

The aggregation function must be configurable. Supported strategies:

- **`mean_x_above_threshold`** (default): `mean(scores) × (count of scores ≥ Q) / (count of scores)`, where `Q` is a configurable quality threshold. Directly interpretable as "what fraction of spawns yield a usable raid?" times "how good is that raid on average?". A map with 1/4 routes above threshold loses 75 % of its mean score; a map with 4/4 above threshold keeps it in full.
- **`mean_minus_k_stdev`**: `mean(scores) − k · stdev(scores)`, where `k` is a configurable risk-aversion coefficient. Classical risk-adjusted aggregation; higher `k` penalizes variance more aggressively. Equivalent to a Sharpe-style penalty.
- **`mean`**: pure expected value, no dispersion penalty. Available for diagnostic or A/B-test purposes.
- **`min`**: worst-case route value. Most conservative.
- **`max`**: best-case route value. Optimistic; surfaces a map's ceiling without regard to consistency.
- **`weighted`**: probability-weighted mean. Requires per-spawn-cluster probability data, which is not currently available from the data sources in §14.

`m_constraint_bonus(m, player, vibe)` is computed per §9.6 and is map-level, not spawn-cluster-level — it depends only on the player's active quests and the map's identity, not on which spawn the player gets.

The chosen map is the one with the maximum `M(m)` across candidate maps. Ties may be broken by a deterministic seeded mechanism, or by the optional LLM tie-breaker (§10) if configured.

### 9.6 Active constrained-quest map bonus

When a player has an active quest whose objectives are heavily constrained (low passiveness from §6.4), deliberately picking that quest's required map is high-value: the quest cannot progress meaningfully elsewhere.

```
m_constraint_bonus(m, player, vibe) =
  Σ over r in player's active open quests with m ∈ r.required_maps:
       R(r) · (1 − quest_passiveness(r)) · loadout_feasibility(r, vibe)
```

Where `loadout_feasibility ∈ [0, 1]` reports whether the vibe's loadout budget can satisfy `r`'s weapon, armor, and equipment constraints. It is computed by the loadout engine on demand (see §11).

The factor `(1 − passiveness)` is the key: passive quests need no map bonus (they progress anywhere), while heavily constrained quests get a large bonus for picking the right map.

This is symmetric to §6.4's passive-prerequisite boost: passive quests reward early unlock; constrained quests reward deliberate map choice.

### 9.7 Loadout-feasibility loop

Because `m_constraint_bonus` depends on `loadout_feasibility`, map scoring has a soft dependency on the loadout engine.

For MVP, the system must execute a single pass: assume `loadout_feasibility = 1.0` during map scoring. After the map is chosen and the loadout engine runs, if the loadout engine reports infeasibility for some active quest, the system must drop that quest's contribution. If the next-best map's score is within a configured tolerance (e.g., 10%) of the chosen map, the system must re-rank and report which map was chosen and why.

In practice, this resolves quickly: most quest constraints are satisfiable within standard vibe budgets.

### 9.8 Distance metric

Cluster positions and travel distances must be computed in the game's world coordinate system (top-down 2D, meters). Elevation and walls are ignored for MVP. If route accuracy proves insufficient, the system may later integrate per-map walkable-graph data; the data source is currently unspecified.

---

## 10. LLM Integration Boundaries

Language-model inference is an **optional enhancement layer**. The system must function without it. When the user provides LLM access (model endpoint, credentials, and configuration), the system may use it for the capabilities below; for each capability, a deterministic fallback must be implemented and used when LLM access is not configured or fails at runtime.

| Capability                                     | When LLM access is configured                                                                                                                       | Deterministic fallback                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard narrative ("Why this map?")          | Generate prose explanation per dashboard request from the structured scoring inputs. Cacheable by inputs hash.                                      | Render the structured reason output from §12.2 directly: component values, weights, and top contributors as labeled rows. No prose wrapper.                                                          |
| Per-POI tour-guide notes                       | Bundled with the dashboard narrative call.                                                                                                          | Omit narrative; show structured POI metadata (name, access requirements, expected items, route order).                                                                                               |
| Offline quest-text parsing for new content     | Batch process to extract coordinates and target zones from quest descriptions when structured data is missing. Output is committed to the codebase. | Use only the structured tarkov.dev fields. Quests with missing structured data degrade gracefully: their objectives contribute zero to POI matching by location and rely on map-level matching only. |
| One-shot cluster naming for unlabeled clusters | Generate a description from surrounding landmarks. Cached for the cluster's lifetime.                                                               | Use the synthetic identifier (e.g., `customs-cluster-7`).                                                                                                                                            |
| ETL diff-and-validate between game patches     | Assist human review of changes between source data versions.                                                                                        | Manual human review only.                                                                                                                                                                            |
| Tie-breaking between equally-scored maps       | Optional qualitative tie-break.                                                                                                                     | Deterministic tie-break by a seeded, stable ordering (e.g., normalized map name).                                                                                                                    |

The system must **not** use language-model inference for any numerical scoring component, spatial clustering, route optimization, or graph traversal, regardless of LLM availability. These must always be deterministic algorithms with verifiable, testable behavior.

### 10.1 Configuration of LLM access

The system must expose configuration for:

- Whether LLM access is enabled.
- The model provider and endpoint (if enabled).
- Per-capability toggles (a user may want narrative on but tie-breaking off).
- Per-capability model selection (a small/cheap model may suffice for some capabilities; others may need a larger model).

When LLM access is configured but a request fails at runtime (timeout, rate limit, error), the system must transparently use the deterministic fallback for that request without surfacing the failure as a hard error to the user. A single inline indicator that fallback was used is acceptable.

---

## 11. Ranking Output → Loadout Engine Interface

The ranking system's output to the loadout engine must include:

- **Map identifier** of the chosen map.
- **Candidate routes**, one per spawn cluster of the chosen map. Each route includes its spawn cluster identifier, its spawn centroid position (for the user's "which spawn am I at" decision), the ordered POIs, each POI's name, accessibility requirements (keys), constituent objectives, constituent containers, and the route's score from §9.4. Routes must be presented in a stable order (e.g., by spawn cluster identifier) so the user interface can render them deterministically.
- **Item watchlist**, derived from the items most likely to appear across the candidate routes' POIs, ordered by `I(i)`. The watchlist is map-level, not per-route — items the player should keep an eye out for regardless of which spawn they land in.
- **Active quest constraints**: for each active open quest applicable to the chosen map, a constraint payload covering all constraint axes from §6.4.1 plus the quest's priority `R(r)` and passiveness score. These constraints are map-level — independent of spawn.

The loadout engine treats the constraint payload as a constraint satisfaction problem with priorities: it must maximize the sum of `R(r)` across satisfied quests, subject to the vibe budget. Conflicts (e.g., one quest requires an M4 platform, another requires an AK platform) must be resolved by priority: the higher-`R` quest's constraints take precedence, and the lower-`R` quest contributes zero to that raid's progress.

Such conflicts must be surfaced to the user as part of the dashboard reasoning.

The ranking-to-loadout interface is intentionally thin: ranking owns _what to satisfy_ (constraints + priorities); loadout owns _how to satisfy_ (specific gear selection within budget). The loadout engine's internal design is out of scope for this document.

### 11.1 User route selection after spawn

The user interface must allow the player to view all candidate routes for the chosen map before the raid starts and to select the route matching their actual spawn after the raid begins. The selection mechanism (manual choice from a list, or automatic detection if spawn position can be inferred from the game client) is a user-interface concern outside this document's scope.

---

## 12. Caching, Determinism, Explainability

### 12.1 Cache layers

The system must cache results at the following layers with the indicated invalidation triggers:

| Layer                                     | Contents                                    | Invalidation                                        |
| ----------------------------------------- | ------------------------------------------- | --------------------------------------------------- |
| Static game data                          | Item, map, quest, loot, lock definitions    | Time-based (e.g., 24h)                              |
| Player progress                           | Player-state snapshot                       | Manual or user-initiated sync                       |
| POI clusters per map                      | Output of Stage 3 cluster generation        | Per game-data version                               |
| Spawn clusters per map                    | Output of §9.1 PMC spawn clustering         | Per game-data version                               |
| Requirement DAG per goal                  | Output of Stage 0 plus structural goal data | Per wipe or goal change                             |
| Per-requirement and per-item scores       | Outputs of Stages 1 and 2                   | When player progress or active goal changes         |
| Candidate routes per (map, spawn cluster) | Output of Stage 4 routing                   | When POI scores change or game-data version changes |
| Dashboard narrative (LLM, optional)       | Generated text per scoring inputs           | Content-addressed by inputs hash                    |

### 12.2 Explainability

Every score surfaced in the user interface must be accompanied by a _reason_ structure containing:

- The final score value.
- The list of components that contributed, each with its raw value and applied weight.
- A small ranked list of top contributing requirements or items.

This structure must be made available through a "Why this score?" affordance in the user interface. Reason data is critical for user trust and for developer debugging.

### 12.3 Determinism

The system must produce identical outputs for identical inputs (game data version, player state, goal, vibe, configuration). Any non-determinism (e.g., random tie-breaking) must be controlled by a seed exposed in configuration.

---

## 13. Configuration Requirements

The system must expose a single configuration source containing at least:

**Weights** (subject to sum-to-one constraints where indicated):

- Component weights for `R(r)`: `w_D`, `w_G`, `w_B`, `w_T`, `w_P` (sum to 1).
- Vibe-modulated intrinsic-value weight `λ_V` per vibe.
- Key-cost weight `λ_K` in `P(c)`.

**Decay and budget parameters:**

- DAG propagation decay (used in `G` and `P_passive`).
- Distance decay rate in `M(m)`.
- Travel cost coefficient.
- Per-vibe combat-time estimates.
- Per-vibe budget allocation percentages (weapon / armor / equipment).
- Effective player movement speed.
- Time per container looting.
- Safety margin for extract.
- Maximum POIs per route (`K_MAX`).
- Key amortization horizon for effectively-infinite-use keys.

**Passiveness parameters:**

- Base passiveness value per quest-objective type.
- Constraint multiplier per constraint axis (all axes from §6.4.1).

**Spatial clustering parameters:**

- POI proximity threshold and minimum POI cluster size.
- Spawn cluster proximity threshold, with per-map overrides (small and large maps need different values).
- Maximum spawn cluster count per map (default 4) and minimum (1).

**Spawn-cluster aggregation:**

- Aggregation strategy per §9.5: one of `mean_x_above_threshold` (default), `mean_minus_k_stdev`, `mean`, `min`, `max`, `weighted`.
- Quality threshold `Q` used by `mean_x_above_threshold`.
- Risk-aversion coefficient `k` used by `mean_minus_k_stdev`.

**Tolerance and re-ranking:**

- Tolerance under which the runner-up map triggers a re-rank after loadout feasibility (§9.7).

**LLM parameters (only meaningful when LLM access is enabled):**

- LLM access enable/disable flag.
- Model provider and endpoint.
- Per-capability enable flags (narrative, tour-guide notes, cluster naming, tie-breaking).
- Model selection per capability.
- Cache key strategy.

All configuration values must be loadable from a single source. The system must not contain hardcoded values for any of the above.

---

## 14. Data Source Requirements

The system depends on the following external data:

| Source                                     | Data                                                                                                                                                                                          | Required for                             | Availability                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| Player progression tracker (TarkovTracker) | Player quest, hideout, prestige, level state                                                                                                                                                  | Stage 0                                  | Live, token-authenticated     |
| Primary game-data API (tarkov.dev)         | Quest, hideout, item, map, boss, lock, key definitions; flea prices; spawn positions (`Map.spawns`) with `sides`, `categories`, `zoneName` fields for filtering to PMC player spawns per §9.1 | Stages 1–4 incl. spawn clustering (§9.1) | Live, no auth                 |
| Community game-file data (SPT-AKI)         | Loot probability distributions per container                                                                                                                                                  | Stage 3 (loot gain)                      | Open source, batch ETL        |
| Community iconic-location labels           | Named POI layer                                                                                                                                                                               | Stage 3 (POI naming)                     | Open source, batch ingest     |
| Manual user input                          | Skill levels, currency totals (until APIs exist)                                                                                                                                              | Stages 0–1                               | UI workflow                   |
| LLM provider (optional)                    | Natural-language generation for the optional capabilities in §10                                                                                                                              | Optional enhancements                    | User-provided, off by default |

For each data source the system must:

- Cache aggressively per the layers in §12.1.
- Detect staleness based on source-specific freshness rules.
- Degrade gracefully when a source is unavailable, using cached or default values.
- Surface staleness warnings to the user when data is older than configurable thresholds.

---

## 15. MVP Scope

The MVP must implement:

- Stage 0 in full.
- Stage 1 with components `D`, `G`, `A`, `K`, and `P_passive`. Components `B` and `T` may be set to zero (skipped).
- Stage 2 in full, with the stash blind spot acknowledged in the user interface.
- Stage 3 in full: POI cluster generation, named POI layer, Key Economics Module including degraded sub-clusters, loot-probability ETL from the community game-file data source.
- Stage 4: spawn clustering per map (§9.1) with PMC+Player filter and configurable cluster-count cap (default 4); heuristic route construction per spawn cluster without local-search refinement; map score aggregation with default `mean_x_above_threshold` dispersion-penalty strategy; `m_constraint_bonus` included with single-pass `loadout_feasibility = 1.0`.
- Ranking-to-loadout interface (§11) returning candidate routes per spawn cluster plus map-level constraint payloads.
- All caching layers and reason structures from §12.

LLM-driven capabilities are **not required** for MVP. The system must ship and be useful without any LLM access configured, using the deterministic fallbacks from §10. If LLM access is added later, the system must consume it through the configuration interface in §13 without code changes elsewhere.

The MVP must explicitly **defer**:

- Goals other than Prestige 1–6 (Kappa, Story Endings, Lightkeeper).
- Stash inventory integration (depends on external data-source research).
- Multi-goal or weighted-goal combinations.
- Per-user weight calibration (requires stash data and outcome logging).
- Local-search route refinement.
- Bidirectional ranking↔loadout iteration beyond the single-pass + re-rank loop in §9.7.
- Probability-weighted spawn aggregation (`weighted` strategy in §9.5) until per-spawn-cluster probability data becomes available.

---

## 16. Design Decisions Log

These are decisions made during specification design that an implementer must respect or explicitly revisit.

| Decision                                                             | Rationale                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalize all components to `[0, 1]` with named weights              | Tunable; replaces fixed point ranges from earlier baseline.                                                                                                                                                                                              |
| Quest passiveness is `min` over objectives                           | A quest only completes when all objectives complete; bottleneck objective dominates.                                                                                                                                                                     |
| Keys modeled as purchasable consumables with amortized cost          | Eliminates need for manual key inventory; surfaces honest economics.                                                                                                                                                                                     |
| Default amortization horizon = 20 raids                              | Keys survive death via the Secure Container; loss risk is effectively zero.                                                                                                                                                                              |
| `K_MAX` = 5 from initial release                                     | Player target; configurable for future iterations.                                                                                                                                                                                                       |
| LLM excluded from numerical scoring                                  | Determinism and cacheability requirements.                                                                                                                                                                                                               |
| **LLM is optional, never required for MVP**                          | Nothing of the sort is currently implemented in the app; the system must ship and be useful without LLM access. Every LLM capability has a deterministic fallback (§10).                                                                                 |
| Single-pass loadout feasibility for MVP                              | Two-way dependency exists; most cases satisfy with feasibility = 1.0.                                                                                                                                                                                    |
| Stash data absent → static weights only                              | Per-user calibration requires outcome data.                                                                                                                                                                                                              |
| Community game-file data (SPT) as loot-table source                  | Highest data quality; established ecosystem practice.                                                                                                                                                                                                    |
| 2D Euclidean distance for routing                                    | Adequate accuracy for MVP; walkable graphs deferred.                                                                                                                                                                                                     |
| Active constrained quests boost map scores (`m_constraint_bonus`)    | Constrained quests cannot progress passively; deliberate map choice is the only path.                                                                                                                                                                    |
| **Routes are computed per spawn cluster, not per map**               | Exact spawn point is not known in advance. Player picks the matching route after observing their spawn.                                                                                                                                                  |
| **Spawn filter: `sides ∋ "Pmc"` AND `categories ∋ "Player"`**        | `sides` is faction, not physical region. `categories` is role. The tarkov.dev API does not expose BSG's `Infiltration` field (the true "physical side"), so spatial clustering does the work of grouping spawns into physical regions.                   |
| **Spawn cluster count capped at 4 by default**                       | BSG places PMC spawns in 1–4 physically tight groups per map by design. Cap protects against pathological clustering output.                                                                                                                             |
| **Default map score aggregation penalizes route-quality dispersion** | The chosen map should give the player a reasonable chance of making the proposed progress regardless of which spawn they land in. `mean_x_above_threshold` is more interpretable ("what fraction of spawns yield a usable raid?") than mean-minus-stdev. |

---

## 17. Open Questions

These remain unresolved and must be addressed during planning or early implementation:

- **Passiveness base values and constraint multipliers (§6.4.1).** Initial values are placeholders. Empirical calibration against the actual quest set for the current wipe is needed.
- **Loadout engine specification (§11).** The loadout engine's internal logic (constraint satisfaction algorithm, budget allocation, item selection) is referenced by this document but not specified here. A separate specification is required.
- **Conflict-handling UX for active quests with hard-conflicting weapon requirements (§11).** The behavior of higher-`R` quest winning is defined, but the user-facing presentation is undefined.
- **Stash inventory integration (§7.3).** Depends on resolution of upstream data-extraction research (the wiki's Data Availability matrix).
- **Walkable-graph data for refined routing (§9.8).** Source and integration approach are open.
- **Spawn cluster proximity threshold defaults (§9.1).** Per-map overrides are supported. Starting values still need to be picked empirically by inspecting PMC spawn distributions across the supported maps.
- **Quality threshold `Q` and risk-aversion coefficient `k` (§9.5).** Initial values for the dispersion-penalty parameters need empirical calibration. Suggested approach: pick `Q` such that the bottom-quartile route on a typical map falls below it.
- **Spawn-cluster probability data (§9.5).** If per-spawn-cluster spawn probabilities become available (community telemetry or future BSG data), the `weighted` aggregation strategy becomes meaningful. Currently no such source is identified.
- **Route-to-spawn matching UX (§11.1).** Whether the user manually picks the matching route, or whether spawn can be inferred automatically (e.g., from in-game logs via TarkovMonitor or equivalent), is undefined.

---

_End of specification context._
