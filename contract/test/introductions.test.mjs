import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerIntroductions, createPeersClient } from '../peers.mjs';

const local = 'ab'.repeat(32), remote = 'cd'.repeat(32), other = 'ef'.repeat(32);
const options = () => ({ signal: new AbortController().signal });
const route = identity => ({ kind: 'invitation', peerId: identity });
function fixture(overrides = {}, opener, options = {}) {
  const calls = [], openings = [], relayOpenings = [], channels = [];
  const peers = {
    watchDiscovery(identity, options) {
      calls.push(['watch', identity, options]);
      const ended = Promise.withResolvers();
      const close = () => { options.signal.removeEventListener('abort', close); ended.resolve(); };
      options.signal.addEventListener('abort', close, { once: true });
      return { ready: Promise.resolve(), notifications: { async *[Symbol.asyncIterator]() { yield {type:'ready'}; await ended.promise; } }, close };
    },
    async discover(value) { calls.push(['discover', value]); return { peers: [] }; },
    async advertise(value, options) { calls.push(['advertise', value, options]); },
    async withdraw(value, options) { calls.push(['withdraw', value, options]); },
    listenInvitations(identity, options) {
      calls.push(['listen', identity, options]);
      const stopped = Promise.withResolvers(); let closed = false;
      const close = () => { if (!closed) { closed = true; stopped.resolve(); calls.push(['closeListener']); } };
      options.signal.addEventListener('abort', close, { once: true });
      return { ready: Promise.resolve(), invitations: { async *[Symbol.asyncIterator]() { await stopped.promise; } }, close };
    },
    async invite(identity, value, options) { calls.push(['invite', identity, value, options]); },
    rendezvous(channel, identity, options) {
      calls.push(['rendezvous', channel, identity, options]);
      const signaling = { ready: Promise.resolve({ session: 'paired', role: 'answerer' }),
        messages: { async *[Symbol.asyncIterator]() {} }, async send() {}, close() { calls.push(['closeSignaling', channel]); } };
      channels.push(signaling); return signaling;
    },
    relay(channel, identity, options) {
      calls.push(['relay', channel, identity, options]);
      return { ready: Promise.resolve({ session: 'relay-paired' }), close() { calls.push(['closeRelay']); } };
    },
    ...overrides,
  };
  const connection = { async close() { calls.push(['closeConnection']); } };
  const ports = createPeerIntroductions({ peers, identity: local, openDirectConnection: opener ?? (async input => { openings.push(input); return connection; }),
    openRelayConnection: async input => { relayOpenings.push(input); return connection; }, ...options });
  return { ...ports, calls, openings, relayOpenings, channels, connection };
}

test('construction is inert and discovery pins only valid remote identities with supported routes', async () => {
  const advertisement = (peerId, routes) => ({ advertisement: { peerId, storageId: 'disk', routes } });
  const f = fixture({ async discover() { return { peers: [
    advertisement(local, [route(local)]), advertisement('untrusted-alias', [route('untrusted-alias')]),
    advertisement(remote, [{ kind: 'https', url: 'https://peer.test/' }, route(other), route(remote)]),
    advertisement(other, [{ kind: 'rendezvous', channel: 'join:other' }]),
    advertisement('01'.repeat(32), [{ kind: 'https', url: 'https://peer.test/' }]),
  ] }; } });
  assert.deepEqual(f.calls, []);
  const found = await f.discovery.read(options());
  assert.deepEqual(found, [{ identity: remote, route: route(remote) }, { identity: other, route: { kind: 'rendezvous', channel: 'join:other' } }]);
  assert.throws(() => { found[0].route.peerId = other; }, TypeError);
  assert.deepEqual(f.calls, []);
});

test('availability carries identity and routes only, forwards cancellation, and owns no renewal timer', async () => {
  const f = fixture(), controller = new AbortController(), selected = { signal: controller.signal };
  const notifications = f.discovery.notifications(selected)[Symbol.asyncIterator]();
  assert.deepEqual(await notifications.next(), {value:{type:'ready'},done:false});
  const reading = f.discovery.invitations(selected)[Symbol.asyncIterator]().next();
  await Promise.resolve(); f.calls.length = 0;
  await f.discovery.advertise({ identity: local, storageId: 'owned-disk', generation: 'never-published', point: { sequence: 9 } }, { ...selected });
  assert.deepEqual(f.calls, [['advertise', { peerId: local, storageId: 'owned-disk', routes: [route(local)] }, { ...selected }]]);
  await f.discovery.withdraw(selected);
  assert.deepEqual(f.calls[1], ['withdraw', local, selected]);
  await assert.rejects(f.discovery.advertise({ identity: remote, storageId: 'disk' }, { ...selected }), { code: 'invalid_introduction' });
  const stopped = new AbortController(); stopped.abort(Error('session closed'));
  for (const action of [() => f.discovery.read({ signal: stopped.signal }),
    () => f.discovery.withdraw({ signal: stopped.signal }),
    () => f.discovery.advertise({ identity: local, storageId: 'disk' }, { signal: stopped.signal })])
    await assert.rejects(action(), /session closed/);
  assert.equal(f.calls.length, 2);
  controller.abort(); await reading; await notifications.return();
});

test('outbound introduction uses a fresh channel, the paired role and closes host signaling after raw connection', async () => {
  const f = fixture(), selected = options(), peer = { identity: remote, route: route(remote) };
  assert.equal(await f.transport.open({ peer }, selected), f.connection);
  const [opened, invitation, closed] = f.calls;
  assert.equal(opened[0], 'rendezvous'); assert.equal(opened[2], local); assert.equal(opened[3].signal.aborted, false);
  assert.deepEqual(invitation, ['invite', remote, { channel: opened[1], requesterPeerId: local }, selected]);
  assert.deepEqual(closed, ['closeSignaling', opened[1]]);
  assert.deepEqual(f.openings, [{ role: 'answerer', signaling: f.channels[0], signal: opened[3].signal }]);
  await f.transport.open({ peer }, selected);
  assert.notEqual(f.calls[3][1], opened[1], 'A new transport attempt cannot reuse the previous pairing channel');
});

test('invitations translate to expected signing identities and close their listener on early exit', async () => {
  let closed = 0, listening;
  const f = fixture({ listenInvitations(identity, opts) {
    listening = { identity, opts };
    return { ready: Promise.resolve(), invitations: { async *[Symbol.asyncIterator]() {
      yield { channel: 'join:invalid', requesterPeerId: 'alias' };
      yield { channel: 'join:self', requesterPeerId: local };
      yield { channel: 'join:valid', requesterPeerId: remote };
      yield { channel: 'join:other', requesterPeerId: other };
    } }, close() { closed++; } };
  } });
  const selected = options(), received = [];
  for await (const invitation of f.discovery.invitations(selected)) { received.push(invitation); break; }
  assert.deepEqual(listening, { identity: local, opts: selected });
  assert.deepEqual(received, [{ peer: { identity: remote, route: route(remote) }, token: { channel: 'join:valid', requesterPeerId: remote } }]);
  assert.equal(closed, 1);
});

test('incoming and pre-opened rendezvous routes open once without sending another invitation', async () => {
  const f = fixture(), selected = options();
  await f.transport.open({ peer: { identity: remote, route: route(remote) }, invitation: { channel: 'join:received', requesterPeerId: remote } }, selected);
  await f.transport.open({ peer: { identity: remote, route: { kind: 'rendezvous', channel: 'join:ready' } } }, selected);
  assert.deepEqual(f.calls.map(call => [call[0], call[1]]), [
    ['rendezvous', 'join:received'], ['closeSignaling', 'join:received'], ['rendezvous', 'join:ready'], ['closeSignaling', 'join:ready'],
  ]);
  await assert.rejects(f.transport.open({ peer: { identity: remote, route: route(remote) },
    invitation: { channel: 'join:forged', requesterPeerId: other } }, selected), { code: 'invalid_introduction' });
  await assert.rejects(f.transport.open({ peer: { identity: remote, route: route(other) } }, selected), { code: 'invalid_introduction' });
  assert.equal(f.calls.length, 4);
});

test('failed invitations close signaling and cancellation closes a late connection without retries', async () => {
  const failing = fixture({ async invite() { throw Error('host unavailable'); } });
  await assert.rejects(failing.transport.open({ peer: { identity: remote, route: route(remote) } }, options()), /host unavailable/);
  assert.deepEqual(failing.calls.map(call => call[0]), ['rendezvous', 'closeSignaling']);
  const controller = new AbortController(); let lateClosed = 0;
  const cancelled = fixture({}, async () => { controller.abort(Error('session ended')); return { async close() { lateClosed++; } }; });
  await assert.rejects(cancelled.transport.open({ peer: { identity: remote, route: route(remote) } }, { signal: controller.signal }), /session ended/);
  assert.equal(lateClosed, 1);
  assert.deepEqual(cancelled.calls.map(call => call[0]), ['rendezvous', 'invite', 'closeSignaling']);
});

test('the actual host SDK suppresses cancelled discovery and invitation exchanges before HTTP', async () => {
  let requests = 0;
  const peers = createPeersClient({ base: 'https://host.test/api', applicationId: '01'.repeat(32), request: async () => { requests++; } });
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  const options = { signal: controller.signal };
  for (const action of [() => peers.discover(options), () => peers.withdraw(local, options),
    () => peers.advertise({ peerId: local, storageId: 'disk', routes: [route(local)] }, options),
    () => peers.invite(remote, { channel: 'join:cancelled', requesterPeerId: local }, options)])
    await assert.rejects(action(), /cancelled/);
  assert.equal(requests, 0);
});


test('advertising waits for the owned invitation listener acknowledgement and respects cancellation', async () => {
  const ready = Promise.withResolvers(), stopped = Promise.withResolvers();
  const controller = new AbortController(), selected = { signal: controller.signal };
  const f = fixture({ listenInvitations() {
    controller.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
    return { ready: ready.promise, invitations: { async *[Symbol.asyncIterator]() { await stopped.promise; } }, close() {} };
  } });
  const first = f.discovery.advertise({ identity: local, storageId: 'disk' }, { ...selected });
  await Promise.resolve(); assert.deepEqual(f.calls, [], 'No listener has started yet');
  const notifications = f.discovery.notifications(selected)[Symbol.asyncIterator]();
  await notifications.next(); f.calls.length = 0;
  const reading = f.discovery.invitations(selected)[Symbol.asyncIterator]().next();
  await Promise.resolve(); assert.deepEqual(f.calls, [], 'Opening a socket is not an acknowledgement');
  ready.resolve(); await first;
  assert.equal(f.calls[0][0], 'advertise');
  controller.abort(); await reading; await notifications.return();

  const cancelled = new AbortController();
  const waiting = f.discovery.advertise({ identity: local, storageId: 'disk' }, { signal: cancelled.signal });
  cancelled.abort(Error('session ended before listening'));
  await assert.rejects(waiting, /session ended before listening/);
  assert.equal(f.calls.length, 1);
});

test('one failed direct attempt falls back through the same channel and expected peer', async () => {
  const f = fixture({}, async () => { throw Error('ICE unavailable'); }), selected = options();
  assert.equal(await f.transport.open({ peer: { identity: remote, route: route(remote) } }, selected), f.connection);
  assert.deepEqual(f.calls.map(call => call[0]), ['rendezvous', 'invite', 'closeSignaling', 'relay']);
  const opened = f.calls[0], relayed = f.calls[3];
  assert.equal(relayed[1], opened[1]); assert.equal(relayed[2], local);
  assert.deepEqual(relayed[3], { remotePeerId: remote, signal: selected.signal });
  assert.equal(f.relayOpenings.length, 1); assert.equal(f.relayOpenings[0].signal, selected.signal);
});

test('an interrupted SDP exchange can use the relay without replacing the invitation', async () => {
  const calls = [], f = fixture({ rendezvous(channel) {
    calls.push(channel); return { ready: Promise.reject(Error('SDP service ended')), close() { calls.push('closed'); } };
  } });
  await f.transport.open({ peer: { identity: remote, route: route(remote) }, invitation: { channel: 'join:accepted', requesterPeerId: remote } }, options());
  assert.deepEqual(calls, ['join:accepted', 'closed']);
  assert.deepEqual(f.calls.map(call => call[0]), ['relay']); assert.equal(f.calls[0][1], 'join:accepted');
  assert.equal(f.openings.length, 0); assert.equal(f.relayOpenings.length, 1);
});

test('the direct deadline cancels the platform opener before the relay opens', async () => {
  let stopped = false;
  const f = fixture({}, async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true });
  }), { directTimeoutMs: 1 });
  await f.transport.open({ peer: { identity: remote, route: route(remote) } }, options());
  assert.equal(stopped, true); assert.equal(f.relayOpenings.length, 1);
});

test('an uncooperative direct opener stays owned until its late connection is closed', async () => {
  const pending = Promise.withResolvers(); let closed = false;
  const f = fixture({}, async () => pending.promise, { directTimeoutMs: 1 });
  const opening = f.transport.open({ peer: { identity: remote, route: route(remote) } }, options());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.relayOpenings.length, 0, 'Do not free the physical opening budget while the platform still owns work');
  pending.resolve({ async close() { closed = true; } });
  await opening; assert.equal(closed, true); assert.equal(f.relayOpenings.length, 1);
});

test('owner cancellation never opens a relay and failed relay framing closes both sockets', async () => {
  const controller = new AbortController();
  const f = fixture({}, async () => { controller.abort(Error('owner ended')); throw controller.signal.reason; });
  await assert.rejects(f.transport.open({ peer: { identity: remote, route: route(remote) } }, { signal: controller.signal }), /owner ended/);
  assert.equal(f.relayOpenings.length, 0);
  const failed = fixture({}, async () => { throw Error('direct failed'); }, { openRelayConnection: async () => { throw Error('relay framing failed'); } });
  await assert.rejects(failed.transport.open({ peer: { identity: remote, route: route(remote) } }, options()), /relay framing failed/);
  assert.deepEqual(failed.calls.map(call => call[0]), ['rendezvous', 'invite', 'closeSignaling', 'relay', 'closeRelay']);
});


test('discovery notifications are required, initial watch readiness gates advertise, and iterator return releases the watch', async () => {
  assert.throws(()=>fixture({watchDiscovery:undefined}), {code:'invalid_introduction'});
  const gate = Promise.withResolvers(), stop = new AbortController(); let watcherCloses = 0, watchOptions;
  const f = fixture({watchDiscovery(identity, options) {
    watchOptions = {identity,options};
    return {ready:gate.promise,notifications:{async *[Symbol.asyncIterator]() {await gate.promise; yield {type:'ready'}; yield {type:'changed'}; yield {type:'ready'};}},
      close(){watcherCloses++;}};
  }});
  const selected = {signal:stop.signal};
  const invitation = f.discovery.invitations(selected)[Symbol.asyncIterator]().next();
  await Promise.resolve(); f.calls.length=0;
  const advertising = f.discovery.advertise({identity:local,storageId:'disk'},selected);
  const events = f.discovery.notifications(selected)[Symbol.asyncIterator]();
  const initial = events.next(); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(f.calls,[]);
  assert.deepEqual(watchOptions,{identity:local,options:selected});
  gate.resolve(); assert.deepEqual(await initial,{value:{type:'ready'},done:false}); await advertising;
  assert.equal(f.calls[0][0],'advertise');
  assert.deepEqual(await events.next(),{value:{type:'changed'},done:false});
  assert.deepEqual(await events.next(),{value:{type:'ready'},done:false});
  assert.equal(f.calls.length,1,'The adapter must not advertise or read automatically on notification delivery');
  await events.return(); assert.equal(watcherCloses,1);
  const late = f.discovery.advertise({identity:local,storageId:'disk'},selected);
  stop.abort(Error('owner stopped')); await assert.rejects(late,/owner stopped/); await invitation;
});

test('duplicate notification readers, cancelled subscriptions and failure cleanup never create replacement watchers', async () => {
  const controller = new AbortController(); let closes = 0;
  const f = fixture({watchDiscovery() {return {ready:Promise.resolve(),notifications:{async *[Symbol.asyncIterator]() {
    yield {type:'ready'}; throw Error('subscription revoked');}},close(){closes++;}};}});
  const selected={signal:controller.signal}, first=f.discovery.notifications(selected)[Symbol.asyncIterator]();
  await first.next(); await assert.rejects(f.discovery.notifications(selected)[Symbol.asyncIterator]().next(),{code:'invalid_introduction'});
  await assert.rejects(first.next(),/subscription revoked/); assert.equal(closes,1);
  controller.abort(Error('already cancelled'));
  await assert.rejects(f.discovery.notifications(selected)[Symbol.asyncIterator]().next(),/already cancelled/);
  assert.equal(closes,1);
});

function notificationDriver() {
  const queue=[],stopped=Promise.withResolvers();let wake,ended=false;
  return {ready:Promise.resolve(),push(type){queue.push({type});wake?.();wake=undefined;},
    notifications:{async *[Symbol.asyncIterator](){while(!ended){if(queue.length){yield queue.shift();continue;}await new Promise(resolve=>{wake=resolve;});}}},
    close(){ended=true;wake?.();stopped.resolve();},closed:stopped.promise};
}
async function advertisingFixture(overrides={}) {
  const watch=notificationDriver(),controller=new AbortController();
  const f=fixture({watchDiscovery:()=>watch,...overrides}),selected={signal:controller.signal};
  const notifications=f.discovery.notifications(selected)[Symbol.asyncIterator]();
  const initial=notifications.next();watch.push('ready');await initial;
  const invitations=f.discovery.invitations(selected)[Symbol.asyncIterator]();const waiting=invitations.next();
  await Promise.resolve();
  return {...f,watch,selected,notifications,controller,
    async close(){controller.abort();await waiting;await notifications.return();},
  };
}

test('only effective confirmed advertisement payloads cause HTTP; changed metadata is inert and ready always invalidates',async()=>{
  const f=await advertisingFixture();
  const value={identity:local,storageId:'disk',point:{sequence:1},role:'coordinator'};
  await f.discovery.advertise(value,f.selected);
  await f.discovery.advertise({...value,point:{sequence:2},role:'follower',generation:'new-head'},f.selected);
  assert.equal(f.calls.filter(call=>call[0]==='advertise').length,1);
  const changed=f.notifications.next();f.watch.push('changed');assert.equal((await changed).value.type,'changed');
  await f.discovery.advertise(value,f.selected);assert.equal(f.calls.filter(call=>call[0]==='advertise').length,1);
  const reconnected=f.notifications.next();f.watch.push('ready');assert.equal((await reconnected).value.type,'ready');
  await f.discovery.advertise(value,f.selected);assert.equal(f.calls.filter(call=>call[0]==='advertise').length,2);
  await f.discovery.advertise({...value,storageId:'different-disk'},f.selected);
  assert.equal(f.calls.filter(call=>call[0]==='advertise').length,3);
  await f.discovery.withdraw(f.selected);await f.discovery.advertise({...value,storageId:'different-disk'},f.selected);
  assert.equal(f.calls.filter(call=>call[0]==='advertise').length,4);
  await f.close();
});

test('a lost advertisement response stays unconfirmed and an explicit retry sends the exact same payload',async()=>{
  const attempts=[];
  const f=await advertisingFixture({async advertise(value){attempts.push(value);if(attempts.length===1)throw Error('response lost');}});
  await assert.rejects(f.discovery.advertise({identity:local,storageId:'disk',point:1},f.selected),/response lost/);
  await f.discovery.advertise({identity:local,storageId:'disk',point:2},f.selected);
  assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);
  await f.discovery.advertise({identity:local,storageId:'disk',point:3},f.selected);assert.equal(attempts.length,2);
  await f.close();
});

test('invitation listener replacement invalidates confirmed availability even with unchanged wire routes',async()=>{
  const listeners=[];const f=await advertisingFixture({listenInvitations(){
    const closed=Promise.withResolvers();const listener={ready:Promise.resolve(),invitations:{async *[Symbol.asyncIterator](){await closed.promise;}},close:()=>closed.resolve()};
    listeners.push(listener);return listener;
  }});
  await f.discovery.advertise({identity:local,storageId:'disk'},f.selected);listeners[0].close();await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));
  const nextStop=new AbortController(),nextOptions={signal:nextStop.signal};
  const invitations=f.discovery.invitations(nextOptions)[Symbol.asyncIterator]();const waiting=invitations.next();await Promise.resolve();
  await f.discovery.advertise({identity:local,storageId:'disk'},f.selected);
  assert.equal(f.calls.filter(call=>call[0]==='advertise').length,2);
  listeners[1].close();await waiting;nextStop.abort();await f.close();
});

test('a response from before reconnect cannot confirm presence on the new watch generation',async()=>{
  const gate=Promise.withResolvers();let attempts=0;
  const f=await advertisingFixture({async advertise(){attempts++;if(attempts===1)await gate.promise;}});
  const pending=f.discovery.advertise({identity:local,storageId:'disk'},f.selected);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
  const reconnect=f.notifications.next();f.watch.push('ready');await reconnect;gate.resolve();await pending;
  await f.discovery.advertise({identity:local,storageId:'disk'},f.selected);assert.equal(attempts,2);
  await f.discovery.advertise({identity:local,storageId:'disk'},f.selected);assert.equal(attempts,2);
  await f.close();
});

test('an aborted acknowledgment or a failed changed payload cannot confirm any previous payload',async()=>{
  let attempts=0,abortAfterAck;
  const f=await advertisingFixture({async advertise(){attempts++;if(attempts===2)throw Error('changed payload uncertain');abortAfterAck?.abort(Error('caller ended'));}});
  await f.discovery.advertise({identity:local,storageId:'disk'},f.selected);
  await assert.rejects(f.discovery.advertise({identity:local,storageId:'other-disk'},f.selected),/uncertain/);
  await f.discovery.advertise({identity:local,storageId:'disk'},f.selected);assert.equal(attempts,3);
  abortAfterAck=new AbortController();
  await assert.rejects(f.discovery.advertise({identity:local,storageId:'other-disk'},{signal:abortAfterAck.signal}),/caller ended/);
  abortAfterAck=undefined;
  await f.discovery.advertise({identity:local,storageId:'other-disk'},f.selected);assert.equal(attempts,5);
  await f.close();
});

test('transport selection reports bounded metadata once, and observers cannot cause a relay', async () => {
  const events = [], peer = {identity:remote,route:route(remote)};
  const direct = fixture({}, undefined, {onTransport:value=>{events.push(value);throw Error('observer failed');}});
  await direct.transport.open({peer}, options());
  assert.deepEqual(events,[{peerId:remote,kind:'direct'}]);
  assert.equal(direct.relayOpenings.length,0);
  const fallback = fixture({}, async()=>{throw Error('RTC unavailable');}, {onTransport:value=>events.push(value)});
  await fallback.transport.open({peer}, options());
  assert.deepEqual(events.at(-1),{peerId:remote,kind:'relay',reason:'direct_failed'});
  assert.equal(fallback.relayOpenings.length,1);
  assert.throws(()=>fixture({},undefined,{onTransport:null}),{code:'invalid_introduction'});
});


test('rejecting asynchronous transport diagnostics cannot become an unhandled rejection', async () => {
  const direct = fixture({}, undefined, { onTransport: async () => { throw Error('asynchronous observer failed'); } });
  const connection = await direct.transport.open({peer:{identity:remote,route:route(remote)}},options());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(direct.relayOpenings.length,0);
  await connection.close();
});

test('direct-only upgrades invite the existing peer without scanning or opening another relay', async () => {
  const f = fixture();
  const connection = await f.transport.upgrade({peer:{identity:remote,route:null}},options());
  assert.equal(connection,f.connection);
  assert.deepEqual(f.transport.describe(connection),{kind:'direct'});
  assert.match(f.calls.find(call=>call[0]==='invite')[2].channel,/^direct:/);
  assert.equal(f.calls.some(call=>['discover','relay','advertise'].includes(call[0])),false);
});

test('failed and timed-out upgrades never open a relay', async () => {
  for (const timeout of [false,true]) {
    const f = fixture({}, async ({signal}) => {
      if (!timeout) throw Error('UDP_BLOCKED');
      await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    }, {directTimeoutMs:5});
    await assert.rejects(f.transport.upgrade({peer:{identity:remote,route:null}},options()));
    assert.equal(f.relayOpenings.length,0);
    assert.equal(f.calls.some(call=>call[0]==='closeSignaling'),true);
  }
});

test('an incoming direct replacement cannot accidentally fall back to relay', async () => {
  const f = fixture({},async()=>{throw Error('UDP_BLOCKED');});
  await assert.rejects(f.transport.open({peer:{identity:remote,route:route(remote)},invitation:{channel:'direct:replacement',requesterPeerId:remote}},options()),/UDP_BLOCKED/);
  assert.equal(f.relayOpenings.length,0);
});

test('diagnostics distinguish relay selection and never describe an unselected connection as direct', async () => {
  const f = fixture({},async()=>{throw Error('UDP_BLOCKED');});
  assert.deepEqual(f.transport.describe({}),{kind:'unknown'});
  const connection = await f.transport.open({peer:{identity:remote,route:route(remote)}},options());
  assert.deepEqual(f.transport.describe(connection),{kind:'relay',reason:'direct_failed'});
  assert.equal(Object.isFrozen(f.transport.describe(connection)),true);
});
