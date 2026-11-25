// This runs before npm/pnpm installation in CI: Node built-ins only.
import assert from 'node:assert/strict';
import {readFileSync,appendFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

// Explicit supplemental pin, never an inferred sibling archive. This reader is
// built-ins-only so CI can verify its bytes before installing dependencies.
export function readBrowserSqlPin(root=resolve(import.meta.dirname,'..')) {
 const config=JSON.parse(readFileSync(resolve(root,'scripts/sql-browser-session.json'),'utf8'));
 assert(typeof config.archive==='string'&&/^[A-Za-z0-9.][A-Za-z0-9._/-]*\.tgz$/.test(config.archive),'SQL_BROWSER_ARCHIVE_PIN_REQUIRED');
 assert.match(config.sha256??'',/^[a-f0-9]{64}$/,'SQL_BROWSER_ARCHIVE_HASH_REQUIRED');
 const archive=resolve(root,config.archive),within=relative(root,archive);
 assert(within&&!within.startsWith('..')&&!isAbsolute(within),'SQL_BROWSER_ARCHIVE_MUST_BE_IN_CHECKOUT');
 const actualWithin=relative(realpathSync(root),realpathSync(archive));
 assert(actualWithin&&!actualWithin.startsWith('..')&&!isAbsolute(actualWithin),'SQL_BROWSER_ARCHIVE_MUST_BE_IN_CHECKOUT');
 const bytes=readFileSync(archive);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),config.sha256,'SQL_BROWSER_ARCHIVE_HASH_MISMATCH');
 return Object.freeze({archive,sha256:config.sha256});
}

function archiveFiles(bytes){
 const tar=gunzipSync(bytes,{maxOutputLength:32*1024*1024}),files=new Map();
 for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))return files;
  const text=(start,end)=>header.subarray(start,end).toString('utf8').replace(/\0.*$/s,'');
  const octal=value=>{assert(/^[0-7]+$/.test(value.trim()),'INVALID_SESSION_TAR_NUMBER');return parseInt(value.trim(),8);};
  const sum=header.reduce((total,byte,index)=>total+(index>=148&&index<156?32:byte),0);
  assert.equal(sum,octal(text(148,156)),'INVALID_SESSION_TAR_CHECKSUM');
  const size=octal(text(124,136)),name=[text(345,500),text(0,100)].filter(Boolean).join('/').replace(/^\.\//,'');
  const type=text(156,157);offset+=512;assert(offset+size<=tar.length,'TRUNCATED_SESSION_TAR');
  if(type===''||type==='0'){assert(!files.has(name),'DUPLICATE_SESSION_TAR_ENTRY');files.set(name,tar.subarray(offset,offset+size));}
  offset+=Math.ceil(size/512)*512;
 }
 throw Error('TRUNCATED_SESSION_TAR');
}
export function validateSessionProvenance(proof){
 assert.equal(proof.format,'chronolog-peer-session-package/v1','INVALID_SESSION_PROVENANCE_FORMAT');
 assert.equal(proof.repository,'werg/chronolog-db','INVALID_SESSION_REPOSITORY');
 assert.match(proof.source,/^[a-f0-9]{40}$/,'EXACT_SESSION_SOURCE_REQUIRED');
 assert.match(proof.sourceTree,/^[a-f0-9]{40}$/,'EXACT_SESSION_TREE_REQUIRED');
 assert.equal(proof.dirty,false,'CLEAN_SESSION_SOURCE_REQUIRED');
 assert.equal(proof.profile,'chronolog-crdt-v1','STANDARD_SESSION_PROFILE_REQUIRED');
 assert.equal(proof.nativeRtc,true,'NATIVE_RTC_SESSION_REQUIRED');
 assert(Array.isArray(proof.sqlEngines)&&proof.sqlEngines.length===0,'SQL_FREE_SESSION_PIN_REQUIRED');
 return Object.freeze({source:proof.source});
}
export function readSessionPin(root=resolve(import.meta.dirname,'..')){
 const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')),pin=pkg.devDependencies?.['@chronolog/peer-session'];
 assert(typeof pin==='string'&&pin.startsWith('file:')&&pin.endsWith('.tgz'),'LOCAL_SESSION_ARCHIVE_PIN_REQUIRED');
 const archive=resolve(root,pin.slice(5)),within=relative(root,archive);
 assert(within&&!within.startsWith('..')&&!isAbsolute(within),'SESSION_ARCHIVE_MUST_BE_IN_CHECKOUT');
 const files=archiveFiles(readFileSync(archive));
 const json=name=>{assert(files.has('package/'+name),'SESSION_ARCHIVE_METADATA_MISSING');return JSON.parse(files.get('package/'+name).toString('utf8'));};
 const metadata=json('package.json'),proof=json('provenance.json'),result=validateSessionProvenance(proof);
 assert.equal(metadata.name,'@chronolog/peer-session','INVALID_SESSION_PACKAGE');
 const entry=metadata.exports?.['./webrtc-native'],native=typeof entry==='string'?entry:entry?.import??entry?.default;
 assert(typeof native==='string'&&native.startsWith('./')&&!native.split('/').includes('..')&&files.has('package/'+native.slice(2)),'NATIVE_RTC_EXPORT_REQUIRED');
 return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);
 assert(args.length===0||(args.length===1&&args[0]==='--sql-browser'),'Use session-pin.mjs [--sql-browser]');
 const pin=args.length ? readBrowserSqlPin() : readSessionPin();
 const output=args.length ? `archive=${pin.archive}\nsha256=${pin.sha256}\n` : `source=${pin.source}\n`;
 if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,output);
 else process.stdout.write(output);
}
