/**
 * tenancy/load.ts — load the model catalog from config/models.json.
 *
 * Reads and parses the JSON at runtime (via node:fs) rather than an ESM JSON import so it works
 * uniformly across Node versions and tsx without import-attribute syntax. The file contains NO
 * secrets — only model metadata; hosted/cloud keys come from env at route time.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelCatalog, type ModelCatalogConfig } from './catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = resolve(HERE, '../config/models.json');

/** Load a ModelCatalog from a JSON file (defaults to config/models.json). */
export function loadCatalog(path: string = DEFAULT_CATALOG_PATH): ModelCatalog {
  const raw = readFileSync(path, 'utf8');
  const config = JSON.parse(raw) as ModelCatalogConfig;
  return ModelCatalog.fromConfig(config);
}

/** Convenience: the catalog loaded from the bundled config/models.json. */
export function defaultCatalog(): ModelCatalog {
  return loadCatalog();
}
