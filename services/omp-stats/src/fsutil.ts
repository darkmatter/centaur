import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Write a file atomically: temp sibling + rename, so readers never see a partial file. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await Bun.write(tmp, data);
  renameSync(tmp, path);
}

/**
 * Recursive removal guarded to paths strictly inside `root`. Sync/extract
 * churn is the only deleter in this service; the guard makes a path-building
 * bug fail loudly instead of deleting outside the data dir.
 */
export function removeInside(root: string, target: string): void {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  if (!targetAbs.startsWith(rootAbs + sep)) {
    throw new Error(`refusing to remove ${targetAbs}: outside ${rootAbs}`);
  }
  rmSync(targetAbs, { recursive: true, force: true });
}
