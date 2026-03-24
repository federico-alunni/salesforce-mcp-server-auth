// ============================================================================
// Simple JSON file-based store — swappable with a real DB later
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { storage } from '../config/index.js';
import { logger } from '../logger.js';

const dataDir = storage.dataDir;

function ensureDir() {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.debug(`Created data directory: ${dataDir}`);
  }
}

function filePath(collection: string): string {
  ensureDir();
  return join(dataDir, `${collection}.json`);
}

function readCollection<T>(collection: string): T[] {
  const fp = filePath(collection);
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, 'utf8'));
  } catch {
    logger.warn(`Failed to read ${fp}, returning empty collection`);
    return [];
  }
}

function writeCollection<T>(collection: string, data: T[]): void {
  const fp = filePath(collection);
  writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Generic CRUD
// ---------------------------------------------------------------------------

export function findAll<T>(collection: string): T[] {
  return readCollection<T>(collection);
}

export function findOne<T>(collection: string, predicate: (item: T) => boolean): T | undefined {
  return readCollection<T>(collection).find(predicate);
}

export function upsert<T>(collection: string, item: T, idField: string = 'id'): void {
  const items = readCollection<T>(collection);
  const idx = items.findIndex(i => (i as any)[idField] === (item as any)[idField]);
  if (idx >= 0) items[idx] = item;
  else items.push(item);
  writeCollection(collection, items);
}

export function remove<T>(collection: string, predicate: (item: T) => boolean): boolean {
  const items = readCollection<T>(collection);
  const before = items.length;
  const filtered = items.filter(i => !predicate(i));
  if (filtered.length === before) return false;
  writeCollection(collection, filtered);
  return true;
}
