import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Writable} from 'node:stream';
import {createCliLifetime} from '../../docs/tutorial/helpers/cli-lifetime.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function runtime(stdout) {
 const process=new EventEmitter(),chunks=[];
 process.stdout=stdout??new Writable({write(_chunk,_encoding,done){done();}});
 process.stderr=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done();}});
 return{process,chunks};
}
function assertClean(f){assert.equal(f.process.listenerCount('SIGINT'),0);assert.equal(f.process.listenerCount('SIGTERM'),0);assert.equal(f.process.stdout.listenerCount('error'),0);assert.equal(f.process.stderr.listenerCount('error'),0);}
test('ordinary abort with verified owner close succeeds; cleanup failure after abort remains nonzero',async()=>{
 const f=runtime(),cli=createCliLifetime({runtime:f.process});cli.opened();f.process.emit('SIGTERM');cli.closed();cli.fail(cli.signal.reason);
 assert.equal(await cli.finish(),0);assert.equal(f.chunks.join(''),'');assertClean(f);
 const bad=runtime(),failed=createCliLifetime({runtime:bad.process});failed.opened();bad.process.emit('SIGINT');failed.fail(Error('cleanup failed'));
 assert.equal(await failed.finish(),1);assert.match(bad.chunks.join(''),/cleanup failed/);assert.match(bad.chunks.join(''),/cleanup is unverified/);assertClean(bad);
});
test('an aborted cleanup rejecting with the abort reason cannot be mislabeled as successful cleanup',async()=>{
 const f=runtime(),cli=createCliLifetime({runtime:f.process});cli.opened();f.process.emit('SIGTERM');cli.fail(cli.signal.reason);
 assert.equal(await cli.finish(),1);assert.match(f.chunks.join(''),/cleanup is unverified/);assertClean(f);
});
test('finish waits for earlier stdout writes, then flushes stderr and preserves an existing nonzero code',async()=>{
 const gate=Promise.withResolvers(),written=[];let calls=0;
 const stdout=new Writable({write(chunk,_encoding,done){written.push(chunk.toString());if(++calls===1)gate.promise.then(()=>done());else done();}});
 const f=runtime(stdout),cli=createCliLifetime({runtime:f.process});f.process.exitCode=7;cli.opened();stdout.write('retained original operation receipt');cli.closed();let done=false;
 const result=cli.finish().then(code=>{done=true;return code;});await flush();assert.equal(done,false);gate.resolve();assert.equal(await result,7);assert.equal(written.join(''),'retained original operation receipt');assertClean(f);
});
for(const mode of ['timeout','sync-throw','broken-pipe'])test(`flush ${mode} is nonzero and clears all listeners/deadline timers`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const clear=t.mock.method(globalThis,'clearTimeout');
 let stdout;
 if(mode==='timeout'){stdout=new EventEmitter();stdout.write=()=>true;}
 if(mode==='sync-throw'){stdout=new EventEmitter();stdout.write=()=>{throw Error('stream write threw');};}
 if(mode==='broken-pipe')stdout=new Writable({write(_chunk,_encoding,done){done(Object.assign(Error('broken pipe'),{code:'EPIPE'}));}});
 const f=runtime(stdout),cli=createCliLifetime({runtime:f.process,flushTimeoutMs:50});cli.opened();cli.closed();const result=cli.finish();
 if(mode==='timeout')t.mock.timers.tick(50);
 assert.equal(await result,1);assert.match(f.chunks.join(''),/output was not fully flushed/);assertClean(f);assert.equal(clear.mock.callCount(),2,'both stdout/stderr flush deadlines are cleared');
 // No delayed deadline may mutate status or attach another error listener.
 const before=f.chunks.join('');t.mock.timers.tick(10000);assert.equal(f.chunks.join(''),before);assertClean(f);
});
test('even a non-Error rejection is failure; the helper never calls process.exit',async()=>{
 const f=runtime();f.process.exit=()=>{throw Error('embedding must not exit');};const cli=createCliLifetime({runtime:f.process});cli.fail(undefined);
 assert.equal(await cli.finish(),1);assertClean(f);
});


test('a broken output pipe during the CLI lifetime aborts its owner and stays nonzero after verified cleanup',async()=>{
 const f=runtime(),cli=createCliLifetime({runtime:f.process});cli.opened();
 f.process.stdout.emit('error',Object.assign(Error('output pipe failed'),{code:'EPIPE'}));assert.equal(cli.signal.aborted,true);
 cli.closed();cli.fail(cli.signal.reason);assert.equal(await cli.finish(),1);assertClean(f);
});
test('a broken diagnostic pipe during failure reporting cannot bypass stdout flushing or crash cleanup',async()=>{
 const stdoutChunks=[],f=runtime(new Writable({write(chunk,_enc,done){stdoutChunks.push(chunk.toString());done();}}));
 f.process.stderr=new Writable({write(_chunk,_enc,done){done(Object.assign(Error('stderr pipe failed'),{code:'EPIPE'}));}});
 const cli=createCliLifetime({runtime:f.process});cli.opened();cli.closed();cli.fail(Error('owned cleanup failure'));
 assert.equal(await cli.finish(),1);assert.equal(stdoutChunks.length,1);assertClean(f);
});


test('interrupted preparation/opening without a verified owner close is not a successful result',async()=>{
 const f=runtime(),cli=createCliLifetime({runtime:f.process});f.process.emit('SIGTERM');cli.fail(cli.signal.reason);
 assert.equal(await cli.finish(),1);assertClean(f);
});


test('an output error arriving after stdout flushed but before stderr flushed remains nonzero',async()=>{
 const f=runtime(),gate=Promise.withResolvers();
 f.process.stderr=new Writable({write(_chunk,_encoding,done){gate.promise.then(()=>done());}});
 const cli=createCliLifetime({runtime:f.process});cli.opened();cli.closed();const result=cli.finish();await flush();
 f.process.stdout.emit('error',Object.assign(Error('late output failure'),{code:'EPIPE'}));gate.resolve();
 assert.equal(await result,1);assertClean(f);
});
