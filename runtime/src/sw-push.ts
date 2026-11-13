// Service worker push handling (PROTOCOL section 10). Owned by the push agent.
// Imported by runtime/src/sw.ts, which calls registerPushHandlers(self).
// Payload from the server: {"title","body","url","tag","tendril":"<id>"}.

interface PushPayload { title?: string; body?: string; url?: string; tag?: string; tendril?: string }

export function registerPushHandlers(self: any): void {
  const sw = self as ServiceWorkerGlobalScope;
  const scope = (): string => sw.registration?.scope || sw.location.origin + "/";

  // Only same-origin URLs inside the tendril's scope are opened; anything else falls back to the scope.
  const resolveUrl = (url?: string): string => {
    const s = scope();
    if (!url) return s;
    try {
      const u = new URL(url, s);
      return u.origin === new URL(s).origin && u.href.startsWith(s) ? u.href : s;
    } catch { return s; }
  };

  sw.addEventListener("push", (event: PushEvent) => {
    let p: PushPayload = {};
    try { p = event.data ? (event.data.json() as PushPayload) : {}; }
    catch { try { p = { body: event.data?.text() }; } catch { /* ignore */ } }
    const title = typeof p.title === "string" && p.title ? p.title : "Tendril";
    const opts: NotificationOptions = {
      body: typeof p.body === "string" ? p.body : "",
      data: { url: p.url ? resolveUrl(p.url) : null, tendril: p.tendril ?? null },
    };
    if (p.tag) { opts.tag = String(p.tag); (opts as any).renotify = true; }
    event.waitUntil(sw.registration.showNotification(title, opts));
  });

  sw.addEventListener("notificationclick", (event: NotificationEvent) => {
    event.notification.close();
    const explicit: string | null = event.notification.data?.url ?? null;
    const target = resolveUrl(explicit ?? undefined);
    event.waitUntil((async () => {
      const s = scope();
      const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = (all as WindowClient[]).filter((c) => c.url.startsWith(s));
      // Prefer a window already showing the target, then any window of this tendril.
      const client = mine.find((c) => c.url === target) ?? mine.find((c) => c.focused) ?? mine[0];
      if (client) {
        let c: WindowClient | null = client;
        // Without an explicit url just focus the window where it is.
        if (explicit && client.url !== target && "navigate" in client) {
          try { c = (await client.navigate(target)) ?? client; } catch { c = client; } // navigate needs a controlled client
        }
        try { await (c ?? client).focus(); return; } catch { /* fall through to openWindow */ }
      }
      if (sw.clients.openWindow) await sw.clients.openWindow(target);
    })());
  });
}
