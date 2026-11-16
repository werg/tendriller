// Hosted bootstrap: headless protocol plus the small operational utility.
import { startRuntime } from "./kernel";
import { mountUtility } from "./utility";

if (!window.tendril) {
  const config = window.__TENDRIL__;
  if (!config) throw new Error("The Tendriller runtime requires an explicit page configuration.");
  const api = startRuntime(config);
  Object.defineProperty(window, "tendril", { value: api, configurable: true, enumerable: true, writable: false });
  mountUtility(api);
}
