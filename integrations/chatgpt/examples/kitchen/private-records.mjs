// Node-only write-once setup records. A final path always names complete bytes.
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function createPrivateRecords(directory) {
  function target(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(name)) throw Error('Invalid private record name.');
    return new URL(name, directory);
  }
  return {
    async read(name, optional = false) {
      try { return JSON.parse(await readFile(target(name), 'utf8')); }
      catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    },
    async save(name, value) {
      const destination = target(name), encoded = JSON.stringify(value, null, 2);
      if (encoded === undefined) throw Error('Private setup records must contain JSON.');
      const text = encoded + '\n';
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = new URL(`.${name}.${randomUUID()}.pending`, directory);
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(text, 'utf8'); await file.sync();
        await file.close(); file = undefined;
        try {
          // Unlike rename(), hard-link installation cannot overwrite an
          // existing signer, epoch key or signed transition after a race.
          await link(temporary, destination);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (await readFile(destination, 'utf8') !== text) throw Error(`Refusing to replace saved setup record ${name}; inspect the original setup.`);
        }
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
        return value;
      } finally {
        await file?.close();
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
  };
}
