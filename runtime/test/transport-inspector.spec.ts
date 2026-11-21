import {test,expect,type Page} from '@playwright/test';
import {build} from 'esbuild';
const compiled=await build({stdin:{contents:"export {mountUtility} from './runtime/src/utility.ts';export {createTransportBinding} from './runtime/src/transport.ts';",resolveDir:new URL('../..',import.meta.url).pathname,loader:'ts'},bundle:true,format:'iife',globalName:'Inspector',platform:'browser',write:false});
async function fixture(page:Page,registered=true){
 await page.route('https://inspector.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Transport inspector</title><body><button>App</button></body>'}));
 await page.goto('https://inspector.test/');await page.addScriptTag({content:compiled.outputFiles[0].text});
 await page.evaluate(registered=>{
  const w=window as any;w.reads=0;w.hostReads=0;w.listeners=new Set();w.binding=w.Inspector.createTransportBinding();
  w.source={status:{phase:'connected',connectedPeers:['a'.repeat(64)],connectionRevision:0},onStatus(fn:any){w.listeners.add(fn);fn(this.status);return()=>w.listeners.delete(fn);},async diagnostics(){w.reads++;return[{peerId:'a'.repeat(64),kind:w.kind??'relay',reason:'direct_timeout',sentBytes:w.total??12,receivedBytes:9,sentReliableBytes:10,receivedReliableBytes:8,sentLiveBytes:2,receivedLiveBytes:1,sentRequests:1,receivedRequests:0,token:'DO_NOT_DISPLAY',address:'DO_NOT_DISPLAY'}];},reconsiderConnections(){throw Error('MUST_NOT_RECONSIDER');}};
  if(registered)w.binding.api.install(w.source);
  const noop=()=>()=>{};
  w.dispose=w.Inspector.mountUtility({transport:w.binding.api,identity:{base:'https://inspector.test/',version:1,publication:null,managementUrl:'https://inspector.test/manage'},publication:{pinned:false,onUpdate:noop},installation:{status:()=>({state:'unavailable',platform:'desktop'}),on:noop},sensors:{status:()=>({active:[],pending:[]}),on:noop,stopAll:()=>0}});
  w.fetch=()=>{w.hostReads++;throw Error('MUST_NOT_FETCH');};w.WebSocket=class{constructor(){w.hostReads++;throw Error('MUST_NOT_OPEN_SOCKET');}};
 },registered);
}
test('Page options shows only authenticated local evidence and samples again only on explicit action',async({page})=>{
 await page.clock.install();await fixture(page);expect(await page.evaluate(()=>(window as any).reads)).toBe(0);
 await page.clock.fastForward(3600_000);expect(await page.evaluate(()=>(window as any).reads)).toBe(0);
 await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});
 await expect(inspector).toContainText('1 authenticated peer');await expect(inspector).toContainText('Link 1: Relay (authenticated)');
 await expect(inspector).toContainText('Fallback reason: the direct attempt timed out.');await expect(inspector).toContainText('Reliable: 10 sent bytes');await expect(inspector).toContainText('Live: 2 sent bytes');
 await expect(inspector).toContainText('not billing');await expect(inspector).not.toContainText('DO_NOT_DISPLAY');await expect(inspector).not.toContainText('a'.repeat(64));
 expect(await page.evaluate(()=>(window as any).reads)).toBe(1);await page.clock.fastForward(3600_000);expect(await page.evaluate(()=>(window as any).reads)).toBe(1);
 await inspector.getByRole('button',{name:'Refresh connection details'}).click();expect(await page.evaluate(()=>(window as any).reads)).toBe(2);
 await page.evaluate(()=>{const w=window as any;w.source.status={phase:'connecting',connectedPeers:[],connectionRevision:1};for(const fn of w.listeners)fn(w.source.status);});
 await expect(inspector).toContainText('0 authenticated peers');await expect(inspector).not.toContainText('Link 1:');expect(await page.evaluate(()=>(window as any).hostReads)).toBe(0);
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Page options',exact:true})).toBeFocused();
});
test('unregistered details stay unavailable without claiming a relay or inventing counters',async({page})=>{
 await fixture(page,false);await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});await expect(inspector).toContainText('Connection details unavailable');
 await expect(inspector.getByRole('button',{name:'Refresh connection details'})).toBeDisabled();await expect(inspector).not.toContainText('0 bytes');expect(await page.evaluate(()=>(window as any).reads)).toBe(0);
});
test('disposed menu ignores an outstanding sample and removes its report observer',async({page})=>{
 await fixture(page);await page.evaluate(()=>{const w=window as any;w.source.diagnostics=()=>new Promise(resolve=>w.complete=resolve);});
 await page.getByRole('button',{name:'Page options',exact:true}).click();await expect.poll(()=>page.evaluate(()=>typeof(window as any).complete)).toBe('function');
 await page.evaluate(()=>{const w=window as any;w.dispose();w.complete([]);});await expect(page.locator('tendril-utility')).toHaveCount(0);
});


test('same-peer connection replacement updates the menu once and counters describe the replacement link',async({page})=>{
 await fixture(page);await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});await expect(inspector).toContainText('Link 1: Relay');
 await page.evaluate(()=>{const w=window as any;w.kind='direct';w.total=0;w.source.status={...w.source.status,connectionRevision:1};for(const fn of w.listeners)fn(w.source.status);});
 await expect(inspector).toContainText('Link 1: Direct');await expect(inspector).not.toContainText('Fallback reason:');await expect(inspector).toContainText('Sent: 0 bytes');
 expect(await page.evaluate(()=>(window as any).reads)).toBe(2);
 await page.evaluate(()=>{const w=window as any;w.total=500;for(const fn of w.listeners)fn(w.source.status);});
 expect(await page.evaluate(()=>(window as any).reads)).toBe(2);await expect(inspector).toContainText('Sent: 0 bytes');
 await inspector.getByRole('button',{name:'Refresh connection details'}).click();await expect(inspector).toContainText('Sent: 500 bytes');
});
