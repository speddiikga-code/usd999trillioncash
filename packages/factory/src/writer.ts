import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '@roos/shared';
import type { GeneratedFile } from './generator';

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Write generated files under `dir`, refusing any path that escapes it (defence against a
 * compromised generator producing `../` paths). Returns a manifest with content hashes.
 */
export function writeProject(dir: string, files: GeneratedFile[], opts: { clean?: boolean } = {}): ManifestEntry[] {
  const root = path.resolve(dir);
  if (opts.clean) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const manifest: ManifestEntry[] = [];
  for (const f of files) {
    if (path.isAbsolute(f.path) || f.path.includes('\0')) throw new Error(`Refusing absolute/invalid path ${f.path}`);
    const target = path.resolve(root, f.path);
    if (!target.startsWith(root + path.sep)) throw new Error(`Refusing path outside project: ${f.path}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
    manifest.push({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256Hex(f.content) });
  }
  return manifest;
}
