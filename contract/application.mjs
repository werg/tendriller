import { assertStateJson, normalizeStateChecks, normalizeStateOps } from './state.mjs';

export const APPLICATION_LIMITS = Object.freeze({ programBytes: 256 * 1024, steps: 256, events: 128,
  eventBytes: 64 * 1024, topicLength: 160, batchTransactions: 128, historyBytes: 64 * 1024 * 1024, historyTransactions: 100_000 });
export class ApplicationError extends Error {
  constructor(code, message) { super(message); this.name = 'ApplicationError'; this.code = code; }
}
const fail = (code, message) => { throw new ApplicationError(code, message); };
export function applicationSelection(value, defaultId = 'cloudflare') {
  if (value === undefined) return Object.freeze({ kind: 'cloudflare', id: defaultId });
  if (!value || typeof value !== 'object' || !['cloudflare', 'peer'].includes(value.kind) ||
      typeof value.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.id) || Object.keys(value).some(key => !['kind', 'id'].includes(key)))
    fail('invalid_backend', 'Application selection requires a kind and stable identity');
  return Object.freeze({ kind: value.kind, id: value.id });
}
export function createApplicationBinding(selection, initial) {
  const selected = applicationSelection(selection);
  let backend;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const install = value => {
    if (backend) fail('backend_already_selected', 'The application backend cannot change within a page history');
    if (!value || value.id !== selected.id || !Array.isArray(value.capabilities) || typeof value.submit !== 'function' ||
        typeof value.readView !== 'function' || !value.events || ['publish', 'read', 'subscribe'].some(key => typeof value.events[key] !== 'function') ||
        !value.operations || ['get', 'subscribe'].some(key => typeof value.operations[key] !== 'function'))
      fail('invalid_backend', 'The backend must implement the public contract and selected identity');
    backend = value;
    resolveReady(value);
  };
  if (initial) install(initial);
  return Object.freeze({ selection: selected, get backend() {
    if (!backend) fail('backend_unavailable', 'Install this page\'s selected application backend before accessing application data');
    return backend;
  }, ready: () => ready, install });
}
export function assertApplicationTopic(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value)) fail('invalid_topic', 'Invalid application topic');
  return value;
}
export function assertApplicationOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) fail('invalid_operation_id', 'A stable operationId is required');
  return value;
}
export function applicationFilter(topics) {
  if (topics === undefined) return null;
  if (!Array.isArray(topics) || topics.length > 128) fail('invalid_filter', 'topics must be a bounded list');
  return [...new Set(topics.map(assertApplicationTopic))].sort();
}
export function validateCloudflareProgram(input) {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.steps) || !input.steps.length ||
      input.steps.length > APPLICATION_LIMITS.steps || Object.keys(input).some(key => !['version', 'steps', 'scope', 'expected_generations'].includes(key)))
    fail('invalid_program', 'Expected a bounded Cloudflare application program version 1');
  assertStateJson(input);
  if (!input.expected_generations || Array.isArray(input.expected_generations) || typeof input.expected_generations !== 'object')
    fail('invalid_program', 'Capture expected_generations before persisting the operation');
  if (input.scope !== undefined && (typeof input.scope !== 'string' || !input.scope)) fail('invalid_program', 'Invalid scope');
  let events = 0;
  const steps = input.steps.map(step => {
    if (!step || typeof step !== 'object') fail('invalid_program', 'Invalid program step');
    if (step.kind === 'state') {
      if (Object.keys(step).some(key => !['kind', 'ops', 'conditions', 'expected_revision'].includes(key))) fail('invalid_program', 'Unknown state step field');
      return { kind: 'state', ops: normalizeStateOps(step.ops), ...normalizeStateChecks(step) };
    }
    if (step.kind !== 'emit' || Object.keys(step).some(key => !['kind', 'topic', 'payload'].includes(key)) || !Object.hasOwn(step, 'payload'))
      fail('invalid_program', 'Unknown application program step');
    assertApplicationTopic(step.topic);
    assertStateJson(step.payload);
    if (++events > APPLICATION_LIMITS.events || new TextEncoder().encode(JSON.stringify(step.payload)).length > APPLICATION_LIMITS.eventBytes)
      fail('program_too_large', 'Application event exceeds the payload limit');
    return { kind: 'emit', topic: step.topic, payload: structuredClone(step.payload) };
  });
  const program = { version: 1, steps, ...(input.scope === undefined ? {} : { scope: input.scope }), expected_generations: structuredClone(input.expected_generations) };
  if (new TextEncoder().encode(JSON.stringify(program)).length > APPLICATION_LIMITS.programBytes) fail('program_too_large', 'Application program exceeds the byte limit');
  return program;
}
export function publishConversation(events, message, options) {
  assertApplicationOperationId(message?.messageId);
  if (typeof message?.text !== 'string' || !message.text.trim() || message.text.length > 32_768) fail('invalid_message', 'Conversation text must be nonempty and bounded');
  if (message.inReplyTo !== undefined) assertApplicationOperationId(message.inReplyTo);
  return events.publish('conversation', { type: 'message.posted', version: 1, messageId: message.messageId,
    text: message.text, ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }) }, options);
}

function delay(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 250);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function createCloudflareApplicationBackend({ id, request, submit: enqueue }) {
  applicationSelection({ kind: 'cloudflare', id });
  const submit = async (program, options) => {
    const exact = validateCloudflareProgram(program);
    assertApplicationOperationId(options?.operationId);
    return enqueue ? enqueue(exact, options) : request('application/changes', { method: 'POST', body: { program: exact, operationId: options.operationId } });
  };
  const readEvents = async (options = {}, revision) => {
    const topics = applicationFilter(options.topics);
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (topics !== null) query.set('topics', JSON.stringify(topics));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (revision !== undefined) query.set('revision', revision);
    return request(`application/events?${query}`, { signal: options.signal });
  };
  const events = Object.freeze({
    publish(topic, payload, options) { return submit({ version: 1, steps: [{ kind: 'emit', topic, payload }], expected_generations: {} }, options); },
    read: readEvents,
    async *subscribe(options = {}) {
      let cursor = options.cursor;
      while (!options.signal?.aborted) {
        const batch = await readEvents({ ...options, ...(cursor === undefined ? {} : { cursor }) });
        const progressed = batch.scannedThrough !== cursor;
        if (progressed || batch.transactions.length) { yield batch; cursor = batch.scannedThrough; }
        if (!batch.hasMore) {
          try { await delay(options.signal); } catch (error) { if (options.signal?.aborted) return; throw error; }
        }
      }
    },
  });
  const getOperation = operationId => request(`application/operations/${encodeURIComponent(assertApplicationOperationId(operationId))}`);
  return Object.freeze({ id, capabilities: Object.freeze(['json-state', 'events', 'conversation', 'revision-views']), submit, events,
    operations: Object.freeze({ get: getOperation, async *subscribe({ operationId, signal }) {
      assertApplicationOperationId(operationId);
      let last;
      while (!signal?.aborted) {
        const value = await getOperation(operationId), encoded = JSON.stringify(value);
        if (value && last !== encoded) { yield value; last = encoded; }
        if (value?.status === 'final' || value?.status === 'rejected') return;
        try { await delay(signal); } catch (error) { if (signal?.aborted) return; throw error; }
      }
    } }),
    async readView() {
      const snapshot = await request('application/view');
      let released = false;
      const check = () => { if (released) fail('view_released', 'The application read view was released'); };
      return Object.freeze({ revision: snapshot.revision,
        query(name, parameters = []) {
          check();
          if (parameters.length || !['state', 'scopes'].includes(name)) fail('unsupported_query', 'The JSON backend supports the state and scopes snapshot queries');
          return structuredClone(snapshot[name]);
        },
        readEvents(options) { check(); return readEvents(options, snapshot.revision); },
        release() { released = true; },
      });
    },
  });
}
