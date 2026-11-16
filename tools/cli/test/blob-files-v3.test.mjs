import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadBlob, downloadBlob } from "../lib/blobs.mjs";
import { assertRemotePath, putSharedFile, getSharedFile } from "../lib/shared-files.mjs";
import { pack } from "../lib/pack.mjs";
import { publishFiles } from "../lib/publications.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const dir = () => mkdtempSync(join(tmpdir(),"tendriller-v3-test-"));
const b = id => `b_${id.repeat(20)}`;
const u = id => `u_${id.repeat(20)}`;
const payload = Buffer.from([0, 250, 50, 0, 255, 12, 13, 127]);
function fakeStore({ failCompleteOnce = false, corrupt = false } = {}) {
  const byCid = new Map(), byId = new Map(), objects = new Map(), calls = [], heads = new Map();
  let next = 1, fail = failCompleteOnce;
  const api = {
    calls, heads, objects, byCid,
    post: async (path, body) => {
      calls.push({ method:"POST",path,body });
      if (path === "/uploads") {
        const fp=JSON.stringify(body);
        const prior=byCid.get(body.cid);
        if (prior) { assert.equal(prior.fp,fp); return prior.session; }
        const ident = String.fromCharCode(96 + next++), blobId=b(ident), uploadId=u(ident);
        const session={id:uploadId,blob_id:blobId,sha256:body.sha256,size:body.size,
          phase:"ready",upload_required:true,expires_at:Date.now()+86400000};
        byCid.set(body.cid,{fp,session});byId.set(uploadId,{session,body});
        return session;
      }
      if (path.endsWith("/complete")) {
        const id=path.split("/")[2], stored=byId.get(id);
        if (!stored || !stored.bytes) throw new Error("complete before raw content");
        stored.session.phase="completed";
        if (fail) {fail=false;throw new Error("lost completion acknowledgement");}
        return {status:"completed",blob:{id:stored.session.blob_id,sha256:stored.body.sha256,size:stored.body.size,type:stored.body.type}};
      }
      if (path === "/publications") {
        const prior=byCid.get(`pub:${body.cid}`);
        if (prior) {assert.deepEqual(prior.body,body);return prior.result;}
        if (body.expected_head_revision !== (api.publication?.head_revision ?? 0))
          throw Object.assign(new Error("publication_conflict"), {status:409});
        const result={version:(api.publication?.version??0)+1,head_revision:(api.publication?.head_revision??0)+1};
        byCid.set(`pub:${body.cid}`,{body,result});
        api.publication={...result,files:body.files};
        return result;
      }
      throw Error(`unhandled POST ${path}`);
    },
    put: async (path, body) => {
      calls.push({method:"PUT",path,body});
      if (path !== "/file-refs") throw Error("unexpected PUT");
      const current=heads.get(body.path);
      if ((current?.revision??0)!==body.expected_revision)
        throw Object.assign(new Error("file_conflict"),{status:409});
      const file={path:body.path,revision:body.expected_revision+1,blob_id:body.blob_id};
      heads.set(body.path,file);
      return {file,cursor:file.revision};
    },
    get: async path => {
      calls.push({method:"GET",path});
      if (path.startsWith("/blobs/") && path.endsWith("/info")) {
        const id=path.split("/")[2];for(const stored of byId.values()) if(stored.session.blob_id===id)
          return {id,sha256:stored.body.sha256,size:stored.body.size,type:stored.body.type};
        throw Error("blob not found");
      }
      if (path.startsWith("/file-refs?path=")) {
        const value=heads.get(decodeURIComponent(path.split("=")[1]));
        if (!value) throw Object.assign(Error("not found"),{status:404});
        return value;
      }
      if (path === "/publications") return {head_revision:api.publication?.head_revision??0,current:api.publication?.version??0};
      if (path.startsWith("/publications/")) return api.publication;
      throw Error("unhandled GET "+path);
    },
    raw:async (path,{method,body}={}) => {
      calls.push({method:method??"GET",path,body});
      if (method==="PUT" && /\/uploads\/.+\/content/.test(path)) {
        const id=path.split("/")[2],stored=byId.get(id);
        assert.equal(sha(body),stored.body.sha256);
        stored.bytes=Buffer.from(body);
        objects.set(stored.session.blob_id,stored.bytes);
        stored.session.phase="received";
        return new Response(null,{status:204});
      }
      if (!method && path.startsWith("/blobs/")) {
        const bytes=objects.get(path.split("/")[2]);
        return new Response(corrupt ? Buffer.from("wrong") : bytes);
      }
      throw Error("unexpected raw request");
    },
  };
  return api;
}

test("raw upload keeps one assigned blob across lost complete ACK and restart",async()=>{
  const api=fakeStore({failCompleteOnce:true}), record=join(dir(),"resume.json");
  await assert.rejects(uploadBlob(api,payload,{cid:"same-cid",type:"application/octet-stream",resumeFile:record}),/lost completion/);
  const result=await uploadBlob(api,payload,{cid:"same-cid",type:"application/octet-stream",resumeFile:record});
  assert.equal(result.blob.sha256,sha(payload));
  assert.equal(api.byCid.size,1);
  assert.equal(api.calls.filter(c=>c.method==="PUT").length,1);
  assert.equal(JSON.parse(readFileSync(record)).phase,"completed");
  await assert.rejects(uploadBlob(api,Buffer.from("different"),{resumeFile:record,type:"application/octet-stream"}),/different bytes/);
});
test("verified downloads are atomic on hash/size failure and honor create-only",async()=>{
  const api=fakeStore();const receipt=await uploadBlob(api,payload,{type:"application/octet-stream"});
  const d=dir(),out=join(d,"result.bin");
  const result=await downloadBlob(api,receipt.blob.id,out);
  assert.deepEqual(readFileSync(result.path),payload);
  await assert.rejects(downloadBlob(api,receipt.blob.id,out),/Destination exists/);
  const corrupt={...api,raw:async()=>new Response(Buffer.from("bad"))};
  await assert.rejects(downloadBlob(corrupt,receipt.blob.id,out,{overwrite:true}),/do not match/);
  assert.deepEqual(readFileSync(out),payload,"existing bytes remain untouched after corrupted replacement");
  const symlink=join(d,"symlink.bin");symlinkSync(out,symlink);
  await assert.rejects(downloadBlob(api,receipt.blob.id,symlink,{overwrite:true}),/symlink/);
});
test("file CAS captures original revision, conflict keeps the upload and exact CID",async()=>{
  const api=fakeStore(),d=dir(),record=join(d,"file-intent.json");
  const options={type:"application/octet-stream",cid:"file-work-1",resumeFile:record,expectedGenerations:{},localName:"input.bin"};
  const first=await putSharedFile(api,"samples/data.bin",payload,options);
  assert.equal(first.file.revision,1);
  const again=await putSharedFile(api,"samples/data.bin",payload,options);
  assert.deepEqual(again,first);
  await assert.rejects(putSharedFile(api,"samples/data.bin",Buffer.from("new"),options),/does not match this intent/);
  const stale=join(d,"stale.json");
  const head=api.heads.get("samples/data.bin");
  const later=await putSharedFile(api,"samples/data.bin",Buffer.from("other"),{...options,resumeFile:join(d,"later.json"),expectedRevision:head.revision,cid:"later"});
  assert.equal(later.file.revision,2);
  await assert.rejects(putSharedFile(api,"samples/data.bin",Buffer.from("loser"),{...options,cid:"loser",resumeFile:stale,expectedRevision:head.revision}),err=>err.status===409);
  assert.equal(JSON.parse(readFileSync(stale)).expected_revision,1);
  assert.equal(api.heads.get("samples/data.bin").revision,2);
});
test("remote names reject traversal, Unicode aliases, backslash and reserved routes",()=>{
  assert.equal(assertRemotePath("unicode/測定.csv"),"unicode/測定.csv");
  for(const path of ["../a", "a//b", "a/../b", "a/./b", "a\\b", "_tendril/secret", "_publications/1/index.html", "/tmp/x", "u\u0308.txt"])
    assert.throws(()=>assertRemotePath(path),/Invalid/);
});
test("pack emits sorted immutable byte hashes and validates entry/symlink",()=>{
  const d=dir();mkdirSync(join(d,"assets"));
  writeFileSync(join(d,"index.html"),"<html>hi</html>");
  writeFileSync(join(d,"assets","binary.bin"),payload);
  writeFileSync(join(d,".secret"),"do not publish");
  const plan=pack(d);
  assert.deepEqual(plan.files.map(x=>x.path),["assets/binary.bin","index.html"]);
  assert.equal(plan.files[0].sha256,sha(payload));
  assert.deepEqual(plan.files[0].bytes,payload);
  assert.equal(plan.entry,"index.html");
  const symlink=join(d,"private.log");symlinkSync(join(d,".secret"),symlink);
  assert.throws(()=>pack(d),/symlink/);
});
test("publication retries preserve full manifest, captured head CAS and original CID",async()=>{
  const api=fakeStore(), d=dir(),record=join(d,"publication.json");
  writeFileSync(join(d,"index.html"),"<h1>Page</h1>");
  writeFileSync(join(d,"module.js"),"export default 1");
  const plan=pack(d),options={resumeFile:record,cid:"pub-once",generations:{}};
  const first=await publishFiles(api,plan,options);
  assert.equal(first.head_revision,1);
  const again=await publishFiles(api,plan,options);
  assert.deepEqual(again,first);
  assert.equal(api.byCid.get("pub:pub-once").body.expected_head_revision,0);
  assert.equal(api.byCid.get("pub:pub-once").body.files.length,2);
  await assert.rejects(publishFiles(api,{...plan,message:"altered"},options),/different bytes/);
});
