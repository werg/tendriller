// Consume one verified Worker artifact; never install the contrib tool graph.
import {readFileSync, mkdirSync, rmSync, writeFileSync, realpathSync} from 'node:fs';
import {resolve, join, isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {CONTRACT_VERSION, CORE_RELEASE} from '../contract/index.mjs';
const root=resolve(import.meta.dirname,'..');
const lock=JSON.parse(readFileSync(join(root,'composition.lock.json'),'utf8'));
if(lock.format!=='tendriller-composition'||lock.contract!==CONTRACT_VERSION)throw Error('Composition does not match the core contract.');
if(lock.core?.version!==CORE_RELEASE)throw Error('Composition selects a different core release.');
const archive=resolve(root,lock.workflow.file);
if(!archive.startsWith(root+'/composition/'))throw Error('Workflow archive must be an explicitly vendored composition artifact.');
const bytes=readFileSync(archive), digest=createHash('sha256').update(bytes).digest('hex');
if(digest!==lock.workflow.sha256)throw Error('Trusted workflow archive integrity check failed.');
const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
for(const entry of entries)if(isAbsolute(entry)||entry.split('/').includes('..'))throw Error('Unsafe archive entry.');
// Reject links/devices as well as traversal before extraction.
const details=execFileSync('tar',['-tvzf',archive],{encoding:'utf8'}).trim().split('\n');
if(details.some(line=>!['-','d'].includes(line[0])))throw Error('Workflow archive may contain only regular files and directories.');
const destination=join(root,'.composition/workflows');rmSync(destination,{recursive:true,force:true});mkdirSync(destination,{recursive:true});
execFileSync('tar',['-xzf',archive,'--no-same-owner','--no-same-permissions','-C',destination]);
const manifest=JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8'));
if(manifest.format!=='tendriller-workflows'||manifest.requires.contract!==CONTRACT_VERSION)throw Error('Workflow artifact requires a different contract.');
if(manifest.version!==lock.workflow.version)throw Error('Workflow artifact version differs from the selected release.');
if(JSON.stringify(manifest.interfaces)!==JSON.stringify(lock.workflow.interfaces))throw Error('Workflow artifact interfaces differ from the selected composition.');
if(lock.workflow.source_commit&&manifest.source_commit!==lock.workflow.source_commit)throw Error('Workflow source provenance differs from the selected composition.');
if(!Array.isArray(manifest.files)||!manifest.files.some(file=>file.path==='index.mjs'))throw Error('Workflow manifest must account for its executable entry.');
for(const file of manifest.files){
 const path=resolve(destination,file.path);
 if(!path.startsWith(realpathSync(destination)+'/'))throw Error('Unsafe workflow manifest path.');
 if(createHash('sha256').update(readFileSync(path)).digest('hex')!==file.sha256)throw Error('Workflow file integrity check failed.');
}
writeFileSync(join(root,'.composition/pin.ts'),`export const implementationVersion = ${JSON.stringify(digest)};\n`);
mkdirSync(join(root,'dist/service'),{recursive:true});
const result=await build({entryPoints:[join(root,'composition/entry.ts')],outfile:join(root,'dist/service/worker.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers'],metafile:true,logLevel:'warning'});
writeFileSync(join(root,'dist/service/inputs.json'),JSON.stringify(Object.keys(result.metafile.inputs).sort(),null,2)+'\n');
writeFileSync(join(root,'dist/service/pairing.json'),JSON.stringify({format:'tendriller-release-pair',core:lock.core,contract:CONTRACT_VERSION,workflow:lock.workflow},null,2)+'\n');
console.log(`Built trusted composition ${digest}`);
