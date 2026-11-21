// Hosted bootstrap: headless protocol plus the small operational utility.
import { startRuntime } from "./kernel";
import { mountUtility } from "./utility";

if (!window.tendril) {
  const config = window.__TENDRIL__;
  if (!config) throw new Error("The Tendriller runtime requires an explicit page configuration.");
  // The hosted entry keeps the page on the latest selected release (one hibernating watch).
  const api = startRuntime(config, { watchPublication: true });
  Object.defineProperty(window, "tendril", { value: api, configurable: true, enumerable: true, writable: false });
  mountUtility(api);
}
