import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function prepareMountTargets(workspace) {
  // Docker cannot create nested targets beneath a read-only parent bind.
  // Empty mountpoints build no bytes and overwrite no existing assets.
  await mkdir(resolve(workspace, 'dist'), { recursive: true });
  await mkdir(resolve(workspace, 'server/public'), { recursive: true });
}
