import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {packTarGz} from '../../contract/archive.mjs';
import {buildBootstrap} from '../build-bootstrap.mjs';
const script=new URL('../tendriller-bootstrap.mjs',import.meta.url);

test('standalone bundle exactly matches shared-source build',()=>{
  assert.equal(buildBootstrap({check:true}).outputFiles[0].text,readFileSync(script,'utf8'));
});

test('copied standalone bootstrap rejects unsafe archives and never infers initialized app from retained files',t=>{
  const root=mkdtempSync(join(tmpdir(),'bootstrap-safety-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const standalone=join(root,'bootstrap.mjs');copyFileSync(script,standalone);
  const project=join(root,'project');mkdirSync(join(project,'.tendriller'),{recursive:true});
  writeFileSync(join(project,'.tendriller/handle.json'),'{}');
  const archive=join(root,'kit.tgz');
  const run=()=>{
    const result=spawnSync(process.execPath,[standalone,'--archive-file',archive,'--project',project,'--profile','sql-full'],{encoding:'utf8',timeout:5000});
    assert.equal(result.error,undefined);return {code:result.status,report:JSON.parse(result.stdout)};
  };
  writeFileSync(archive,packTarGz([{path:'README.md',bytes:'kit'}]));
  const good=run();assert.equal(good.code,0);assert.equal(good.report.readiness,'project_prepared');assert.equal(good.report.profileConfigured,false);
  assert.equal(good.report.requestedProfile,'sql-full');assert.equal(good.report.profile,null);assert.equal(good.report.retainedExistingIdentity,true);
  const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'file'),'original');
  symlinkSync(outside,join(project,'nested'),'dir');
  writeFileSync(archive,packTarGz([{path:'nested/file',bytes:'bad'}]));
  assert.equal(run().code,3);assert.equal(readFileSync(join(outside,'file'),'utf8'),'original');
  const tar=gunzipSync(packTarGz([{path:'README.md',bytes:'kit'}]));
  writeFileSync(archive,gzipSync(tar.subarray(0,513)));
  assert.equal(run().code,3);
});
