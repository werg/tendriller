import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { apiJson, api, create, req, inDO, PageClient, publishTestFiles, uploadAgent } from './helpers';
import { createVersion, deleteUnreferencedContent, fileKey, publicationManifest, storeContent } from '../src/files';
import runtimeRelease from '../src/runtime-release.json';
import { sha256Hex } from '../src/ids';

it('locks complete publication graphs and resolves nested HTML relative to its own directory', async () => {
  const page=await create();
  const a=await publishTestFiles(page,{replace:true,files:{'index.html':'<head></head><script src="app.js"></script>','app.js':'export const version="A"','docs/index.html':'<head></head><script src="nested.js"></script>','docs/nested.js':'A nested'}});
  const first=await req(page.page_url), html=await first.text();
  const config=JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]);
  expect(config.publication.id).toBe(String(a.version));
  expect(config.publication.assets).toHaveLength(4);
  expect(config.publication.runtime).toMatchObject({id:runtimeRelease.id,version:runtimeRelease.version});
  const b=await publishTestFiles(page,{replace:true,files:{'index.html':'<head></head>B','app.js':'export const version="B"'}});
  const assetA=await req(page.page_url+`_publications/${a.version}/app.js`);
  const assetB=await req(page.page_url+`_publications/${b.version}/app.js`);
  expect(await assetA.text()).toContain('"A"');expect(await assetB.text()).toContain('"B"');
  expect(assetA.headers.get('Cache-Control')).toContain('immutable');
  expect(assetA.headers.get('X-Tendril-Publication')).toBe(String(a.version));
  const nested=await (await req(page.page_url+`_publications/${a.version}/docs/`)).text();
  expect(nested).toContain(`<base href="${new URL(page.page_url).pathname}_publications/${a.version}/docs/">`);
  expect((await (await req(page.page_url+'_tendril/info')).json<any>()).publication.id).toBe(String(b.version));
  expect((await api(page,'PUT','files/_publications/forged/app.js','bad')).status).toBe(404);
});

it('retains an offline publication lease beyond the ordinary recent-version window', async () => {
  const page=await create();
  await publishTestFiles(page,{files:{'index.html':'<head></head>A','lazy.js':'A'}});
  const client=await PageClient.connect(page.page_url,{version:1});client.close();
  await inDO(page.id,async t=>{
    for(let version=2;version<=52;version++){
      t.db.run("INSERT INTO versions(version,created_at,status,runtime_id,runtime_version,runtime_features) SELECT ?,created_at,'healthy',runtime_id,runtime_version,runtime_features FROM versions WHERE version=1",version);
      t.db.run('INSERT INTO version_files(version,path,hash,type,size) SELECT ?,path,hash,type,size FROM version_files WHERE version=1',version);
    }
    t.db.set('current',52);t.db.set('latest',52);t.db.set('healthy',52);
    await t.pruneVersions();
    expect(t.db.one('SELECT version FROM versions WHERE version=1')).not.toBeNull();
    expect(publicationManifest(t,1,'/page/').runtime.id).toBe(runtimeRelease.id);
  });
  expect(await (await req(page.page_url+'_publications/1/lazy.js')).text()).toBe('A');
});

it('serves retained immutable runtime objects after the bundled runtime changes',async()=>{
  const id='f'.repeat(64),path=`runtime/${id}/module.js`;
  await env.FILES.put(path,'export const archived=true',{httpMetadata:{contentType:'text/javascript'}});
  const response=await req(`/_tendril/runtime/${id}/module.js`);
  expect(response.status).toBe(200);expect(await response.text()).toBe('export const archived=true');
  expect(response.headers.get('Cache-Control')).toContain('immutable');
});

it('pins version-dependent features and serves old declared resources after a newer publication', async () => {
  const page = await create();
  await publishTestFiles(page, {files:{'index.html':'<head></head>First publication'}});
  const script = 'self.retainedEngine = true;', hash = await sha256Hex(script);
  const resource = `_tendril/assets/${hash}/engine.js`;
  await env.FILES.put(`assets/${hash}/engine.js`, script, {httpMetadata:{contentType:'text/javascript'}});
  const selected = {...runtimeRelease.features, speech:{...runtimeRelease.features.speech, engine:{...runtimeRelease.features.speech.engine,script:resource}}};
  await inDO(page.id, t => t.db.run('UPDATE versions SET runtime_features=? WHERE version=1', JSON.stringify(selected)));
  await publishTestFiles(page, {files:{'index.html':'<head></head>Second publication'}});
  const config = (html: string) => JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]);
  const old = config(await (await req(page.page_url + '_publications/1/index.html')).text());
  const current = config(await (await req(page.page_url)).text());
  expect(old.features.speech.engine.script).toBe(resource);
  expect(old.publication.runtime.features).toEqual(selected);
  expect(current.features.speech).toEqual(runtimeRelease.features.speech);
  const response = await req(page.page_url + resource);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(script);
  await env.FILES.put(`assets/${hash}/engine.js`, 'tampered', {httpMetadata:{contentType:'text/javascript'}});
  expect((await req(page.page_url + resource)).status).toBe(503);
});

it('keeps an incomplete holding page at its canonical URL without claiming a publication graph', async () => {
  const page = await create();
  await uploadAgent(page, 'export const pending = true;', 'text/javascript', 'app.js');
  const response = await req(page.page_url), html = await response.text();
  const config = JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]);
  expect(config.publication).toBeUndefined();
  expect(html).toContain(`<base href="${new URL(page.page_url).pathname}">`);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Tendril-Publication')).toBeNull();
});

it('serializes content reuse with garbage collection and admits only ready file references', async () => {
  const page = await create();
  await inDO(page.id, async t => {
    const body = new TextEncoder().encode('export const retained = true').buffer as ArrayBuffer;
    const content = await storeContent(t, body, 'text/javascript');
    const files = new Map([['lazy.js', { path: 'lazy.js', type: 'text/javascript', ...content }]]);
    const original = t.env.FILES;
    let entered!: () => void, release!: () => void, deletes = 0;
    const deleting = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    t.env.FILES = new Proxy(original, { get(target, name) {
      if (name === 'delete') return async (key: string | string[]) => {
        deletes++;
        entered();
        await resume;
        return original.delete(key);
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      const cleanup = deleteUnreferencedContent(t, content.hash);
      await deleting;
      expect(t.db.one<{ status: string }>('SELECT status FROM stored_files WHERE hash=?', content.hash)?.status).toBe('deleting');
      await expect(createVersion(t, files, null, 'test')).rejects.toMatchObject({ code: 'content_unavailable' });
      expect(t.db.all('SELECT * FROM version_files')).toEqual([]);
      const rewriting = storeContent(t, body, 'text/javascript');
      release();
      await Promise.all([cleanup, rewriting]);
      const version = await createVersion(t, files, null, 'test');
      expect(version).toBe(1);
      await deleteUnreferencedContent(t, content.hash);
      expect(deletes).toBe(1);
      expect(await (await original.get(fileKey(t, content.hash)))?.text()).toBe('export const retained = true');
      expect(t.storageUsed()).toBe(body.byteLength);
    } finally { release(); t.env.FILES = original; }
  });
});
