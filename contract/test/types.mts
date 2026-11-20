import type { RuntimeConfiguration, RuntimeApi, CreateRequest } from '../index.mjs';
import { createClient, createPage } from '../client.mjs';
const create: CreateRequest = { owner: 'owner@example.test', application: { id: '12'.repeat(32) } };
const cfg: RuntimeConfiguration = { id: 'page', application: create.application!, base: '/p/', version: 0, documentPath: null, features: { speech: null, shared_by: 'Owner' } };
declare const runtime: RuntimeApi;
void runtime.application.ready(); void runtime.signals.ready(); void runtime.host.peers.application();
void runtime.host.peers.application({ signal: new AbortController().signal });
void runtime.publication.saveOffline(); void runtime.sensors.stopAll();
void createPage('https://host.test', create); void createClient({ api: 'https://host.test/api/page', token: 'secret' });
// @ts-expect-error Application selection never chooses an alternate implementation.
const invalid: CreateRequest = { owner: 'owner@example.test', application: { kind: 'cloudflare', id: 'page' } };
void cfg; void invalid;
