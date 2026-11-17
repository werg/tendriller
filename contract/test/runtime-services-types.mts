import type { RuntimeApi, RuntimeServices } from '../index.mjs';
declare const runtime: RuntimeApi;
const services: RuntimeServices = runtime;
runtime.on('sensors', status => { const active: string[] = status.active; void active; });
runtime.on('application_ready', () => {});
void runtime.application.ready(); void runtime.signals.ready();
// @ts-expect-error Connection and replication state belong to the installed application session.
runtime.connected;
// @ts-expect-error There is no hosted outbox.
runtime.pendingWork();
// @ts-expect-error The page host does not execute application state.
runtime.state;
// @ts-expect-error There is no profile discriminator.
runtime.kind;
// @ts-expect-error Signing device identity belongs to the installed session.
runtime.device;
// @ts-expect-error Application events belong to the installed session.
runtime.on('state_result', () => {});
// @ts-expect-error Host services are explicit.
runtime.peers;
void services;
