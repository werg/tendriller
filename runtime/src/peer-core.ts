import { createApplicationBinding } from "../../contract/application.mjs";
import type { ApplicationBackend, ApplicationSelection } from "../../contract/application.mjs";
import { loadDevice, saveDevice, guessName } from "./device";
import { createPageHost } from "./page-host";
import type { Bus, PeerCore, TendrilConfig } from "./types";

/**
 * A peer page has no hosted application machinery: no socket, outbox, polling,
 * console forwarding or health reports. Its installed backend owns all durable
 * application work. Host operations exist only as explicit calls.
 */
export function createPeerCore(cfg: TendrilConfig, selection: ApplicationSelection, bus: Bus, selectedBackend?: ApplicationBackend): PeerCore {
  const application = createApplicationBinding(selection, selectedBackend);
  const stored = loadDevice(cfg.id);
  if (!stored.name) { stored.name = guessName(); saveDevice(cfg.id, stored); }
  const device = Object.freeze({ id: stored.id, name: stored.name });
  const host = createPageHost(cfg, () => ({ "X-Tendril-Device": stored.id, "X-Tendril-Device-Secret": stored.secret }));
  let reported = false;
  // Installation availability is separate from session synchronization and authority.
  void application.ready().then(() => { bus.emit("application_ready"); });
  return {
    kind: "peer", host, bus, config: cfg, device, application,
    ready() { if (!reported) { reported = true; bus.emit("ready"); } },
  };
}
