import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFile } from 'fs/promises';

class SchemaValidator {
  private ajv: Ajv;
  private schemas: Map<string, object> = new Map();

  constructor() {
    this.ajv = new Ajv({ allErrors: true });
    addFormats(this.ajv);
  }

  async loadSchema(name: string, path: string): Promise<void> {
    try {
      const schemaContent = await readFile(path, 'utf-8');
      const schema = JSON.parse(schemaContent);
      this.schemas.set(name, schema);
      this.ajv.addSchema(schema, name);
    } catch (error) {
      throw new Error(`Failed to load schema ${name} from ${path}: ${error}`);
    }
  }

  validate(schemaName: string, data: unknown): { valid: boolean; errors?: string[] } {
    const validateFn = this.ajv.getSchema(schemaName);
    if (!validateFn) {
      throw new Error(`Schema ${schemaName} not found`);
    }

    const valid = validateFn(data);
    if (valid) {
      return { valid: true };
    }

    const errors = validateFn.errors?.map(err => {
      const path = err.instancePath || 'root';
      return `${path}: ${err.message}`;
    }) || ['Unknown validation error'];

    return { valid: false, errors };
  }

  async validateFile(schemaName: string, filePath: string): Promise<{ valid: boolean; errors?: string[] }> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      return this.validate(schemaName, data);
    } catch (error) {
      return { valid: false, errors: [`Failed to read/parse file: ${error}`] };
    }
  }
}

export const schemaValidator = new SchemaValidator();

// Load all schemas on module import
export async function initializeSchemas(): Promise<void> {
  const schemaDir = 'src/schemas';
  const schemas = [
    { name: 'loot-probabilities', file: 'loot-probabilities.schema.json' },
    { name: 'spawn-clusters', file: 'spawn-clusters.schema.json' },
    { name: 'named-pois', file: 'named-pois.schema.json' },
    { name: 'quest-enhancements', file: 'quest-enhancements.schema.json' },
    { name: 'manifest', file: 'manifest.schema.json' },
  ];

  for (const schema of schemas) {
    await schemaValidator.loadSchema(schema.name, `${schemaDir}/${schema.file}`);
  }
}