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
const documentHref: string = services.documentUrl('other.html#section');
void documentHref;
// @ts-expect-error URL references must be strings.
runtime.documentUrl({ path: 'other.html' });
void services;

const capabilityFilter = ['camera', 'bluetooth'] as const;
void runtime.capabilities(capabilityFilter);
const resource = runtime.sensors.register({ kind: 'serial', label: 'Bench meter', state: 'pending', async stop() {} });
const cancellation: AbortSignal = resource.signal;
resource.setState('active');
resource.unregister();
resource.unregister({ acknowledgeFailure: true });
// @ts-expect-error Failure acknowledgement must be an explicit options object.
resource.unregister(true);
// @ts-expect-error Arbitrary truthy acknowledgement values are not accepted.
resource.unregister({ acknowledgeFailure: 'yes' });
// @ts-expect-error False does not explicitly acknowledge a failure.
resource.unregister({ acknowledgeFailure: false });
// @ts-expect-error Phases are explicit.
resource.setState('complete');
// @ts-expect-error Cleanup is required.
runtime.sensors.register({ kind: 'serial' });
void cancellation;
