import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Full Chrome binds a Unix socket (SingletonSocket) under its profile and temp directories, and the kernel
 * limits that path to about 107 bytes. The test scratch directory can be longer, so address the real directory
 * through a short alias that still resolves inside it: an open descriptor of the directory is reachable as
 * /proc/<pid>/fd/<fd>. All files stay in the real scratch directory; nothing is created elsewhere. Close the
 * returned handle only after the browser that uses the alias has closed.
 */
export async function shortScratch(prefix: string) {
  const real = await mkdtemp(join(tmpdir(), prefix));
  const directory = process.platform === 'linux' ? await open(real, 'r') : undefined;
  const alias = directory ? `/proc/${process.pid}/fd/${directory.fd}` : real;
  await mkdir(`${alias}/profile`); await mkdir(`${alias}/tmp`);
  return {
    real,
    /** Chrome user-data directory (short alias path). */
    profile: `${alias}/profile`,
    /** Short TMPDIR for the browser process, so its singleton socket path stays within the limit. */
    tmp: `${alias}/tmp`,
    async close() {
      try { await directory?.close(); } finally { await rm(real, { recursive: true, force: true }); }
    },
  };
}
