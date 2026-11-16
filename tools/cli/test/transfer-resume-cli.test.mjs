import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/tendril.mjs", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (args, env) => new Promise(resolve => execFile(process.execPath, [cli, ...args],
  {env:{...process.env,...env},timeout:15_000},
  (error,stdout,stderr) => resolve({code:error?.code??0,stdout,stderr})));

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
    if(path==="/api/service") return json({contract:3,core_release:"0.3.0-rc.1",workflows:[],limits:{}});
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
      return json(session);
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
          size:session.size,type:session.type}});
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
