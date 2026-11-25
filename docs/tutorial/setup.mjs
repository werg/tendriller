// Workspace page lifecycle. The workspace itself (one agent credential and signing
// key) comes from `npx tendril workspace init --service ORIGIN --owner EMAIL`.
//   npm run page:new -- <slug> [--template notes|inventory] [--name "Title"]
//   npm run init -- <slug>     npm run build -- <slug>     npm run deploy -- <slug>
//   npm run enroll -- <slug> BROWSER_PUBLIC_KEY            npm run assistant:prepare -- <slug> [--events]
//   npm run demo -- <slug>     (inventory pages, with npm run agent running)
import { cp, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { describeReadiness, requireCreationReady } from '@tendriller/core';
import { requireEmptyPageFolder, requireSlug, workspace, workspaceRoot } from './shared/local.mjs';

export const TEMPLATES = Object.freeze(['notes', 'inventory']);
const templateRoot = new URL('./templates/', import.meta.url);
const pageModule = (slug, name) => import(pathToFileURL(join(workspaceRoot, 'pages', slug, name)).href);

/** Create one page granted to this agent and copy its template source into pages/<slug>/. */
export async function createPage(slug, { template = 'notes', name } = {}) {
  requireSlug(slug);
  if (!TEMPLATES.includes(template)) throw Error(`Choose --template ${TEMPLATES.join(' or ')}.`);
  const selected = await workspace();
  if (selected.config.pages?.[slug]) {
    const page = await selected.page(slug);
    return { slug, id: page.id, page_url: page.page_url, resumed: true, next: `Continue with npm run init -- ${slug}.` };
  }
  await requireEmptyPageFolder(slug);
  const origin = selected.config.service;
  requireCreationReady(await describeReadiness(origin), { service: origin });
  // Optional native code (the inventory SQL engine) is diagnosed before any hosted page exists.
  const source = new URL(`${template}/`, templateRoot);
  if (template === 'inventory') await (await import(new URL('setup.mjs', source).href)).preflight();
  // A folder filled while readiness was checked still blocks creation.
  await requireEmptyPageFolder(slug);
  const client = await selected.client();
  const created = await client.pages.create({ name: name ?? (template === 'inventory' ? 'Shared inventory' : 'Shared notes') });
  const page = await selected.registerPage(slug, created);
  const target = join(workspaceRoot, 'pages', slug);
  for (const entry of await readdir(source)) await cp(new URL(entry, source), join(target, entry), { recursive: true, errorOnExist: true, force: false });
  return { slug, id: page.id, page_url: page.page_url, template,
    next: `Run npm run init -- ${slug} now and prepare/publish the app while the owner signs in; do not wait for a claimed reply.` };
}

async function run(action, args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { template: { type: 'string' }, name: { type: 'string' }, events: { type: 'boolean' } } });
  const [slug, extra] = positionals;
  if (action === 'new') return createPage(slug, values);
  // Inventory pages: the demo attaches to the running agent program.
  if (action === 'demo') { await pageModule(requireSlug(slug), 'demo.mjs'); return undefined; }
  const context = await (await workspace()).pageContext(requireSlug(slug));
  if (action === 'init') return (await pageModule(slug, 'setup.mjs')).initializePage(context);
  if (action === 'enroll') return (await pageModule(slug, 'setup.mjs')).enrollBrowser(context, extra);
  if (action === 'assistant') return (await pageModule(slug, 'assistant.mjs')).prepareAssistant(context, { events: values.events });
  if (action === 'build' || action === 'deploy') {
    const { build } = await import('esbuild');
    const output = await (await pageModule(slug, 'build.mjs')).buildPage(context, { bundle: build });
    if (action === 'build') return { built: output, next: `npm run deploy -- ${slug}` };
    // Publication runs on the page owner inside the running agent program.
    const tendril = fileURLToPath(new URL('./node_modules/.bin/tendril', import.meta.url));
    const child = spawn(tendril, ['--page', slug, 'publish', output], { stdio: 'inherit' });
    const [code] = await new Promise(resolve => child.once('exit', (...result) => resolve(result)));
    if (code !== 0) throw Object.assign(Error('Publication failed; inspect the reported operation before retrying.'), { code: 'publication_failed' });
    return undefined;
  }
  throw Error('Use new, init, enroll, assistant, build, deploy or demo with a page slug. See README.md.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, ...args] = process.argv.slice(2);
  try {
    const result = await run(action, args);
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; }
}
