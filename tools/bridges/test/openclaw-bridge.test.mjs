import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge=join(dirname(fileURLToPath(import.meta.url)),'../bin/openclaw-bridge.mjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){const v=fn();if(v)return v;await pause(50);}throw Error('Timed out waiting for bridge');}

test('OpenClaw bridge targets the intended session, retries failed admission, and waits for acknowledgement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tendriller-openclaw-bridge-'));
  const marker=join(dir,'queue.jsonl');
  let secondEvent=false;
  const fake=join(dir,'openclaw');
  writeFileSync(fake,`#!/usr/bin/env node
const fs=require('fs');const path=process.env.BRIDGE_TEST_LOG;
const previous=fs.existsSync(path)?fs.readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).length:0;
fs.appendFileSync(path,JSON.stringify(process.argv.slice(2))+'\\n');
if(previous===0){process.exitCode=1;}else console.log('ok');
`);chmodSync(fake,0o755);
  const id='abc234abc234';
  const server=createServer(async(req,res)=>{
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; }
    const u=new URL(req.url,'http://localhost');
    assert.equal(req.headers.authorization,'Bearer tk_secret');
    res.setHeader('Content-Type','application/json');
    const after=Number(u.searchParams.get('after')||0);
    assert.equal(u.searchParams.get('wait'),'0');
    if(after>=1) await pause(70);
    const all=[{seq:1,type:'event',role:null,wake:true,by:'agent_probe',data:{kind:'delivery_probe',secret:'DO_NOT_QUEUE_PAGE_DATA'}}];
    if(secondEvent) all.push({seq:2,type:'instruction',role:'owner',wake:true,data:{text:'another request'}});
    const events=all.filter(e=>e.seq>after);
    res.end(JSON.stringify({events,cursor:events.at(-1)?.seq||after}));
  });
  const wss=new WebSocketServer({server});
  let socket;
  wss.on('connection',ws=>{socket=ws;});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const api=`http://127.0.0.1:${server.address().port}/api/t/${id}`;
  const config=join(dir,`${id}.json`);
  const state=join(dir,`${id}.state.json`);
  const ack=join(dir,`${id}.ack.json`);
  writeFileSync(config,JSON.stringify({id,api,token:'tk_secret',session_key:'agent:main:main',openclaw:fake,config_path:config,state_path:state,ack_path:ack}));
  writeFileSync(state,JSON.stringify({poll_cursor:0,pending_seq:0,pending_at:0,attempts:0}));
  writeFileSync(ack,JSON.stringify({cursor:0}));
  const child=spawn(process.execPath,[bridge,'run',config],{env:{...process.env,BRIDGE_TEST_LOG:marker},stdio:'ignore'});
  try{
    const calls=await until(()=>{
      if(!existsSync(marker))return null;
      const rows=readFileSync(marker,'utf8').trim().split('\n').filter(Boolean);
      return rows.length>=2?rows:null;
    });
    assert.equal(calls.length,2,'the first queue failure must retry');
    for(const row of calls){
      const argv=JSON.parse(row);
      assert.deepEqual(argv.slice(0,2),['system','event']);
      assert.equal(argv[2],'--text');
      assert.deepEqual(argv.slice(4),['--session-key','agent:main:main','--mode','now']);
      assert.match(argv[3],/1 page event waiting/);
      assert.doesNotMatch(argv[3],/DO_NOT_QUEUE_PAGE_DATA|tk_secret/);
    }
    await until(()=>readFileSync(state,'utf8').includes('"pending_seq":1'));
    assert.equal(JSON.parse(readFileSync(ack,'utf8')).cursor,0,'queue acceptance is not an agent acknowledgement');
    secondEvent=true;
    socket.send(JSON.stringify({t:'wake',seq:2}));
    await until(()=>JSON.parse(readFileSync(state,'utf8')).poll_cursor===2);
    assert.equal(readFileSync(marker,'utf8').trim().split('\n').length,2,'second event coalesces while first notice is unacknowledged');
    execFileSync(process.execPath,[bridge,'ack',id,'1'],{env:{...process.env,TENDRIL_OPENCLAW_BRIDGE_DIR:dir}});
    assert.equal(JSON.parse(readFileSync(ack,'utf8')).cursor,1);
    const next=await until(()=>{
      const rows=readFileSync(marker,'utf8').trim().split('\n');
      return rows.length===3?JSON.parse(rows[2]):null;
    });
    assert.match(next[3],/1 page event waiting, 1 owner instruction/);
    assert.doesNotMatch(next[3],/another request/);
    execFileSync(process.execPath,[bridge,'ack',id,'2'],{env:{...process.env,TENDRIL_OPENCLAW_BRIDGE_DIR:dir}});
    await pause(200);
    assert.equal(readFileSync(marker,'utf8').trim().split('\n').length,3,'acknowledged event must not wake again');
  }finally{child.kill('SIGKILL');socket?.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));}
});
