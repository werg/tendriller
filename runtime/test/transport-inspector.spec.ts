import {test,expect,type Page} from '@playwright/test';
import {build} from 'esbuild';
const compiled=await build({stdin:{contents:"export {mountUtility} from './runtime/src/utility.ts';export {createTransportBinding} from './runtime/src/transport.ts';",resolveDir:new URL('../..',import.meta.url).pathname,loader:'ts'},bundle:true,format:'iife',globalName:'Inspector',platform:'browser',write:false});
async function fixture(page:Page,registered=true,roster:any[]=[],admission:any=null){
 await page.route('https://inspector.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Transport inspector</title><body><button>App</button></body>'}));
 await page.goto('https://inspector.test/');await page.addScriptTag({content:compiled.outputFiles[0].text});
 await page.evaluate(([registered,roster,admission])=>{
  const w=window as any;w.reads=0;w.hostReads=0;w.listeners=new Set();w.binding=w.Inspector.createTransportBinding();
  w.source={status:{phase:'connected',connectedPeers:['a'.repeat(64)],connectionRevision:0},onStatus(fn:any){w.listeners.add(fn);fn(this.status);return()=>w.listeners.delete(fn);},async diagnostics(){w.reads++;return w.peers.map((peerId:string,index:number)=>({connectionId:'link-'+index,peerId,kind:w.kind??'relay',reason:'direct_timeout',sentReliableBytes:w.total??10,receivedReliableBytes:143_445,sentLiveBytes:2,receivedLiveBytes:1,token:'DO_NOT_DISPLAY',address:'DO_NOT_DISPLAY'}));},reconsiderConnections(){throw Error('MUST_NOT_RECONSIDER');}};
  w.peers=['a'.repeat(64)];if(admission)w.source.extensions={async call(){return admission;},subscribe(){return()=>{};}};
  if(registered)w.binding.api.install(w.source);
  const noop=()=>()=>{};w.roster={primary_agent_id:null,agents:roster,live:{}};w.rosterListeners=new Set();
  const agents={snapshot:()=>w.roster,onChange(fn:any){w.rosterListeners.add(fn);return()=>w.rosterListeners.delete(fn);}};
  w.dispose=w.Inspector.mountUtility({transport:w.binding.api,agents,identity:{base:'https://inspector.test/',version:1,publication:null,managementUrl:'https://inspector.test/manage'},publication:{pinned:false,onUpdate:noop},installation:{status:()=>({state:'unavailable',platform:'desktop'}),on:noop},sensors:{status:()=>({active:[],pending:[]}),on:noop,stopAll:()=>0}});
  w.fetch=()=>{w.hostReads++;throw Error('MUST_NOT_FETCH');};w.WebSocket=class{constructor(){w.hostReads++;throw Error('MUST_NOT_OPEN_SOCKET');}};
 },[registered,roster,admission] as const);
}
test('Page options shows only authenticated local evidence and samples again only on explicit action',async({page})=>{
 await page.clock.install();await fixture(page);expect(await page.evaluate(()=>(window as any).reads)).toBe(0);
 await page.clock.fastForward(3600_000);expect(await page.evaluate(()=>(window as any).reads)).toBe(0);
 await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});
 await expect(inspector).toContainText('Connected to 1 device.');await expect(inspector).toContainText('Device 1');
 await expect(inspector).toContainText('Via relay (a direct connection timed out)');await expect(inspector).toContainText('Received 143 KB · Sent 12 B');
 const technical=inspector.getByText('Technical details');const lanes=inspector.getByText('reliable 10 B sent');
 await expect(lanes).toBeHidden();await technical.focus();await page.keyboard.press('Enter');await expect(lanes).toBeVisible();
 await expect(inspector).toContainText('live 2 B sent, 1 B received');await expect(inspector).toContainText('not billing figures');
 await expect(inspector).not.toContainText('DO_NOT_DISPLAY');await expect(inspector).not.toContainText('a'.repeat(64));await expect(inspector).not.toContainText('unavailable');
 expect(await page.evaluate(()=>(window as any).reads)).toBe(1);await page.clock.fastForward(3600_000);expect(await page.evaluate(()=>(window as any).reads)).toBe(1);
 await inspector.getByRole('button',{name:'Refresh connection details'}).click();expect(await page.evaluate(()=>(window as any).reads)).toBe(2);
 await page.evaluate(()=>{const w=window as any;w.source.status={phase:'connecting',connectedPeers:[],connectionRevision:1};for(const fn of w.listeners)fn(w.source.status);});
 await expect(inspector).toContainText('Connecting… Your changes are saved on this device.');await expect(inspector).not.toContainText('Device 1');expect(await page.evaluate(()=>(window as any).hostReads)).toBe(0);
 await page.evaluate(()=>{const w=window as any;w.source.status={phase:'disconnected',connectedPeers:[],connectionRevision:1};for(const fn of w.listeners)fn(w.source.status);});
 await expect(inspector.locator('[aria-live=polite]')).toHaveText('Not connected. Your changes are saved on this device and will sync when a device or your agent is online.');
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Page options',exact:true})).toBeFocused();
});
test('a link to a page agent shows its public handle, follows roster changes and never the key',async({page})=>{
 await fixture(page,true,[{id:'ag',handle:'notekeeper',bio:'',public_key:'a'.repeat(64),kind:'workspace',is_primary:true,granted_at:0}]);
 await page.evaluate(()=>{(window as any).kind='direct';});
 await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});
 await expect(inspector.getByRole('list',{name:'Connected devices'})).toContainText('@notekeeper');await expect(inspector).toContainText('Direct connection');
 await expect(inspector).not.toContainText('Via relay');await expect(inspector).not.toContainText('a'.repeat(64));
 await page.evaluate(()=>{const w=window as any;w.roster={...w.roster,agents:[]};for(const fn of w.rosterListeners)fn(w.roster);});
 await expect(inspector).toContainText('Device 1');await expect(inspector).not.toContainText('@notekeeper');expect(await page.evaluate(()=>(window as any).reads)).toBe(1);
});
test('admission state names the viewer\'s other devices and other members by verified email, never by key',async({page})=>{
 const own='a'.repeat(64),friend='b'.repeat(64),guest='c'.repeat(64),self='f'.repeat(64);
 await fixture(page,true,[],{accounts:['acct-owner'],members:[{publicKey:self,self:true,via:'attested',subject:'device',label:'Browser device',accountId:'acct-owner'},
  {publicKey:own,via:'attested',subject:'device',label:'Browser device',accountId:'acct-owner',email:'owner@example.test',activation:String(Date.UTC(2026,10,3,12)),administrator:true},
  {publicKey:friend,via:'invited',subject:'device',label:'Browser device',accountId:'acct-friend',email:'friend@example.test'},
  {publicKey:guest,via:'invited',subject:'device',label:'Browser device',accountId:'acct-guest'}]});
 await page.evaluate(([own,friend,guest])=>{const w=window as any;w.peers=[own,friend,guest];w.source.status={phase:'connected',connectedPeers:w.peers,connectionRevision:0};for(const fn of w.listeners)fn(w.source.status);},[own,friend,guest]);
 await page.getByRole('button',{name:'Page options',exact:true}).click();
 const list=page.getByRole('region',{name:'Application connections'}).getByRole('list',{name:'Connected devices'});
 await expect(list.getByRole('listitem')).toHaveCount(3);
 await expect(list.getByRole('listitem').nth(0)).toContainText(/Your other device \(added .*2026\)/);
 await expect(list.getByRole('listitem').nth(0).getByTitle(/^Administrator/)).toHaveText('Admin');
 await expect(list.getByRole('listitem').nth(1)).toContainText('friend@example.test');await expect(list.getByRole('listitem').nth(1)).not.toContainText('Admin');await expect(list.getByRole('listitem').nth(2)).toContainText('Member 1');
 for(const key of[own,friend,guest])await expect(page.getByRole('region',{name:'Application connections'})).not.toContainText(key.slice(0,8));
});
test('the inspector stays readable at 320px without horizontal scrolling',async({page})=>{
 await page.setViewportSize({width:320,height:720});await fixture(page);await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});await expect(inspector).toContainText('Device 1');
 await inspector.getByText('Technical details').click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const box=await inspector.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(320);
});
test('unregistered details stay unavailable without claiming a relay or inventing counters',async({page})=>{
 await fixture(page,false);await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});await expect(inspector).toContainText('Connection details are not available on this page.');
 await expect(inspector.getByRole('button',{name:'Refresh connection details'})).toBeDisabled();await expect(inspector).not.toContainText('0 B');expect(await page.evaluate(()=>(window as any).reads)).toBe(0);
});
test('disposed menu ignores an outstanding sample and removes its report observer',async({page})=>{
 await fixture(page);await page.evaluate(()=>{const w=window as any;w.source.diagnostics=()=>new Promise(resolve=>w.complete=resolve);});
 await page.getByRole('button',{name:'Page options',exact:true}).click();await expect.poll(()=>page.evaluate(()=>typeof(window as any).complete)).toBe('function');
 await page.evaluate(()=>{const w=window as any;w.dispose();w.complete([]);});await expect(page.locator('tendril-utility')).toHaveCount(0);
});


test('same-peer connection replacement updates the menu once and counters describe the replacement link',async({page})=>{
 await fixture(page);await page.getByRole('button',{name:'Page options',exact:true}).click();
 const inspector=page.getByRole('region',{name:'Application connections'});await expect(inspector).toContainText('Via relay');
 await page.evaluate(()=>{const w=window as any;w.kind='direct';w.total=0;w.source.status={...w.source.status,connectionRevision:1};for(const fn of w.listeners)fn(w.source.status);});
 await expect(inspector).toContainText('Direct connection');await expect(inspector).not.toContainText('Via relay');await expect(inspector).toContainText('Sent 2 B');
 expect(await page.evaluate(()=>(window as any).reads)).toBe(2);
 await page.evaluate(()=>{const w=window as any;w.total=500;for(const fn of w.listeners)fn(w.source.status);});
 expect(await page.evaluate(()=>(window as any).reads)).toBe(2);await expect(inspector).toContainText('Sent 2 B');
 await inspector.getByRole('button',{name:'Refresh connection details'}).click();await expect(inspector).toContainText('Sent 502 B');
});
