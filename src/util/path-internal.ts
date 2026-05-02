import { promises as fs } from 'node:fs';
import { SquadError } from '../errors.js';

/**
 * Internal helpers shared between path-safety.ts and override-allowlist.ts.
 * Exported only for intra-`util/` reuse; do not import from outside src/util/.
 */

export function rejectIfMalformed(file: string): void {
  if (file.includes('\0')) {
    throw new SquadError('PATH_INVALID', 'file path contains NUL byte', { file });
  }
  if (file.startsWith('~')) {
    throw new SquadError('PATH_INVALID', 'file path starts with ~ (tilde expansion not supported)', { file });
  }
  const adsIndex = file.indexOf(':', 2);
  if (adsIndex !== -1) {
    throw new SquadError('PATH_INVALID', 'file path contains ADS marker (:) after drive letter', { file });
  }
}

export async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}
