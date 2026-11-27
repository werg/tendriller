import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {readSessionPin} from '../session-pin.mjs';
const root=resolve(import.meta.dirname,'../..');
function tar(entries){
 const buffers=[];
 for(const[name,content]of entries){const bytes=Buffer.from(content),h=Buffer.alloc(512);h.write(name);h.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);buffers.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));}
 return Buffer.concat([...buffers,Buffer.alloc(1024)]);
}
function fixture(t,{proof={},source='a'.repeat(40),pin='file:archives/session.tgz',native=true,duplicate=false,transform=x=>x}={}){
 const dir=mkdtempSync(join(tmpdir(),'session-pin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'archives'));
 writeFileSync(join(dir,'package.json'),JSON.stringify({devDependencies:{'@chronolog/peer-session':pin}}));
 const provenance={format:'chronolog-peer-session-package/v2',repository:'werg/chronolog',source,sourceTree:'b'.repeat(40),dirty:false,profile:'chronolog-crdt-v2',zeroNativeBuild:true,...proof};
 const entries=[['package/package.json',JSON.stringify({name:'@chronolog/peer-session',exports:{'./webrtc-native':{types:'./native.d.ts',import:'./native.mjs'}}})],['package/provenance.json',JSON.stringify(provenance)]];
 if(native)entries.push(['package/native.mjs','export const rtc = true;']);if(duplicate)entries.push(entries[1]);
 writeFileSync(join(dir,'archives/session.tgz'),transform(gzipSync(tar(entries))));return dir;
}
test('canonical helper reads the real package pin and is independent of installed dependencies',()=>{
 const actual=readSessionPin(root);assert.match(actual.source,/^[a-f0-9]{40}$/);assert.deepEqual(Object.keys(actual),['source']);
});
test('selected local archive determines outputs when the source changes',t=>{
 for(const source of ['c'.repeat(40),'d'.repeat(40)])assert.deepEqual(readSessionPin(fixture(t,{source})),{source});
});
for(const[reason,proof]of[
 ['format',{format:'other'}],['repository',{repository:'other/chronolog'}],['short source',{source:'abc12345'}],['injected source',{source:'a'.repeat(40)+'\nsql_archive=other'}],['short tree',{sourceTree:'abc12345'}],['missing tree',{sourceTree:null}],['dirty',{dirty:true}],['unproven clean',{dirty:'false'}],['profile',{profile:'custom'}],['native build',{zeroNativeBuild:false}],
])test(`rejects invalid ${reason} provenance`,t=>assert.throws(()=>readSessionPin(fixture(t,{proof}))));
test('rejects missing native RTC export bytes, duplicate metadata and broken archives',t=>{
 for(const options of [{native:false},{duplicate:true},{transform:()=>Buffer.from('not gzip')},{transform:bytes=>bytes.subarray(0,bytes.length-10)}])assert.throws(()=>readSessionPin(fixture(t,options)));
});
test('rejects a bad tar checksum even when gzip is valid',t=>{
 const dir=fixture(t);writeFileSync(join(dir,'archives/session.tgz'),gzipSync(Buffer.alloc(1024,1)));assert.throws(()=>readSessionPin(dir),/TAR/);
});
test('requires a local in-checkout tarball pin',t=>{
 for(const pin of ['https://example.invalid/session.tgz','^1.0.0','file:../outside.tgz','file:/tmp/outside.tgz','file:archives/session.zip'])assert.throws(()=>readSessionPin(fixture(t,{pin})));
});
test('CLI appends only the exact safe source GitHub output before installation with no external commands',t=>{
 const dir=mkdtempSync(join(tmpdir(),'session-pin-output-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const output=join(dir,'output');writeFileSync(output,'existing=value\n');
 const result=spawnSync(process.execPath,[join(root,'scripts/session-pin.mjs')],{cwd:dir,env:{...process.env,PATH:'',GITHUB_OUTPUT:output},encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
 const pin=readSessionPin(root);assert.equal(readFileSync(output,'utf8'),`existing=value\nsource=${pin.source}\n`);
});
