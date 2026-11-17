import { createApplicationBinding } from "../../contract/application.mjs";
import type { ApplicationBackend, ApplicationSelection } from "../../contract/application.mjs";
import { loadDevice, saveDevice, guessName } from "./device";
import { createPageHost } from "./page-host";
import type { Bus, Core, Device, Role, TendrilConfig } from "./types";

const unavailable = (): never => {
  throw Object.assign(new Error("Use the selected application backend for application data"), { code: "application_backend" });
};
const unsupported = <T>(): T => new Proxy(Object.freeze({}), { get: unavailable }) as T;

/**
 * A peer page has no hosted application machinery: no socket, outbox, polling,
 * console forwarding or health reports. Its installed backend owns all durable
 * application work. Host operations exist only as explicit calls.
 */
export function createPeerCore(cfg: TendrilConfig, selection: ApplicationSelection, bus: Bus, selectedBackend?: ApplicationBackend) {
  const application = createApplicationBinding(selection, selectedBackend);
  const stored = loadDevice(cfg.id);
  if (!stored.name) { stored.name = guessName(); saveDevice(cfg.id, stored); }
  const device: Device = { id: stored.id, role: (stored.role as Role) || "owner", name: stored.name, pending: false };
  const host = createPageHost(cfg, () => ({ "X-Tendril-Device": stored.id, "X-Tendril-Device-Secret": stored.secret }));
  let reported = false;
  const health = {
    ready() { if (!reported) { reported = true; bus.emit("ready"); } },
    manual() {},
    get reported() { return reported; },
  };
  // Installation availability is separate from session synchronization and peer
  // reachability. A peer runtime never claims a hosted application connection.
  void application.ready().then(() => { bus.emit("application_ready"); });
  const core: Core & { readonly rev: number; health: typeof health } = {
    ...host, bus, config: cfg, device, application, health,
    get connected() { return false; },
    presence: null, transcript: [], welcome: null, rev: 0, service: null,
    state: unsupported<Core["state"]>(), timers: unsupported<Core["timers"]>(),
    streams: unsupported<Core["streams"]>(), records: unsupported<Core["records"]>(),
    scopes: { list: unavailable, capture: unavailable },
    conversation: { entries: unavailable, send: async () => unavailable(), presented: unavailable },
    send: async () => unavailable(), instruction: async () => unavailable(),
    transportRequest: async () => unavailable(), raw: unavailable,
    upload: async () => unavailable(), uploadEvent: async () => unavailable(),
    setBlobRetention: async () => unavailable(), retryCapture: async () => unavailable(), discardCapture: async () => unavailable(),
    captures: () => [], pendingWork: () => ({ events: 0, state: 0, captures: 0, timers: 0 }),
    ready: health.ready, readyManual: health.manual,
  };
  return core;
}
