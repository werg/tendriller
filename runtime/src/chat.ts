import type {
  PagePersonEntry,
  RuntimeChat,
  RuntimeChatActivity,
  RuntimeChatMessage,
  RuntimeChatProvider,
  RuntimeChatSendInput,
  RuntimeChatSnapshot,
  RuntimeChatStream,
} from "../../contract/index.mjs";
import type { TendrilConfig } from "./types";

const HANDLE_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function sanitizeHandle(raw: string): string {
  const cleaned = String(raw ?? "").trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 32);
  return HANDLE_RE.test(cleaned) ? cleaned : "you";
}

export interface ChatStore {
  readonly api: RuntimeChat;
  readonly provider: RuntimeChatProvider | null;
  setModalVisible(open: boolean): void;
}

/**
 * Inert, zero-network reactive chat state shared between the page and the
 * floating Talk / Assistant modal. Keeps voice/speech code out of the kernel.
 */
export function createChatStore(cfg: TendrilConfig): ChatStore {
  const handleKey = `tendril:user-handle:${cfg.id}`;
  let storedHandle: string | null = null;
  try {
    const saved = localStorage.getItem(handleKey);
    if (saved && HANDLE_RE.test(saved)) storedHandle = saved;
  } catch { /* blocked storage */ }

  let provider: RuntimeChatProvider | null = null;
  let title = "Assistant";
  let messages: RuntimeChatMessage[] = [];
  let streams: RuntimeChatStream[] = [];
  let activity: RuntimeChatActivity[] = [];
  let people: PagePersonEntry[] = [];
  let userHandle = storedHandle ?? "you";
  let unreadCount = 0;
  let lastIncomingAt = 0;
  let targetId: string | null | "*" = null;
  let presence: RuntimeChatSnapshot["presence"] = undefined;
  let modalVisible = false;
  const seenIds = new Set<string>();
  let seeded = false;

  const listeners = new Set<(snap: RuntimeChatSnapshot) => void>();
  const openListeners = new Set<(open: boolean) => void>();

  const snapshot = (): RuntimeChatSnapshot => Object.freeze({
    connected: provider !== null,
    title,
    messages: Object.freeze(messages.slice()),
    streams: Object.freeze(streams.slice()),
    activity: Object.freeze(activity.slice()),
    people: Object.freeze(people.slice()),
    userHandle,
    unreadCount,
    lastIncomingAt,
    targetId,
    ...(presence ? { presence: Object.freeze({ ...presence }) } : {}),
  });

  const emit = () => {
    const snap = snapshot();
    for (const listener of listeners) {
      try { listener(snap); } catch { /* Listener errors cannot break chat updates. */ }
    }
  };

  const apiImpl: RuntimeChat = {
    snapshot,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get hasProvider() {
      return provider !== null;
    },
    register(next: RuntimeChatProvider) {
      provider = next;
      if (next.title) title = next.title;
      emit();
      return () => {
        if (provider === next) {
          provider = null;
          emit();
        }
      };
    },
    setMessages(next) {
      let incoming = 0;
      for (const msg of next) {
        if (!seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          if (seeded && !modalVisible && !msg.isSelf && msg.role !== "system" && (msg.role === "agent" || msg.senderRole === "owner" || msg.senderRole === "guest")) {
            incoming++;
          }
        }
      }
      seeded = true;
      messages = next.map(m => Object.freeze({ ...m }));
      if (incoming > 0) {
        unreadCount += incoming;
        lastIncomingAt = Date.now();
      }
      emit();
    },
    setStreams(next) {
      streams = next.filter(s => s.text && s.text.trim()).map(s => Object.freeze({ ...s }));
      emit();
    },
    setActivity(items) {
      activity = items.map(a => Object.freeze({ ...a }));
      emit();
    },
    setPeople(next) {
      people = next.map(p => Object.freeze({ ...p }));
      if (!storedHandle) {
        const self = people.find(p => p.is_self);
        if (self?.handle) userHandle = sanitizeHandle(self.handle);
      }
      emit();
    },
    setPresence(next) {
      presence = next ? { ...next } : undefined;
      emit();
    },
    setTarget(next) {
      targetId = next;
      try { provider?.onSelectTarget?.(next); } catch { /* ignore */ }
      emit();
    },
    setUserHandle(raw) {
      const next = sanitizeHandle(raw);
      storedHandle = next;
      userHandle = next;
      try { localStorage.setItem(handleKey, next); } catch { /* ignore */ }
      emit();
    },
    notifyIncoming(info) {
      if (info?.id) seenIds.add(info.id);
      if (!modalVisible) {
        unreadCount++;
        lastIncomingAt = Date.now();
        emit();
      }
    },
    clearUnread() {
      if (unreadCount === 0 && lastIncomingAt === 0) return;
      unreadCount = 0;
      emit();
    },
    async send(input: RuntimeChatSendInput) {
      if (!provider) {
        throw new Error("No chat session is connected on this page yet.");
      }
      await provider.onSend(input);
    },
    onOpenRequest(listener) {
      openListeners.add(listener);
      return () => { openListeners.delete(listener); };
    },
    open() {
      for (const l of openListeners) { try { l(true); } catch { /* ignore */ } }
    },
    close() {
      for (const l of openListeners) { try { l(false); } catch { /* ignore */ } }
    },
  };
  const api: RuntimeChat = Object.freeze(apiImpl);

  return {
    api,
    get provider() { return provider; },
    setModalVisible(open: boolean) {
      modalVisible = open;
      if (open && unreadCount > 0) {
        unreadCount = 0;
        emit();
      }
    },
  };
}
