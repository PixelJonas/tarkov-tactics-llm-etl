// Core type definitions for the ETL pipeline

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Config {
  spawn_clustering: {
    default_proximity_threshold_m: number;
    max_clusters_per_map: number;
    min_clusters_per_map: number;
    per_map_overrides: Record<string, { proximity_threshold_m: number }>;
  };
  loot_probability: {
    uniform_prior_fallback_enabled: boolean;
  };
  naming: {
    iconic_match_radius_m: number;
    layer_aware_matching: boolean;
  };
  llm: {
    enabled: boolean;
    prompt_template_path: string;
    expected_schema_path: string;
  };
  validation: {
    fail_on_unmatched_item_ids: boolean;
    fail_on_missing_iconic_labels: boolean;
    max_publish_size_mb: number;
  };
  sources: {
    spt_aki_repo: string;
    tarkov_dev_graphql: string;
    the_hideout_repo: string;
    cache_ttl_hours: number;
  };
}

// tarkov.dev API types
export interface TarkovDevItem {
  id: string;
  name: string;
  shortName: string;
  buyFor?: Array<{
    source: string;
    price: number;
    currency: string;
  }>;
  sellFor?: Array<{
    source: string;
    price: number;
    currency: string;
  }>;
}

export interface TarkovDevMap {
  id: string;
  name: string;
  spawns: Array<{
    categories: string[];
    sides: string[];
    position: Position;
  }>;
}

export interface TarkovDevTask {
  id: string;
  name: string;
  objectives: Array<{
    id: string;
    type: string;
    description: string;
    maps?: TarkovDevMap[];
  }>;
}

// ETL output types
export type LootConfidence = "spt_direct" | "uniform_prior" | "id_unmatched" | "reconciled";

export interface LootItem {
  item_id: string;
  probability: number;
  confidence: LootConfidence;
}

export interface LootProbabilities {
  schema_version: "1.0";
  generated_at: string;
  game_patch: string;
  maps: Record<string, {
    containers: Record<string, {
      items: LootItem[];
    }>;
    loose_loot_regions: Array<{
      region_id: string;
      center: Position;
      radius: number;
      items: LootItem[];
    }>;
  }>;
}

export interface SpawnClusterMember {
  position: Position;
  zone_name: string;
}

export interface SpawnCluster {
  cluster_id: string;
  centroid: Position;
  radius_m: number;
  member_count: number;
  zone_names: string[];
  members: SpawnClusterMember[];
}

export interface SpawnClusters {
  schema_version: "1.0";
  generated_at: string;
  config: {
    max_clusters_per_map: number;
    min_clusters_per_map: number;
    default_proximity_threshold_m: number;
  };
  maps: Record<string, {
    proximity_threshold_used_m: number;
    clusters: SpawnCluster[];
  }>;
}

export interface IconicLabel {
  name: string;
  center: Position;
  layer_range_y: [number, number];
  source: "the-hideout/tarkov-dev";
}

export interface NamedPOIs {
  schema_version: "1.0";
  generated_at: string;
  maps: Record<string, {
    iconic_labels: IconicLabel[];
    spawn_cluster_names: Record<string, {
      name: string;
      source: "iconic_match" | "synthetic";
    }>;
  }>;
}

export type EnrichmentStatus = "complete" | "schema_invalid" | "skipped" | "review_pending";

export interface QuestConstraints {
  maps?: string[] | null;
  zone?: string | null;
  body_parts?: string[] | null;
  weapon_specific_item?: string | null;
  weapon_class?: string | null;
  weapon_mods_required: string[];
  wearing_required: string[];
  not_wearing: string[];
  distance_min_m?: number | null;
  distance_max_m?: number | null;
  time_of_day?: string | null;
  shot_type?: string | null;
  health_state?: string | null;
  required_keys: string[];
}

export interface QuestObjectiveEnhancement {
  objective_id: string;
  constraints: QuestConstraints;
  source_text: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}

export interface QuestEnhancements {
  schema_version: "1.0";
  generated_at: string;
  llm_model: string;
  quests: Record<string, {
    enrichment_status: EnrichmentStatus;
    objectives: QuestObjectiveEnhancement[];
  }>;
}

export interface ManifestFile {
  name: string;
  sha256: string;
  size_bytes: number;
}

export interface Manifest {
  schema_version: "1.0";
  version: string;
  game_patch: string;
  generated_at: string;
  sources: {
    spt_aki_commit: string;
    tarkov_dev_query_time: string;
    the_hideout_commit: string;
  };
  llm: {
    model: string;
    stage_5_completed: boolean;
  };
  files: ManifestFile[];
}

export interface SourceVersions {
  spt_aki_commit?: string;
  tarkov_dev_etag?: string;
  the_hideout_commit?: string;
}

export interface StageContext {
  config: Config;
  workDir: string;
  sourceVersions: SourceVersions;
}