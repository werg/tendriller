import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { handleStdioMcpMessage, serveStdioMcp } from '../lib/mcp-stdio.mjs';

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { page: 'notes', ...args } } });
const pagesOf = owned => ({ list: async () => [{ slug: 'notes', id: 'aaaaaaaaaaaa' }], open: async page => { assert.equal(page, 'notes'); return owned; } });
const stored = operationId => ({ proposalId:'a'.repeat(64),operationId,stored:true,pending:'materializer',materialized:null,retained:[],finalized:false,excluded:false });
const mcp = (owned, message) => handleStdioMcpMessage(pagesOf(owned), message);
test('invalid complete batches submit no commands, including malformed later entries', async () => {
  let calls = 0;
  const owned = { session: { command: async () => { calls++; } } };
  for (const commands of [null, {}, [null], [{ command: 'add', input: {}, operationId: 'first' }, null]]) {
    const result = await handleStdioMcpMessage(pagesOf(owned), call('command_submit_batch', { commands }));
    assert.equal(result.result.isError, true);
  }
  assert.equal(calls, 0);
});
test('inspection preserves independent current facts without manufacturing a lifecycle', async () => {
  for (const state of [null, stored('original'), {...stored('original'),materialized:{outcome:'rejected',revision:{digest:'b'.repeat(64)}}}]) {
    const result = await mcp({ session: { operations:{get: async () => state && {inspect:()=>state}} } }, call('operation_inspect', { operationId:'original' }));
    assert.deepEqual(result.result.structuredContent,{operationId:'original',operation:state});
    assert.equal('lifecycle' in result.result.structuredContent,false);
  }
});
test('batch materialization wait failures preserve durable work and never assert rejection', async () => {
  const state = stored('original');
  const owned = { session: { command: async () => ({ materialized: async () => { throw Error('response lost'); } }), operations:{get:async()=>({inspect:()=>state})} } };
  const response = await mcp(owned, call('command_submit_batch', {commands:[{command:'add',input:{},operationId:'original'}],wait:'materialized'}));
  assert.deepEqual(response.result.structuredContent.results[0].operation,state);
  assert.equal(response.result.structuredContent.results[0].error.code,'operation_uncertain');
});
test('a lost command admission response remains inspectable under its original long identity', async () => {
  const operationId = 'scope#' + 'x'.repeat(506), state = stored(operationId);
  const response = await mcp({ session: {
    command: async () => { throw Error('admission reply lost'); }, operations:{get: async id => { assert.equal(id,operationId);return {inspect:()=>state}; }},
  } }, call('command_submit', { command:'add',input:{},operationId }));
  assert.deepEqual(response.result.structuredContent.operation,state);
  assert.equal(response.result.structuredContent.error.code,'operation_uncertain');
});
test('default command success acknowledges storage without network, materializer or finality waits',async()=>{
  const state=stored('original');let waits=0;
  const response=await mcp({session:{command:async()=>({id:state.proposalId,operationId:'original',inspect:()=>state,
    materialized:async()=>{waits++;throw Error('offline');},retained:async()=>{waits++;throw Error('offline');},finalized:async()=>{waits++;throw Error('unsupported');}})}},
    call('command_submit',{command:'add',input:{},operationId:'original'}));
  assert.equal(response.result.structuredContent.stored,true);assert.equal(response.result.structuredContent.materialized,null);assert.equal(waits,0);
});
test('no-finality explicit waits report unsupported while preserving the stored operation',async()=>{
  const state=stored('original');
  const response=await mcp({session:{operations:{get:async()=>({inspect:()=>state})},command:async()=>({
    finalized:async()=>{throw Object.assign(Error('No finality configured'),{code:'FINALITY_UNSUPPORTED'});}})}},
    call('command_submit',{command:'add',input:{},operationId:'original',wait:'finalized'}));
  assert.equal(response.result.structuredContent.error.code,'FINALITY_UNSUPPORTED');assert.equal(response.result.structuredContent.operation.stored,true);
});
test('stdio accepts cancellation while a tool awaits materialization without discarding stored work', async () => {
  const input = new PassThrough(), output = new PassThrough();let text='',submitted;
  const started=new Promise(resolve=>{submitted=resolve;});output.on('data',chunk=>{text+=chunk;});
  const state=stored('original');
  const owned={session:{command:async()=>({materialized:async({signal})=>{submitted();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}),operations:{get:async()=>({inspect:()=>state})}}};
  const serving=serveStdioMcp(pagesOf(owned),{input,output});
  input.write(JSON.stringify(call('command_submit',{command:'add',input:{},operationId:'original',wait:'materialized'}))+'\n');await started;
  input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}})+'\n');await new Promise(resolve=>output.once('data',resolve));input.end();await serving;
  const reply=JSON.parse(text.trim());assert.equal(reply.id,1);assert.equal(reply.result.structuredContent.operation.stored,true);
});
test('stdio bounds individual input frames', async () => {
  const input = new PassThrough(), output = new PassThrough();const serving = serveStdioMcp(pagesOf({session:{}}),{input,output});
  input.end('x'.repeat(1024*1024+1));await assert.rejects(serving,/exceeds 1 MiB/);
});

test('every page tool requires a page and pages_list needs none', async () => {
  const { TOOLS } = await import('../lib/mcp-stdio.mjs');
  for (const tool of TOOLS) {
    if (tool.name === 'pages_list') assert.deepEqual(tool.inputSchema.properties, {});
    else assert(tool.inputSchema.required.includes('page'), tool.name);
  }
  const listed = await handleStdioMcpMessage(pagesOf({}), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pages_list', arguments: {} } });
  assert.deepEqual(listed.result.structuredContent.pages, [{ slug: 'notes', id: 'aaaaaaaaaaaa' }]);
  const missing = await handleStdioMcpMessage(pagesOf({}), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'state_query', arguments: { query: 'notes' } } });
  assert.equal(missing.result.isError, true);
});
