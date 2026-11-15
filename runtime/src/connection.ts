import type { RuntimeSocket } from "../../contract/index.mjs";

export interface ConnectionClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

interface ConnectionHost {
  url(): string;
  hello(): unknown;
  message(message: { t: string; [key: string]: any }): void;
  disconnected(wasConnected: boolean): void;
}

interface ConnectionOptions {
  socket?: (url: string) => RuntimeSocket;
  clock?: ConnectionClock;
  random?: () => number;
}

const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const WELCOME_TIMEOUT_MS = 15_000;

/** Socket lifecycle only. Welcomes, state, commands and stream replay stay with callers. */
export function createConnection(host: ConnectionHost, options: ConnectionOptions = {}) {
  const openSocket = options.socket || (url => new WebSocket(url) as unknown as RuntimeSocket);
  const clock = options.clock || globalThis;
  const random = options.random || Math.random;
  let socket: RuntimeSocket | null = null;
  let started = false, connected = false, attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (message: unknown): boolean => {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  };

  const clearWelcome = () => {
    if (welcomeTimer !== undefined) clock.clearTimeout(welcomeTimer);
    welcomeTimer = undefined;
  };
  const clearPong = () => {
    if (pongTimer !== undefined) clock.clearTimeout(pongTimer);
    pongTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (retryTimer !== undefined) return;
    const base = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 10));
    retryTimer = clock.setTimeout(() => { retryTimer = undefined; connect(); }, base / 2 + random() * base / 2);
  };

  const connect = () => {
    if (socket || !started) return;
    let current: RuntimeSocket;
    try { current = openSocket(host.url()); } catch { scheduleReconnect(); return; }
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      send(host.hello());
      welcomeTimer = clock.setTimeout(() => {
        if (socket === current && !connected) current.close();
      }, WELCOME_TIMEOUT_MS);
    };
    current.onmessage = event => {
      if (socket !== current) return;
      // Any received frame proves the connection is responsive, as before.
      clearPong();
      let message: any;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
      if (message && typeof message.t === "string") {
        try { host.message(message); }
        catch (error) { console.warn("[tendril] failed to handle", message.t, error); }
      }
    };
    current.onerror = () => {};
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      const wasConnected = connected;
      connected = false;
      clearWelcome();
      clearPong();
      if (pingTimer !== undefined) clock.clearInterval(pingTimer);
      pingTimer = undefined;
      try { host.disconnected(wasConnected); } finally { scheduleReconnect(); }
    };
  };

  return {
    get connected() { return connected; },
    start() { started = true; connect(); },
    reconnect() {
      if (socket) return;
      if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
      retryTimer = undefined;
      attempts = 0;
      connect();
    },
    /** Called after the domain handler has installed its welcome snapshot. */
    welcome() {
      if (!socket) return;
      const current = socket;
      clearWelcome();
      attempts = 0;
      connected = true;
      if (pingTimer !== undefined) clock.clearInterval(pingTimer);
      pingTimer = clock.setInterval(() => {
        if (socket !== current || !connected) return;
        send({ t: "ping" });
        if (pongTimer === undefined) pongTimer = clock.setTimeout(() => {
          if (socket !== current) return;
          pongTimer = undefined;
          current.close();
        }, PONG_TIMEOUT_MS);
      }, PING_MS);
    },
    send,
    close(code?: number, reason?: string) { socket?.close(code, reason); },
  };
}
