import type { PublicationManifest } from "../../contract/index.mjs";

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/** A successful worker acknowledgement means the exact required graph is durable. */
export async function savePublicationOffline(base: string, publication?: PublicationManifest): Promise<{ id: string; status: "ready" }> {
  if (!publication || !("serviceWorker" in navigator)) throw failure("offline_unavailable", "This page has no offline publication support");
  const expectedScope = new URL(base, location.href).href;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let registration: ServiceWorkerRegistration;
  try {
    const pending = (async () => {
      const known = await navigator.serviceWorker.getRegistration(expectedScope);
      if (known?.active && known.scope === expectedScope) return known;
      const ready = await navigator.serviceWorker.ready;
      if (ready.scope !== expectedScope) throw failure("offline_unavailable", "The page's service worker is not active");
      return ready;
    })();
    registration = await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure("offline_timeout", "Offline support did not become ready")), 10000);
    })]);
  } finally { clearTimeout(timer); }
  if (!registration.active) throw failure("offline_unavailable", "The page's service worker is not active");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    timer = setTimeout(() => { finish(); reject(failure("offline_timeout", "Saving the publication timed out")); }, 30000);
    channel.port1.onmessage = event => {
      const message = event.data;
      if (message?.t !== "publication" || message.id !== publication.id) return;
      finish();
      if (message.status === "ready") resolve({ id: publication.id, status: "ready" });
      else reject(failure(message.error?.code || "publication_save_failed", message.error?.message || "Could not save this publication"));
    };
    try { registration.active!.postMessage({ t: "publication", publication }, [channel.port2]); }
    catch (error) { finish(); reject(error); }
  });
}
