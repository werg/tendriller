import {copyFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
/** Only this page's dedicated dist/ is publishable; the shared signer and page
 * records remain under the workspace's private .tendriller/, never in assets. */
export async function buildPage(context,{root=new URL('./',import.meta.url),bundle}={}) {
 const output=new URL('./dist/',root);await rm(output,{recursive:true,force:true});
 try {
  const config=await context.readPrivate('host-configuration.json'),prepared=await context.readPrivate('prepared.json');
  if(prepared.applicationId!==context.page.applicationId||prepared.publisherKey!==context.signer.publicKey||prepared.executionManifestDigest!==config.executionManifestDigest)throw Error('Resume preparation for this exact workspace page; no native initialization is required');
  const pageUrl=new URL(context.page.pageUrl);if(!['https:','http:'].includes(pageUrl.protocol)||pageUrl.username||pageUrl.password||pageUrl.search||pageUrl.hash)throw Error('Invalid public page URL');
  await mkdir(output);await writeFile(new URL('configuration.json',output),JSON.stringify({applicationId:context.page.applicationId,page_url:context.page.pageUrl,serviceOrigin:context.service,pageId:context.page.id,executionManifestDigest:config.executionManifestDigest,optionalAnalysisPeer:context.signer.publicKey},null,2)+'\n');
  await copyFile(new URL('index.html',root),new URL('index.html',output));
  await bundle({absWorkingDir:fileURLToPath(root),entryPoints:{page:'page.mjs',worker:'worker.mjs'},outdir:fileURLToPath(output),bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',outExtension:{'.js':'.mjs'},chunkNames:'chunks/[name]-[hash]'});
  await bundle({absWorkingDir:fileURLToPath(root),entryPoints:['domain.mjs'],outfile:fileURLToPath(new URL('domain.js',output)),bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['@chronolog/peer-session']});
  return fileURLToPath(output);
 }catch(cause){await rm(output,{recursive:true,force:true});throw new Error(`Page build failed; no publishable dist/ remains. ${cause.message}`,{cause});}
}
