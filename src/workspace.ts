import fs from 'fs';
import path from 'path';

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  children?: FileEntry[];
}

const EXCLUDED = new Set([
  'logs',
  '.git',
  'node_modules',
  '__pycache__',
  '.claude',
  'conversations', // can be large; exclude from tree
]);

const MAX_DEPTH = 4;

/**
 * Build a recursive file tree for a directory.
 * Hidden files, `logs/`, and other noisy directories are excluded.
 * Depth is capped at MAX_DEPTH to avoid huge payloads.
 */
export function buildFileTree(dir: string, depth = 0): FileEntry[] {
  if (depth >= MAX_DEPTH) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: FileEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || EXCLUDED.has(entry.name)) continue;
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        type: 'dir',
        children: buildFileTree(path.join(dir, entry.name), depth + 1),
      });
    } else if (entry.isFile()) {
      result.push({ name: entry.name, type: 'file' });
    }
  }
  return result;
}
