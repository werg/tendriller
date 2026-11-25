import {
  awaitOwnedTask
} from "./chunk-KSC4KBWO.mjs";
import {
  PEER_LIVE_MESSAGE_LIMITS,
  PEER_MESSAGE_LIMITS,
  framePeerMessageChannels
} from "./chunk-MCU2YKH4.mjs";

// packages/transport-webrtc/src/live.ts
function requireRtcLiveChannel(channel) {
  if (channel.ordered || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== 0)
    throw new Error("WEBRTC_LIVE_CHANNEL_REQUIRED");
}

// packages/transport-webrtc/src/channel.ts
var WEBRTC_LIMITS = Object.freeze({ ...PEER_MESSAGE_LIMITS, sdpBytes: 64 * 1024, gatheringMs: 1e3 });
function requireReliable(channel) {
  if (!channel.ordered || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null)
    throw new Error("WEBRTC_RELIABLE_ORDERED_REQUIRED");
}
function frameRtcPeerChannels(channels, options = {}) {
  requireReliable(channels.reliable);
  requireRtcLiveChannel(channels.live);
  return framePeerMessageChannels(channels, options);
}

// packages/transport-webrtc/src/route.ts
async function observeWebRtcRoute(connection) {
  const unknown = { route: "unknown", localCandidateType: null, remoteCandidateType: null };
  if (connection.connectionState !== "connected" || connection.getStats === void 0) return unknown;
  try {
    const report = await connection.getStats(), stats = /* @__PURE__ */ new Map();
    report.forEach((value) => {
      if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") {
        stats.set(value.id, value);
      }
    });
    const selected = [...stats.values()].filter((value) => value.type === "transport" && typeof value.selectedCandidatePairId === "string");
    let pair;
    if (selected.length === 1) pair = stats.get(selected[0].selectedCandidatePairId);
    else if (selected.length === 0) {
      const pairs = [...stats.values()].filter((value) => value.type === "candidate-pair" && value.selected === true);
      if (pairs.length === 1) pair = pairs[0];
    }
    if (connection.connectionState !== "connected" || pair?.type !== "candidate-pair" || pair.state !== "succeeded") return unknown;
    const local = typeof pair.localCandidateId === "string" ? stats.get(pair.localCandidateId) : void 0;
    const remote = typeof pair.remoteCandidateId === "string" ? stats.get(pair.remoteCandidateId) : void 0;
    const localCandidateType = local?.type === "local-candidate" ? candidateType(local.candidateType) : null;
    const remoteCandidateType = remote?.type === "remote-candidate" ? candidateType(remote.candidateType) : null;
    const route2 = localCandidateType === "relay" || remoteCandidateType === "relay" ? "relay" : localCandidateType !== null && remoteCandidateType !== null ? "direct" : "unknown";
    return { route: route2, localCandidateType, remoteCandidateType };
  } catch {
    return unknown;
  }
}
function candidateType(value) {
  return value === "host" || value === "srflx" || value === "prflx" || value === "relay" ? value : null;
}

// packages/transport-webrtc/src/negotiation.ts
var PROTOCOL = "chronolog.peer.v2";
async function negotiateWebRtc(options) {
  const timeoutMs = options.timeoutMs ?? 3e4;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12e4) throw new Error("WEBRTC_TIMEOUT_INVALID");
  const gatheringMs = options.gatheringTimeoutMs ?? Math.min(WEBRTC_LIMITS.gatheringMs, timeoutMs);
  if (!Number.isSafeInteger(gatheringMs) || gatheringMs < 1 || gatheringMs > timeoutMs) throw new Error("WEBRTC_GATHERING_TIMEOUT_INVALID");
  let connection;
  try {
    options.signal?.throwIfAborted();
    const factory = options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration));
    connection = factory(structuredClone(options.configuration ?? {}));
  } catch (error) {
    void Promise.resolve().then(() => options.signaling.close()).catch(() => void 0);
    throw error;
  }
  const controller = new AbortController(), signal = controller.signal;
  let negotiationFailed = false;
  let closing, outcome;
  let negotiationError;
  let sentMessages = 0, receivedMessages = 0, sentBytes = 0, receivedBytes = 0;
  const close = () => {
    if (closing !== void 0) return closing;
    controller.abort(new Error("WEBRTC_CONNECTION_CLOSED"));
    options.signal?.removeEventListener("abort", abort);
    connection.removeEventListener("datachannel", dataChannel);
    connection.removeEventListener("connectionstatechange", failed);
    closing = Promise.resolve().then(() => connection.close());
    return closing;
  };
  const abort = () => {
    controller.abort(options.signal?.reason);
    void close().catch(() => void 0);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const failed = () => {
    if (["failed", "closed"].includes(connection.connectionState)) {
      controller.abort(new Error("WEBRTC_CONNECTION_FAILED"));
      void close().catch(() => void 0);
    }
  };
  connection.addEventListener("connectionstatechange", failed);
  const dataChannel = (event) => {
    const unexpected = event.channel;
    unexpected.close();
    controller.abort(new Error("WEBRTC_CHANNEL_UNEXPECTED"));
    void close().catch(() => void 0);
  };
  connection.addEventListener("datachannel", dataChannel);
  if (options.signal?.aborted === true) abort();
  const timeout = setTimeout(() => controller.abort(new Error("WEBRTC_NEGOTIATION_TIMEOUT")), timeoutMs);
  let descriptions;
  const receivedDescription = async (type) => {
    const item = await interruptible(descriptions.next(), signal);
    if (item.done) throw new Error("WEBRTC_SIGNALING_ENDED");
    const description2 = validateDescription(item.value, type);
    receivedMessages += 1;
    receivedBytes += new TextEncoder().encode(description2.sdp).length;
    return description2;
  };
  const publish = async (type) => {
    const complete = await gatherBatch(connection, gatheringMs, signal);
    const description2 = validateDescription(connection.localDescription, type);
    if (!complete && !usableCandidate(description2.sdp, options.configuration?.iceTransportPolicy)) throw new Error("WEBRTC_ICE_CANDIDATES_UNAVAILABLE");
    await interruptible(options.signaling.send(description2), signal);
    sentMessages += 1;
    sentBytes += new TextEncoder().encode(description2.sdp).length;
  };
  try {
    const channels = {
      reliable: connection.createDataChannel("chronolog.reliable", { negotiated: true, id: 0, ordered: true, protocol: PROTOCOL }),
      live: connection.createDataChannel("chronolog.live", { negotiated: true, id: 1, ordered: false, maxRetransmits: 0, protocol: PROTOCOL })
    };
    const returned = options.onDataChannels(channels);
    if (typeof returned === "object" && returned !== null && "then" in returned) {
      void Promise.resolve(returned).catch(() => void 0);
      throw new Error("WEBRTC_CHANNEL_HANDOFF_MUST_BE_SYNCHRONOUS");
    }
    descriptions = options.signaling.messages[Symbol.asyncIterator]();
    if (options.role === "offerer") {
      await interruptible(connection.setLocalDescription(await interruptible(connection.createOffer(), signal)), signal);
      await publish("offer");
      await interruptible(connection.setRemoteDescription(await receivedDescription("answer")), signal);
    } else {
      await interruptible(connection.setRemoteDescription(await receivedDescription("offer")), signal);
      await interruptible(connection.setLocalDescription(await interruptible(connection.createAnswer(), signal)), signal);
      await publish("answer");
    }
    await waitFor(connection, "connectionstatechange", () => connection.connectionState === "connected", signal);
    signal.throwIfAborted();
    outcome = {
      connection,
      signal,
      signaling: { sentMessages, receivedMessages, sentBytes, receivedBytes },
      getRoute: () => observeWebRtcRoute(connection),
      close
    };
  } catch (error) {
    negotiationFailed = true;
    negotiationError = error;
    await close().catch(() => void 0);
  }
  try {
    await interruptible(Promise.resolve().then(() => options.signaling.close()), signal);
  } catch (error) {
    await close().catch(() => void 0);
    if (!negotiationFailed) {
      negotiationFailed = true;
      negotiationError = error;
    }
  }
  clearTimeout(timeout);
  void Promise.resolve().then(() => descriptions?.return?.()).catch(() => void 0);
  if (negotiationFailed) throw negotiationError;
  if (outcome === void 0) throw new Error("WEBRTC_NEGOTIATION_INCOMPLETE");
  return outcome;
}
async function openWebRtcConnection(options) {
  const deadline = Date.now() + (options.timeoutMs ?? 3e4);
  let framed;
  const session = await negotiateWebRtc({ ...options, onDataChannels(channels) {
    framed = frameRtcPeerChannels(channels);
  } });
  if (framed === void 0) {
    await session.close();
    throw new Error("WEBRTC_CHANNEL_MISSING");
  }
  const selected = framed;
  const retire = () => {
    void session.close().catch(() => void 0);
  };
  selected.signal.addEventListener("abort", retire, { once: true });
  if (selected.signal.aborted) retire();
  const handshake = new AbortController();
  const timer = setTimeout(() => handshake.abort(new Error("WEBRTC_HANDSHAKE_TIMEOUT")), Math.max(1, deadline - Date.now()));
  try {
    await interruptible(selected.ready, AbortSignal.any([handshake.signal, session.signal]));
  } catch (error) {
    await selected.close();
    await session.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    ready: selected.ready,
    signal: selected.signal,
    session,
    live: selected.live,
    get stats() {
      return selected.stats;
    },
    send: (bytes, sendOptions) => selected.send(bytes, sendOptions),
    frames: (signal) => selected.frames(signal),
    async close() {
      await selected.close();
      await session.close();
    }
  };
}
function validateDescription(value, type) {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== type || !("sdp" in value) || typeof value.sdp !== "string" || value.sdp.length < 1 || new TextEncoder().encode(value.sdp).length > WEBRTC_LIMITS.sdpBytes) {
    throw new Error("WEBRTC_DESCRIPTION_INVALID");
  }
  return { type, sdp: value.sdp };
}
function interruptible(operation, signal) {
  if (signal.aborted) {
    void operation.catch(() => void 0);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
function waitFor(connection, event, complete, signal) {
  signal.throwIfAborted();
  if (complete()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      connection.removeEventListener(event, check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => {
      if (complete()) {
        cleanup();
        resolve();
      }
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    connection.addEventListener(event, check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}
function gatherBatch(connection, budgetMs, signal) {
  signal.throwIfAborted();
  if (connection.iceGatheringState === "complete") return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", check);
      signal.removeEventListener("abort", abort);
    };
    const finish = () => {
      cleanup();
      resolve(connection.iceGatheringState === "complete");
    };
    const check = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(finish, budgetMs);
    connection.addEventListener("icegatheringstatechange", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}
function usableCandidate(sdp, policy) {
  return sdp.split(/\r?\n/u).some((line) => {
    const fields = line.trim().split(/\s+/u), port = Number(fields[5]);
    return fields[0]?.startsWith("a=candidate:") === true && fields[6] === "typ" && ["udp", "tcp"].includes(fields[2]?.toLowerCase() ?? "") && Number.isInteger(port) && port > 0 && port <= 65535 && fields[4] !== void 0 && !["0.0.0.0", "::", "0:0:0:0:0:0:0:0"].includes(fields[4]) && ["host", "srflx", "prflx", "relay"].includes(fields[7] ?? "") && (policy !== "relay" || fields[7] === "relay");
  });
}

// packages/transport-webrtc/src/http.ts
var WEBRTC_HTTP_LIMITS = Object.freeze({ messageBytes: 128 * 1024, pending: 8, connections: 32, timeoutMs: 3e4 });

// packages/peer-session/src/worker-transport-lanes.ts
var bounds = (lane) => lane === "reliable" ? { frame: PEER_MESSAGE_LIMITS.frameBytes, bytes: PEER_MESSAGE_LIMITS.queueBytes, count: PEER_MESSAGE_LIMITS.queueFrames } : { frame: PEER_LIVE_MESSAGE_LIMITS.frameBytes, bytes: PEER_LIVE_MESSAGE_LIMITS.bufferedBytes, count: PEER_LIVE_MESSAGE_LIMITS.queueFrames };
function workerRtcLanes(post, lifetime, fail, timeoutMs, consume) {
  const lanes = ["reliable", "live"].map((lane) => {
    const limit = bounds(lane), queue = [];
    const pending = /* @__PURE__ */ new Map();
    let sequence = 0, received = 0, credited = 0, queuedBytes = 0, outgoingBytes = 0, reading = false, pumping = false;
    let wake;
    const requireOpen = () => lifetime.throwIfAborted();
    const validBytes = (bytes) => bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= limit.frame;
    const abort = () => {
      queue.length = 0;
      queuedBytes = 0;
      for (const held of pending.values()) {
        clearTimeout(held.timer);
        held.reject(lifetime.reason);
      }
      pending.clear();
      outgoingBytes = 0;
      wake?.();
      wake = void 0;
    };
    lifetime.addEventListener("abort", abort, { once: true });
    const acknowledge = (entry, accepted) => {
      requireOpen();
      queuedBytes -= entry.bytes.length;
      credited = entry.sequence;
      post({ action: "ack", lane, sequence: entry.sequence, accepted });
    };
    const pump = async () => {
      if (pumping || consume === void 0) return;
      pumping = true;
      try {
        while (queue.length && !lifetime.aborted) {
          const entry = queue[0];
          const accepted = await awaitOwnedTask(lifetime, () => consume(lane, entry.bytes));
          requireOpen();
          queue.shift();
          acknowledge(entry, accepted);
        }
      } catch (error) {
        if (!lifetime.aborted) fail(error);
      } finally {
        pumping = false;
      }
    };
    const send = async (bytes, signal) => {
      signal?.throwIfAborted();
      requireOpen();
      if (!validBytes(bytes)) throw new Error("APPLICATION_WORKER_FRAME_INVALID");
      if (pending.size >= limit.count || outgoingBytes + bytes.length > limit.bytes) {
        if (lane === "live") return false;
        throw new Error("APPLICATION_WORKER_SEND_LIMIT");
      }
      if (!Number.isSafeInteger(sequence + 1)) throw new Error("APPLICATION_WORKER_SEQUENCE_EXHAUSTED");
      const id = ++sequence;
      const accepted = new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("APPLICATION_WORKER_FRAME_TIMEOUT")), timeoutMs);
        pending.set(id, { bytes: bytes.length, resolve, reject, timer });
        outgoingBytes += bytes.length;
        try {
          post({ action: "frame", lane, sequence: id, bytes: bytes.slice() });
        } catch (error) {
          fail(error);
        }
      });
      const owned = signal === void 0 ? lifetime : AbortSignal.any([signal, lifetime]);
      try {
        return await awaitOwnedTask(owned, () => accepted);
      } catch (error) {
        if (!lifetime.aborted) fail(error);
        throw error;
      }
    };
    const frames = (signal) => ({ [Symbol.asyncIterator]() {
      const controller = new AbortController(), owned = AbortSignal.any([lifetime, controller.signal, ...[signal].filter((s) => s !== void 0)]);
      const cancelled = () => {
        wake?.();
        wake = void 0;
      };
      async function* read() {
        if (reading || consume !== void 0) throw new Error("APPLICATION_WORKER_READER_EXISTS");
        reading = true;
        owned.addEventListener("abort", cancelled, { once: true });
        try {
          for (; ; ) {
            owned.throwIfAborted();
            const entry = queue.shift();
            if (entry === void 0) {
              await new Promise((resolve) => {
                wake = resolve;
              });
              continue;
            }
            yield entry.bytes;
            acknowledge(entry, true);
          }
        } finally {
          reading = false;
          owned.removeEventListener("abort", cancelled);
          if (!lifetime.aborted) fail(new Error("APPLICATION_WORKER_READER_CLOSED"));
        }
      }
      const iterator = read();
      return {
        next: () => iterator.next(),
        async return() {
          controller.abort();
          return iterator.return();
        },
        async throw(error) {
          controller.abort(error);
          return iterator.throw(error);
        }
      };
    } });
    return { lane, send, frames, receive(value) {
      requireOpen();
      if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw new Error("APPLICATION_WORKER_SEQUENCE_INVALID");
      if (value.action === "ack") {
        const first = pending.entries().next().value;
        if (first === void 0 || first[0] !== value.sequence || typeof value.accepted !== "boolean" || lane === "reliable" && !value.accepted)
          throw new Error("APPLICATION_WORKER_CREDIT_INVALID");
        pending.delete(first[0]);
        clearTimeout(first[1].timer);
        outgoingBytes -= first[1].bytes;
        first[1].resolve(value.accepted);
      } else {
        if (value.sequence !== received + 1 || !validBytes(value.bytes)) throw new Error("APPLICATION_WORKER_FRAME_INVALID");
        if (received - credited >= limit.count || queuedBytes + value.bytes.length > limit.bytes) throw new Error("APPLICATION_WORKER_RECEIVE_LIMIT");
        received++;
        queuedBytes += value.bytes.length;
        queue.push({ sequence: received, bytes: value.bytes.slice() });
        wake?.();
        wake = void 0;
        void pump();
      }
    } };
  });
  return { reliable: lanes[0], live: lanes[1], receive(value) {
    if (value.lane !== "reliable" && value.lane !== "live") throw new Error("APPLICATION_WORKER_LANE_INVALID");
    if (value.action !== "frame" && value.action !== "ack") throw new Error("APPLICATION_WORKER_MESSAGE_INVALID");
    const expected = value.action === "frame" ? ["action", "lane", "sequence", "bytes"] : ["action", "lane", "sequence", "accepted"];
    if (Object.keys(value).some((key) => !expected.includes(key))) throw new Error("APPLICATION_WORKER_MESSAGE_INVALID");
    lanes[value.lane === "reliable" ? 0 : 1].receive(value);
  } };
}

// packages/peer-session/src/worker-transport.ts
var PROTOCOL2 = "chronolog/peer-session/rtc-endpoint/v1";
var MAX_CONNECTIONS = 8;
var clients = /* @__PURE__ */ new WeakMap();
var validId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/u.test(id);
var payload = ({ type: _type, id: _id, from: _from, ...value }) => value;
var envelope = (data, from) => {
  const value = message(data);
  return value?.type === PROTOCOL2 && value.from === from && validId(value.id) ? value : null;
};
function serveWorkerWebRtcConnections(endpoint, options = {}) {
  const active = /* @__PURE__ */ new Map();
  let closing, closed = false;
  const post = (id, value) => endpoint.postMessage({ ...value, type: PROTOCOL2, id, from: "page" });
  const receive = (event) => {
    const data = envelope(event.data, "worker");
    if (data === null || closed) return;
    const id = data.id, existing = active.get(id);
    if (existing !== void 0) {
      existing.receive(payload(data));
      return;
    }
    if (data.action !== "open") return;
    if (active.size >= MAX_CONNECTIONS) {
      post(id, { action: "ended", error: "APPLICATION_PEER_LIMIT" });
      return;
    }
    if (!["offerer", "answerer"].includes(String(data.role)) || !validTimeout(data.timeoutMs) || !validGatheringTimeout(data.gatheringTimeoutMs, data.timeoutMs) || !validConfiguration(data.configuration)) {
      post(id, { action: "ended", error: "APPLICATION_WORKER_OPTIONS_INVALID" });
      return;
    }
    const lifetime = new AbortController(), received = deferred(), sent = deferred(), signalingClosed = deferred();
    let rtc, stopping;
    let remoteSeen = false, sendRequested = false, sendAcknowledged = false, closeRequested = false, closeAcknowledged = false;
    let lastRoute = 0, routePending = false;
    const end = (reason = new Error("APPLICATION_RTC_CLOSED")) => {
      if (stopping !== void 0) return stopping;
      stopping = Promise.resolve().then(async () => {
        await rtc?.close();
      });
      void stopping.catch(() => void 0);
      lifetime.abort(reason);
      received.reject(reason);
      sent.reject(reason);
      signalingClosed.reject(reason);
      active.delete(id);
      try {
        post(id, { action: "ended", error: errorMessage(reason) });
      } catch {
      }
      return stopping;
    };
    const lanes = workerRtcLanes(
      (value) => post(id, value),
      lifetime.signal,
      (error) => {
        void end(error);
      },
      data.timeoutMs,
      async (lane, bytes) => {
        if (rtc === void 0) throw new Error("APPLICATION_WORKER_NOT_READY");
        if (lane === "live") return rtc.live.trySend(bytes, { signal: lifetime.signal });
        await rtc.send(bytes, { signal: lifetime.signal });
        return true;
      }
    );
    const request = (input) => {
      try {
        if (input.action === "close") {
          void end();
          return;
        }
        if (input.action === "frame" || input.action === "ack") {
          lanes.receive(input);
          return;
        }
        if (input.action === "description" && !remoteSeen) {
          remoteSeen = true;
          received.resolve(description(input.description, data.role === "offerer" ? "answer" : "offer"));
          return;
        }
        if (input.action === "sent" && sendRequested && !sendAcknowledged) {
          sendAcknowledged = true;
          sent.resolve();
          return;
        }
        if (input.action === "signaling-closed" && closeRequested && !closeAcknowledged) {
          closeAcknowledged = true;
          signalingClosed.resolve();
          return;
        }
        if (input.action === "route" && rtc !== void 0 && !routePending && Number.isSafeInteger(input.request) && Number(input.request) > lastRoute) {
          lastRoute = Number(input.request);
          routePending = true;
          void awaitOwnedTask(lifetime.signal, () => rtc.session.getRoute()).then((value) => {
            lifetime.signal.throwIfAborted();
            post(id, { action: "route", request: input.request, value: route(value) });
          }, (error) => {
            if (!lifetime.signal.aborted) post(id, { action: "route", request: input.request, error: errorMessage(error) });
          }).catch((error) => {
            void end(error);
          }).finally(() => {
            routePending = false;
          });
          return;
        }
        throw new Error("APPLICATION_WORKER_MESSAGE_INVALID");
      } catch (error) {
        void end(error);
      }
    };
    active.set(id, { receive: request, close: end });
    void (async () => {
      try {
        const candidate = await openWebRtcConnection({
          role: data.role,
          ...data.configuration === void 0 ? {} : { configuration: data.configuration },
          ...options.createPeerConnection === void 0 ? {} : { createPeerConnection: options.createPeerConnection },
          timeoutMs: data.timeoutMs,
          signal: lifetime.signal,
          ...data.gatheringTimeoutMs === void 0 ? {} : { gatheringTimeoutMs: data.gatheringTimeoutMs },
          signaling: {
            messages: { async *[Symbol.asyncIterator]() {
              yield await awaitOwnedTask(lifetime.signal, () => received.promise);
            } },
            async send(value) {
              lifetime.signal.throwIfAborted();
              if (sendRequested) throw new Error("APPLICATION_WORKER_DESCRIPTION_REPEATED");
              sendRequested = true;
              post(id, { action: "send", description: value });
              await awaitOwnedTask(lifetime.signal, () => sent.promise);
            },
            async close() {
              lifetime.signal.throwIfAborted();
              if (!closeRequested) {
                closeRequested = true;
                post(id, { action: "close-signaling" });
              }
              await awaitOwnedTask(lifetime.signal, () => signalingClosed.promise);
            }
          }
        });
        rtc = candidate;
        if (lifetime.signal.aborted) {
          await candidate.close();
          return;
        }
        candidate.signal.addEventListener("abort", () => {
          void end(candidate.signal.reason);
        }, { once: true });
        candidate.session.signal.addEventListener("abort", () => {
          void end(candidate.session.signal.reason);
        }, { once: true });
        if (candidate.signal.aborted || candidate.session.signal.aborted) {
          await end(candidate.signal.reason ?? candidate.session.signal.reason);
          return;
        }
        post(id, { action: "ready" });
        const forward = async (lane) => {
          const source = lane === "reliable" ? candidate : candidate.live;
          for await (const bytes of source.frames(lifetime.signal)) {
            lifetime.signal.throwIfAborted();
            await lanes[lane].send(bytes, lifetime.signal);
          }
          if (!lifetime.signal.aborted) await end(new Error("APPLICATION_RTC_ENDED"));
        };
        void forward("reliable").catch((error) => {
          void end(error);
        });
        void forward("live").catch((error) => {
          void end(error);
        });
      } catch (error) {
        await end(error);
      }
    })().catch(() => void 0);
  };
  const abort = () => {
    void close();
  };
  const close = () => {
    if (closing !== void 0) return closing;
    closed = true;
    endpoint.removeEventListener("message", receive);
    options.signal?.removeEventListener("abort", abort);
    closing = Promise.allSettled([...active.values()].map((value) => value.close(new Error("APPLICATION_WORKER_CLOSED")))).then(() => void 0);
    return closing;
  };
  endpoint.addEventListener("message", receive);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted === true) abort();
  return { close };
}
async function openWorkerWebRtcConnection(endpoint, options) {
  const timeoutMs = options.timeoutMs ?? 3e4;
  if (!validTimeout(timeoutMs) || !validGatheringTimeout(options.gatheringTimeoutMs, timeoutMs) || !["offerer", "answerer"].includes(options.role) || !validConfiguration(options.configuration)) throw new Error("APPLICATION_WORKER_OPTIONS_INVALID");
  options.signal?.throwIfAborted();
  let owned = clients.get(endpoint);
  if (owned === void 0) clients.set(endpoint, owned = /* @__PURE__ */ new Set());
  if (owned.size >= MAX_CONNECTIONS) throw new Error("APPLICATION_PEER_LIMIT");
  const id = crypto.randomUUID(), lifetime = new AbortController(), negotiated = deferred();
  owned.add(id);
  const post = (value) => endpoint.postMessage({ ...value, type: PROTOCOL2, id, from: "worker" });
  let closing, signalingClose, sendSeen = false, closeSeen = false, readySeen = false;
  let routeId = 0, routePending;
  const stopSignaling = () => {
    signalingClose ??= Promise.resolve().then(() => options.signaling.close());
    void signalingClose.catch(() => void 0);
    return signalingClose;
  };
  const close = (reason = new Error("APPLICATION_RTC_CLOSED")) => {
    if (closing !== void 0) return closing;
    closing = Promise.resolve();
    lifetime.abort(reason);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    negotiated.reject(reason);
    owned.delete(id);
    if (!owned.size) clients.delete(endpoint);
    if (routePending !== void 0) {
      clearTimeout(routePending.timer);
      routePending.result.reject(reason);
      routePending = void 0;
    }
    try {
      post({ action: "close" });
    } catch {
    }
    endpoint.removeEventListener("message", receive);
    void stopSignaling();
    return closing;
  };
  const fail = (error) => {
    void close(error);
  };
  const lanes = workerRtcLanes(post, lifetime.signal, fail, timeoutMs);
  const abort = () => fail(options.signal?.reason);
  const receive = (event) => {
    const value = envelope(event.data, "page");
    if (value?.id !== id || lifetime.signal.aborted) return;
    try {
      if (value.action === "ended") throw new Error(errorMessage(value.error ?? "APPLICATION_RTC_CLOSED"));
      if (value.action === "frame" || value.action === "ack") {
        if (!readySeen) throw new Error("APPLICATION_WORKER_NOT_READY");
        lanes.receive(payload(value));
        return;
      }
      if (value.action === "send" && !sendSeen) {
        sendSeen = true;
        const outgoing = description(value.description, options.role === "offerer" ? "offer" : "answer");
        void awaitOwnedTask(lifetime.signal, () => options.signaling.send(outgoing)).then(() => {
          lifetime.signal.throwIfAborted();
          post({ action: "sent" });
        }).catch(fail);
        return;
      }
      if (value.action === "close-signaling" && !closeSeen && sendSeen) {
        closeSeen = true;
        void awaitOwnedTask(lifetime.signal, stopSignaling).then(() => {
          lifetime.signal.throwIfAborted();
          post({ action: "signaling-closed" });
        }).catch(fail);
        return;
      }
      if (value.action === "ready" && !readySeen && closeSeen && sendSeen) {
        readySeen = true;
        negotiated.resolve();
        return;
      }
      if (value.action === "route" && routePending !== void 0 && value.request === routePending.id) {
        const pending = routePending, selected = value.error === void 0 ? route(value.value) : void 0;
        routePending = void 0;
        clearTimeout(pending.timer);
        if (selected !== void 0) pending.result.resolve(selected);
        else pending.result.reject(new Error(errorMessage(value.error)));
        return;
      }
      throw new Error("APPLICATION_WORKER_MESSAGE_INVALID");
    } catch (error) {
      fail(error);
    }
  };
  const timer = setTimeout(() => fail(new Error("APPLICATION_WORKER_CONNECTION_TIMEOUT")), timeoutMs);
  endpoint.addEventListener("message", receive);
  options.signal?.addEventListener("abort", abort, { once: true });
  let descriptions;
  try {
    descriptions = options.signaling.messages[Symbol.asyncIterator]();
    lifetime.signal.throwIfAborted();
    post({ action: "open", role: options.role, timeoutMs, configuration: options.configuration, gatheringTimeoutMs: options.gatheringTimeoutMs });
    void awaitOwnedTask(lifetime.signal, () => descriptions.next()).then((item) => {
      lifetime.signal.throwIfAborted();
      if (item.done) throw new Error("APPLICATION_WORKER_SIGNALING_ENDED");
      post({ action: "description", description: description(item.value, options.role === "offerer" ? "answer" : "offer") });
    }).catch(fail);
    await awaitOwnedTask(lifetime.signal, () => negotiated.promise);
    lifetime.signal.throwIfAborted();
    clearTimeout(timer);
    return {
      signal: lifetime.signal,
      send: async (bytes, sendOptions) => {
        await lanes.reliable.send(bytes, sendOptions?.signal);
      },
      frames: (signal) => lanes.reliable.frames(signal),
      close: () => close(),
      live: {
        signal: lifetime.signal,
        trySend: (bytes, sendOptions) => lanes.live.send(bytes, sendOptions?.signal),
        frames: (signal) => lanes.live.frames(signal),
        close: () => close()
      },
      getRoute() {
        lifetime.signal.throwIfAborted();
        if (routePending !== void 0) return routePending.result.promise;
        const request = ++routeId;
        if (!Number.isSafeInteger(request)) throw new Error("APPLICATION_WORKER_REQUEST_ID_EXHAUSTED");
        const result = deferred(), timer2 = setTimeout(() => fail(new Error("APPLICATION_WORKER_ROUTE_TIMEOUT")), timeoutMs);
        routePending = { id: request, result, timer: timer2 };
        try {
          post({ action: "route", request });
        } catch (error) {
          fail(error);
        }
        return result.promise;
      }
    };
  } catch (error) {
    await close(error);
    throw error;
  } finally {
    void Promise.resolve().then(() => descriptions?.return?.()).catch(() => void 0);
  }
}
function validTimeout(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 12e4;
}
function validConfiguration(value) {
  if (value === void 0) return true;
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && JSON.stringify(value).length <= 16384;
  } catch {
    return false;
  }
}
function message(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function description(value, expected) {
  const input = message(value);
  if (input?.type !== expected || typeof input.sdp !== "string" || input.sdp.length < 1 || new TextEncoder().encode(input.sdp).length > WEBRTC_LIMITS.sdpBytes) throw new Error("APPLICATION_WORKER_DESCRIPTION_INVALID");
  return { type: expected, sdp: input.sdp };
}
function route(value) {
  const input = message(value), candidates = [null, "host", "srflx", "prflx", "relay"];
  if (input === null || !["direct", "relay", "unknown"].includes(String(input.route)) || !candidates.includes(input.localCandidateType) || !candidates.includes(input.remoteCandidateType)) {
    throw new Error("APPLICATION_WORKER_ROUTE_INVALID");
  }
  return {
    route: input.route,
    localCandidateType: input.localCandidateType,
    remoteCandidateType: input.remoteCandidateType
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => void 0);
  return { promise, resolve, reject };
}
function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 256);
}
function validGatheringTimeout(value, timeoutMs) {
  return value === void 0 || validTimeout(value) && value <= timeoutMs;
}

export {
  WEBRTC_LIMITS,
  openWebRtcConnection,
  serveWorkerWebRtcConnections,
  openWorkerWebRtcConnection
};
