import { readFile } from 'fs/promises';
import { Config } from './types.js';

let cachedConfig: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const configPath = process.env.ETL_CONFIG_PATH || './etl.config.json';
    const configContent = await readFile(configPath, 'utf-8');
    cachedConfig = JSON.parse(configContent) as Config;
    return cachedConfig;
  } catch (error) {
    console.error('Failed to load config:', error);
    throw new Error('Could not load ETL configuration file');
  }
}

export function clearConfigCache(): void {
  cachedConfig = null;
}