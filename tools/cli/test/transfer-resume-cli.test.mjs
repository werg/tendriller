import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, CORE_RELEASE } from "@tendriller/core/contract";
import { saveConfig } from "../lib/config.mjs";

const cli = fileURLToPath(new URL("../bin/tendril.mjs", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (args, env) => new Promise(resolve => execFile(process.execPath, [cli, ...args],
  {env:{...process.env,...env},timeout:15_000},
  (error,stdout,stderr) => resolve({code:error?.code??0,stdout,stderr})));

test("a peer publication commits exact bytes without health, metadata or application traffic afterward", async () => {
  const root = mkdtempSync(join(tmpdir(), 'tendriller-peer-publish-')), source = join(root, 'index.html');
  const bytes = Buffer.from('<!doctype html><title>Peer page</title>'), requests = [];
  const file = { path: 'index.html', blob_id: 'b_aaaaaaaaaaaaaaaaaaaa', sha256: sha256(bytes), size: bytes.length, type: 'text/html' };
  let committed = false, upgrades = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push([req.method, req.url]);
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (committed) return json({ error: { code: 'unexpected_after_publication', message: req.url } }, 500);
    if (req.url === '/api/service') return json({ contract: CONTRACT_VERSION, core_release: CORE_RELEASE, workflows: [], limits: {} });
    if (req.url === '/api/t/abcdefghijkl/publications' && req.method === 'GET') return json({ current: 1, head_revision: 1, versions: [] });
    if (req.url === '/api/t/abcdefghijkl/publications/1') return json({ version: 1, entry: 'index.html', files: [file] });
    if (req.url === '/api/t/abcdefghijkl/publications' && req.method === 'POST') {
      const body = JSON.parse(raw);
      assert.equal(body.expected_head_revision, 1);
      assert.deepEqual(body.files, [{ path: file.path, blob_id: file.blob_id, type: file.type }]);
      committed = true; return json({ version: 2, head_revision: 2 });
    }
    return json({ error: { code: 'unexpected_route', message: req.url } }, 404);
  });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.destroy(); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, env = { TENDRIL_CONFIG_DIR: join(root, 'config') };
    const saved = saveConfig({ id: 'abcdefghijkl', token: 'tk_peer', api: `${origin}/api/t/abcdefghijkl`, page_url: `${origin}/page/`,
      application: { kind: 'peer', id: 'ab'.repeat(32) }, mode: 'interactive' }, 'peer', env, origin);
    writeFileSync(source, bytes);
    const result = await run(['push', source, '--tendril', saved.name], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: 2, head_revision: 2, files: 1, reused: 1, status: 'pending',
      note: 'Publication committed; application readiness is observed through its selected backend.' });
    assert.deepEqual(requests, [['GET', '/api/t/abcdefghijkl/publications'], ['GET', '/api/t/abcdefghijkl/publications/1'],
      ['GET', '/api/service'], ['POST', '/api/t/abcdefghijkl/publications']]);
    assert.equal(upgrades, 0);
    const waiting = await run(['push', source, '--tendril', saved.name, '--wait'], env);
    assert.equal(waiting.code, 64);
    assert.match(waiting.stderr, /peer readiness belongs to the application session/);
    assert.equal(requests.length, 4, 'an unsupported hosted wait must fail before any request');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI changed bytes at the same path get a new transfer; identical retries reuse their receipt", async () => {
  const root=mkdtempSync(join(tmpdir(),"tendriller-resume-")), source=join(root,"bytes.dat");
  let starts=0;
  const sessions=new Map(), byId=new Map();
  const server=createServer(async (req,res) => {
    const path=new URL(req.url,"http://localhost").pathname;
    const buffers=[];
    for await(const c of req) buffers.push(c);
    const bytes=Buffer.concat(buffers);
    const json=(obj,status=200) => {
      res.writeHead(status,{"Content-Type":"application/json"});
      res.end(JSON.stringify(obj));
    };
    if(path==="/api/service") return json({contract:CONTRACT_VERSION,core_release:CORE_RELEASE,workflows:[],limits:{}});
    if(path==="/api/t/abcdefghijkl/uploads" && req.method==="POST"){
      const request=JSON.parse(bytes.toString());
      let session=sessions.get(request.cid);
      if(!session){
        const letter=String.fromCharCode(97+starts++);
        session={id:"u_"+letter.repeat(20),blob_id:"b_"+letter.repeat(20),sha256:request.sha256,
          size:request.size,type:request.type,phase:"ready",upload_required:true,expires_at:Date.now()+60_000};
        sessions.set(request.cid,session);byId.set(session.id,session);
      }else{
        assert.equal(session.sha256,request.sha256);
        assert.equal(session.size,request.size);
      }
      const { type, received, ...publicSession } = session;
      return json(publicSession);
    }
    const match=/^\/api\/t\/abcdefghijkl\/uploads\/(u_[a-z2-7]{20})\/(content|complete)$/.exec(path);
    if(match){
      const session=byId.get(match[1]);
      if(!session)return json({error:{code:"not_found"}},404);
      if(match[2]==="content" && req.method==="PUT"){
        assert.equal(bytes.length,session.size);
        assert.equal(sha256(bytes),session.sha256);
        session.received=true;
        return json({ok:true});
      }
      if(match[2]==="complete" && req.method==="POST"){
        assert.equal(session.received,true);
        return json({status:"completed",blob:{id:session.blob_id,sha256:session.sha256,
          size:session.size,type:session.type,url:`_tendril/blobs/${session.blob_id}`,
          created_at:1000,retention:{expires_at:null,reasons:["agent_asset"]}}});
      }
    }
    return json({error:{code:"unknown_route",message:path}},404);
  });
  try{
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const env={TENDRIL_API:"http://127.0.0.1:"+server.address().port+"/api/t/abcdefghijkl",
      TENDRIL_TOKEN:"tk_test",TENDRIL_CONFIG_DIR:join(root,"config")};
    writeFileSync(source,Buffer.from([0,255,1,2]));
    const first=await run(["blob","upload",source],env);
    assert.equal(first.code,0,first.stderr);
    assert.equal(starts,1);
    const firstId=JSON.parse(first.stdout).blob.id;
    writeFileSync(source,Buffer.from([0,255,1,3]));
    const second=await run(["blob","upload",source],env);
    assert.equal(second.code,0,second.stderr);
    assert.equal(starts,2,"changed bytes must allocate a new operation");
    assert.notEqual(JSON.parse(second.stdout).blob.id,firstId);
    const repeat=await run(["blob","upload",source],env);
    assert.equal(repeat.code,0,repeat.stderr);
    assert.equal(starts,2,"retry of identical intent should use its durable receipt");
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
});

test("CLI rollback and file deletion replay their original preconditions after a lost accepted reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "tendriller-command-resume-"));
  const requests = [], receipts = new Map();
  let publicationHead = 8, fileRevision = 3, headReads = 0, fileReads = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost"), path = url.pathname.replace("/api/t/abcdefghijkl", "");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/service") return json({ contract: CONTRACT_VERSION, core_release: CORE_RELEASE, workflows: [], limits: {} });
    if (path === "/publications" && req.method === "GET") {
      headReads++;
      return json({ current: 3, latest: 3, healthy: 3, served: 3, head_revision: publicationHead, versions: [] });
    }
    if (path === "/file-refs" && req.method === "GET") {
      fileReads++;
      assert.equal(url.searchParams.get("path"), "reports/latest.json");
      return json({ path: "reports/latest.json", revision: fileRevision, blob_id: "b_aaaaaaaaaaaaaaaaaaaa" });
    }
    if ((path === "/publications/rollback" && req.method === "POST") || (path === "/file-refs" && req.method === "DELETE")) {
      requests.push({ path, body });
      const prior = receipts.get(body.cid);
      if (prior) {
        assert.deepEqual(body, prior.body, "a retry must keep its original revision, guards and CID");
        return json(prior.result);
      }
      assert.deepEqual(body.expected_generations, { documents: "first" });
      let result;
      if (path === "/publications/rollback") {
        assert.equal(body.expected_head_revision, 8); assert.equal(body.version, 2);
        result = { version: 2, head_revision: 9 };
        publicationHead = 99; // A different writer advances after the accepted command.
      } else {
        assert.equal(body.expected_revision, 3); assert.equal(body.path, "reports/latest.json");
        result = { file: { path: body.path, revision: 4, blob_id: null }, cursor: 10 };
        fileRevision = 20;
      }
      receipts.set(body.cid, { body, result });
      res.destroy(); // Acceptance was durable; its network reply was lost.
      return;
    }
    return json({ error: { code: "unexpected_route", message: path } }, 404);
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const env = { TENDRIL_API: `http://127.0.0.1:${server.address().port}/api/t/abcdefghijkl`,
      TENDRIL_TOKEN: "tk_test", TENDRIL_CONFIG_DIR: join(root, "config") };
    for (const [cid, args] of [
      ["rollback-once", ["rollback", "2"]],
      ["delete-once", ["file", "delete", "reports/latest.json", "--resume-file", join(root, "delete.json")]],
    ]) {
      const command = [...args, "--cid", cid, "--generations", '{"documents":"first"}'];
      const lost = await run(command, env);
      assert.notEqual(lost.code, 0, "the lost reply should require a retry");
      const retried = await run(command, env);
      assert.equal(retried.code, 0, retried.stderr);
      assert.deepEqual(JSON.parse(retried.stdout), receipts.get(cid).result);
      const count = requests.length;
      const completed = await run(command, env);
      assert.equal(completed.code, 0, completed.stderr);
      assert.deepEqual(JSON.parse(completed.stdout), receipts.get(cid).result);
      assert.equal(requests.length, count, "a known accepted command needs no repeated mutation");
    }
    assert.equal(headReads, 1); assert.equal(fileReads, 1);
    assert.equal(requests.length, 4);
    const changed = await run(["file", "delete", "reports/latest.json", "--resume-file", join(root, "delete.json"),
      "--cid", "delete-once", "--generations", '{"documents":"second"}'], env);
    assert.notEqual(changed.code, 0);
    assert.match(changed.stderr, /does not match this intent/);
    assert.equal(requests.length, 4);
    assert.equal(fileReads, 1, "changed intent must fail before refreshing its precondition");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
