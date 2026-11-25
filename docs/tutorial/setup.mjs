// One workspace lifecycle, no per-page CLI/signing process. The account agent
// and explicit page grants are managed by the public workspace tools.
import {cp,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {describeReadiness,requireCreationReady} from '@tendriller/core';
import {requireEmptyPageFolder,requireSlug,workspace,workspaceRoot} from './shared/local.mjs';
import {provisionPage} from './shared/helpers/page-provisioning.mjs';
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
 return{slug,id:page.id,page_url:page.page_url,template,next:`npm run init -- ${slug}, then npm run deploy -- ${slug}; publish before owner sign-in, without starting the optional native agent.`};
}
export async function run(action,args) {
 const{values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{template:{type:'string'},name:{type:'string'},events:{type:'boolean'},'browser-finalizer':{type:'boolean'}}});
 const[slug,file]=positionals;if(action==='new')return createPage(slug,values);
 const selected=await workspace(),context=await selected.pageContext(requireSlug(slug));
 if(action==='demo'){await pageModule(slug,'demo.mjs');return;}
 if(['sign-enrollment','provisioning-request','import-provisioning'].includes(action))return provisionPage(context,action,file);
 if(action==='init')return(await pageModule(slug,'setup.mjs')).initializePage(context,values['browser-finalizer']?{requestedFinality:{kind:'browser-signed-frontier'}}:{});
 if(action==='assistant')return(await pageModule(slug,'assistant.mjs')).prepareAssistant(context,{events:values.events});
 if(action==='build'||action==='deploy'){
  const{build}=await import('esbuild');const output=await(await pageModule(slug,'build.mjs')).buildPage(context,{bundle:build});
  if(action==='build')return{built:output,next:`npm run deploy -- ${slug}`};
  return(await pageModule(slug,'publish.mjs')).publishPage(context,{root:pathToFileURL(output.endsWith('/')?output:output+'/')});
 }
 throw Error('Use new, init, build, deploy, assistant, demo, sign-enrollment, provisioning-request, or import-provisioning with a page slug');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const result=await run(process.argv[2],process.argv.slice(3));if(result!==undefined)console.log(JSON.stringify(result,null,2));}catch(error){console.error(`${error.code??error.name}: ${error.message}`);process.exitCode=1;}}
