// One workspace lifecycle, no per-page CLI/signing process. The account agent
// and explicit page grants are managed by the public workspace tools.
import {cp,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {describeReadiness,requireCreationReady} from '@tendriller/core';
import {requireEmptyPageFolder,requireSlug,workspace,workspaceRoot} from './shared/local.mjs';
export const TEMPLATES=Object.freeze(['notes','inventory']);
const templateRoot=new URL('./templates/',import.meta.url);
const pageModule=(slug,name)=>import(pathToFileURL(join(workspaceRoot,'pages',slug,name)).href);
export async function createPage(slug,{template='notes',name}={}) {
 requireSlug(slug);if(!TEMPLATES.includes(template))throw Error('Choose --template notes or inventory');
 const selected=await workspace();
 if(selected.config.pages?.[slug]){const page=await selected.page(slug);return{slug,id:page.id,page_url:page.page_url,resumed:true,next:`npm run init -- ${slug}`};}
 await requireEmptyPageFolder(slug);const origin=selected.config.service;
 requireCreationReady(await describeReadiness(origin),{service:origin});
 const source=new URL(template+'/',templateRoot);
 if(template==='inventory')await(await import(new URL('setup.mjs',source).href)).preflight(); // verifies browser WASM only
 await requireEmptyPageFolder(slug);
 const page=await selected.createPage(slug,{name:name??(template==='inventory'?'Shared inventory':'Shared notes')}),target=join(workspaceRoot,'pages',slug);
 for(const entry of await readdir(source))await cp(new URL(entry,source),join(target,entry),{recursive:true,errorOnExist:true,force:false});
 return{slug,id:page.id,page_url:page.page_url,template,next:`npm run init -- ${slug} (this agent creates the page keys), then npm run deploy -- ${slug}.`};
}
export async function run(action,args) {
 const{values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{template:{type:'string'},name:{type:'string'},events:{type:'boolean'},'browser-finalizer':{type:'boolean'},'browser-first':{type:'boolean'},'owner-grant':{type:'string'}}});
 const[slug]=positionals;if(action==='new')return createPage(slug,values);
 const selected=await workspace(),context=await selected.pageContext(requireSlug(slug));
 if(action==='demo'){await pageModule(slug,'demo.mjs');return;}
 if(action==='init'){
  const result=await(await pageModule(slug,'setup.mjs')).initializePage(context,{...(values['browser-finalizer']?{requestedFinality:{kind:'browser-signed-frontier'}}:{}),browserFirst:values['browser-first']===true||values['browser-finalizer']===true,...(values['owner-grant']===undefined?{}:{ownerGrant:values['owner-grant']})}); // a browser finalizer is the browser creator's key
  return{...result,next:result.creator==='agent'?`npm run deploy -- ${slug}, then give the owner the page URL. Keep npm run agent running so this agent admits the owner's browsers; it already holds this page's keys and can import data now.`:`npm run deploy -- ${slug}, then give the owner the page URL. Their first browser creates the page data; npm run agent is admitted from its signed grant once a holder is online.`};
 }
 if(action==='build'||action==='deploy'){
  const{build}=await import('esbuild');const output=await(await pageModule(slug,'build.mjs')).buildPage(context,{bundle:build});
  if(action==='build')return{built:output,next:`npm run deploy -- ${slug}`};
  return(await pageModule(slug,'publish.mjs')).publishPage(context,{root:pathToFileURL(output.endsWith('/')?output:output+'/')});
 }
 throw Error('Use new, init, build, deploy or demo with a page slug');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const result=await run(process.argv[2],process.argv.slice(3));if(result!==undefined)console.log(JSON.stringify(result,null,2));}catch(error){console.error(`${error.code??error.name}: ${error.message}`);process.exitCode=1;}}
