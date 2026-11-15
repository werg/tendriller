import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const tag = `v${pkg.version}`;
if (manifest.version !== pkg.version) throw new Error('The release manifest version must match package.json.');
if (![`refs/tags/${tag}`, `refs/heads/release/${tag}`].includes(process.argv[2])) {
  throw new Error(`The release ref must be refs/tags/${tag} or refs/heads/release/${tag}.`);
}
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (manifest.source_commit !== source || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== source)) {
  throw new Error('The release manifest and workflow must identify the exact checked-out source commit.');
}

// Callers may add generated metadata files after the ref; discovery is always last.
const files = [...manifest.artifacts.map(artifact => artifact.file), ...process.argv.slice(3), 'manifest.json'];
if (new Set(files).size !== files.length) throw new Error('Release asset names must be unique.');
for (const file of files) {
  if (file !== basename(file) || !/^[a-zA-Z0-9._-]+$/.test(file)) throw new Error(`Invalid release asset name: ${file}`);
  readFileSync(join(dist, file));
}
for (const artifact of manifest.artifacts) {
  const bytes = readFileSync(join(dist, artifact.file));
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error(`Built release asset does not match manifest: ${artifact.file}`);
  }
}

function api(path, allowMissing = false) {
  const result = spawnSync('gh', ['api', `repos/{owner}/{repo}/${path}`], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (allowMissing && /\(HTTP 404\)/.test(result.stderr)) return null;
  throw new Error(result.error?.message || result.stderr || `Unable to inspect ${path}.`);
}

function inspectTag() {
  const ref = api(`git/ref/tags/${encodeURIComponent(tag)}`, true);
  if (!ref) return null;
  if (ref.ref !== `refs/tags/${tag}`) throw new Error('The inspected ref does not match the release tag.');
  let target = ref.object;
  const visited = new Set();
  while (target.type === 'tag') {
    if (visited.has(target.sha)) throw new Error('The release tag contains a cycle.');
    visited.add(target.sha);
    target = api(`git/tags/${target.sha}`).object;
  }
  if (target.type !== 'commit' || target.sha !== source) {
    throw new Error('The release tag must point to the exact tested source commit; existing tags are never moved.');
  }
  return target.sha;
}

inspectTag();
const releasePath = `releases/tags/${encodeURIComponent(tag)}`;
let remote = api(releasePath, true);
if (!remote) {
  // --target creates a missing tag at this tested commit, never at the default branch.
  execFileSync('gh', ['release', 'create', tag, '--target', source, '--generate-notes', '--prerelease'], { cwd: root, stdio: 'inherit' });
  remote = api(releasePath);
}
if (remote.tag_name !== tag) throw new Error('The inspected release does not match the requested tag.');
if (!inspectTag()) throw new Error('The published release tag is missing.');

const existing = new Set(remote.assets.map(asset => asset.name));
const temporary = mkdtempSync(join(tmpdir(), 'tendriller-release-'));
try {
  // Check every existing name before uploading anything. Published bytes are immutable.
  for (const file of files.filter(file => existing.has(file))) {
    execFileSync('gh', ['release', 'download', tag, '--pattern', file, '--dir', temporary], { cwd: root, stdio: 'inherit' });
    if (!readFileSync(join(dist, file)).equals(readFileSync(join(temporary, file)))) {
      throw new Error(`Published release asset differs from the build: ${file}`);
    }
  }
  // Publish the manifest last so discovery follows successful upload of its complete graph.
  for (const file of files.filter(file => !existing.has(file))) {
    execFileSync('gh', ['release', 'upload', tag, join(dist, file)], { cwd: root, stdio: 'inherit' });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`Verified immutable release ${tag} from ${source}: ${files.length} assets.`);
