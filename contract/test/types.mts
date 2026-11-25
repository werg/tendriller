import type { RuntimeConfiguration, RuntimeApi, AgentRegistration } from '../index.mjs';
import { createAgentClient, registerAgent } from '../client.mjs';
const create: AgentRegistration = { owner: 'owner@example.test', handle: 'laptop', bio: 'Dev agent', publicKey: 'A'.repeat(43) };
const cfg: RuntimeConfiguration = { id: 'page', application: { id: '12'.repeat(32) }, base: '/p/', version: 0, documentPath: null, features: { speech: null, shared_by: 'Owner' } };
declare const runtime: RuntimeApi;
void runtime.application.ready(); void runtime.signals.ready(); void runtime.host.peers.application();
void runtime.agents.snapshot(); void runtime.agents.resolveHandle('@laptop');
void runtime.host.peers.application({ signal: new AbortController().signal });
void runtime.publication.saveOffline(); void runtime.sensors.stopAll();
void registerAgent('https://host.test', create);
const agent = createAgentClient({ service: 'https://host.test', token: 'ta_' });
void agent.updateProfile({ handle: 'atlas', bio: 'Primary' });
void agent.pages.create({ name: 'Notes' }); void agent.page('aaaaaaaaaaaa').peers.application();
const stream = agent.hub.socket('aaaaaaaaaaaa', 'setup/watch', ['tendriller.setup.v1']); stream.onmessage = event => void event.data;
// @ts-expect-error Agent registration names its public key explicitly.
const invalid: AgentRegistration = { owner: 'owner@example.test', handle: 'laptop' };
void cfg; void invalid;
