import { createApplicationBinding } from "../../contract/application.mjs";
import type { ApplicationBackend } from "../../contract/application.mjs";
import { loadDevice, saveDevice, guessName } from "./device";
import { createPageHost } from "./page-host";
import type { Bus, RuntimeCore, TendrilConfig } from "./types";

export function createBus(): Bus {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  return {
    on(type, listener) {
      let current = listeners.get(type);
      if (!current) listeners.set(type, current = new Set());
      current.add(listener);
      return () => { current.delete(listener); };
    },
    emit(type, payload) {
      for (const listener of [...listeners.get(type) ?? []]) {
        try { listener(payload); } catch (error) { setTimeout(() => { throw error; }); }
      }
    },
  };
}

/** The page binds one owned application session and exposes explicit host services. */
export function createCore(config: TendrilConfig, backend?: ApplicationBackend): RuntimeCore {
  const application = createApplicationBinding(config.application, backend), bus = createBus();
  const stored = loadDevice(config.id);
  if (!stored.name) { stored.name = guessName(); saveDevice(config.id, stored); }
  const device = Object.freeze({ id: stored.id, name: stored.name });
  const host = createPageHost(config, () => ({ "X-Tendril-Device": stored.id, "X-Tendril-Device-Secret": stored.secret }));
  let ready = false;
  void application.ready().then(() => { bus.emit("application_ready"); });
  return { host, bus, config, device, application,
    ready() { if (!ready) { ready = true; bus.emit("ready"); } },
  };
}
