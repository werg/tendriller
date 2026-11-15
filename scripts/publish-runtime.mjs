// Retain each immutable runtime in the existing FILES bucket before deploying.
import {readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyRuntimeManifest} from './runtime-manifest.mjs';
const root=resolve(import.meta.dirname,'..');
const at=process.argv.indexOf('--config');
if(at<0||!process.argv[at+1])throw Error('Usage: node scripts/publish-runtime.mjs --config server/wrangler.<environment>.jsonc');
const configPath=resolve(root,process.argv[at+1]);
const config=JSON.parse(readFileSync(configPath,'utf8').replace(/^\s*\/\/.*$/gm,''));
const bucket=config.r2_buckets?.find(binding=>binding.binding==='FILES')?.bucket_name;
if(!bucket)throw Error('The selected deployment has no FILES bucket.');
const directory=join(root,'dist/runtime/assets'),manifest=verifyRuntimeManifest(JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')));
const files=[...manifest.assets,{path:'manifest.json',type:'application/json'}];
for(const file of files){
 const path=resolve(directory,file.path);
 if(!path.startsWith(directory+'/'))throw Error('Unsafe runtime asset path.');
 const bytes=readFileSync(path);
 if(file.sha256&&createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error(`Runtime integrity check failed: ${file.path}`);
 execFileSync(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),'r2','object','put',`${bucket}/runtime/${manifest.id}/${file.path}`,'--file',path,'--content-type',file.type,'--cache-control','public, max-age=31536000, immutable','--remote','--config',configPath],{cwd:root,stdio:'inherit'});
}
console.log(`Retained runtime ${manifest.id} (${files.length} immutable files).`);
