import { assertValid } from './index.mjs';
import { assertStateJson, isStateObject, normalizeStateChecks, normalizeStateOps } from './state.mjs';

export const APPLICATION_LIMITS = Object.freeze({ programBytes: 256 * 1024, steps: 256, events: 128,
  eventBytes: 64 * 1024, topicLength: 160, batchTransactions: 128, historyBytes: 64 * 1024 * 1024, historyTransactions: 100_000 });
export class ApplicationError extends Error {
  constructor(code, message) { super(message); this.name = 'ApplicationError'; this.code = code; }
}
const fail = (code, message) => { throw new ApplicationError(code, message); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

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
        typeof value.readView !== 'function' || typeof value.changes !== 'function' || !value.events || ['publish', 'read', 'subscribe'].some(key => typeof value.events[key] !== 'function') ||
        !value.operations || ['get', 'subscribe'].some(key => typeof value.operations[key] !== 'function'))
      fail('invalid_backend', 'The backend must implement the public contract and selected identity');
    backend = value;
    resolveReady(value);
  };
  if (initial) install(initial);
  return Object.freeze({ selection: selected, get available() { return !!backend; }, get backend() {
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
  assertValid('preconditions', { cid: 'application-program', ...(input.scope === undefined ? {} : { scope: input.scope }), expected_generations: input.expected_generations });
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
  return JSON.parse(canonical(program));
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
/** Validate a saved or remote receipt before using it to retire durable work. */
export function validateApplicationOperation(value, operationId, { terminal = false } = {}) {
  if (!value || typeof value !== 'object' || value.operationId !== operationId || typeof value.proposalId !== 'string' ||
      !['queued', 'provisional', 'final'].includes(value.status) ||
      (terminal && value.status !== 'final') ||
      (value.status === 'queued' ? value.outcome !== undefined || value.error !== undefined || value.message !== undefined
        : !['accepted', 'rejected'].includes(value.outcome)) ||
      (value.status !== 'queued' && !value.proposalId && !(value.status === 'final' && value.outcome === 'rejected' &&
        ['operation_conflict', 'history_quota'].includes(value.error))) ||
      (value.error !== undefined && typeof value.error !== 'string') || (value.message !== undefined && typeof value.message !== 'string') ||
      (value.revision !== undefined && typeof value.revision !== 'string'))
    fail('invalid_response', 'Invalid application operation receipt; preserve the original queued operation');
  return structuredClone(value);
}
function validateEventBatch(value, applicationId) {
  if (!value || !Array.isArray(value.transactions) || value.transactions.length > APPLICATION_LIMITS.batchTransactions ||
      typeof value.scannedThrough !== 'string' || !value.scannedThrough || typeof value.revision !== 'string' || !value.revision || typeof value.hasMore !== 'boolean')
    fail('invalid_response', 'Invalid durable event batch');
  for (const transaction of value.transactions) {
    if (!transaction || typeof transaction.proposalId !== 'string' || !transaction.proposalId || !Array.isArray(transaction.events) ||
        transaction.events.length > APPLICATION_LIMITS.events || !transaction.events.length) fail('invalid_response', 'Invalid event transaction');
    let ordinal = -1;
    for (const event of transaction.events) {
      if (!event || event.proposalId !== transaction.proposalId || !Number.isSafeInteger(event.eventOrdinal) || event.eventOrdinal <= ordinal ||
          event.id !== `${transaction.proposalId}:${event.eventOrdinal}` || !Object.hasOwn(event, 'payload')) fail('invalid_response', 'Invalid event identity');
      const origin = event.origin;
      if (!origin || origin.kind !== 'hosted' || origin.applicationId !== applicationId ||
          typeof origin.authorId !== 'string' || !origin.authorId || !['owner', 'agent'].includes(origin.role) ||
          typeof origin.operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(origin.operationId))
        fail('invalid_response', 'Missing authenticated event origin');
      ordinal = event.eventOrdinal; assertApplicationTopic(event.topic); assertStateJson(event.payload);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 2 * 1024 * 1024) fail('invalid_response', 'Event batch exceeds its byte bound');
  return value;
}
export function createCloudflareApplicationBackend({ id, request, submit: enqueue, onChange }) {
  applicationSelection({ kind: 'cloudflare', id });
  const submit = async (program, options) => {
    if (Object.keys(options ?? {}).some(key => key !== 'operationId'))
      fail('unsupported_option', 'This live backend supports only operationId; include preconditions in the program');
    const exact = validateCloudflareProgram(program);
    assertApplicationOperationId(options?.operationId);
    return validateApplicationOperation(await (enqueue ? enqueue(exact, options) : request('application/changes', { method: 'POST', body: { program: exact, operationId: options.operationId } })), options.operationId, { terminal: !enqueue });
  };
  const readEvents = async (options = {}, revision) => {
    const topics = applicationFilter(options.topics);
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (topics !== null) query.set('topics', JSON.stringify(topics));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (revision !== undefined) query.set('revision', revision);
    return validateEventBatch(await request(`application/events?${query}`, { signal: options.signal }), id);
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
  const getOperation = async (operationId, signal) => {
    const result = await request(`application/operations/${encodeURIComponent(assertApplicationOperationId(operationId))}`, { signal });
    return result === null ? null : validateApplicationOperation(result, operationId);
  };
  return Object.freeze({ id, profile: 'hosted-json-v1', capabilities: Object.freeze(['json-state', 'events', 'conversation', 'revision-views', 'operation-status']), submit, events,
    async *changes(options = {}) {
      const view = options.view ?? 'final', signal = options.signal;
      if (!['local', 'final'].includes(view)) fail('invalid_view', 'Choose the local or final application view');
      if (signal?.aborted) return;
      let version = 0, wake, previous;
      const dispose = onChange?.(() => { version++; wake?.(); });
      try {
        while (!signal?.aborted) {
          // Register before reading so a mutation during the read cannot be lost.
          const observed = version;
          const value = await request(`application/revision?view=${view}`, { signal });
          if (!value || value.view !== view || typeof value.revision !== 'string' || !value.revision ||
              typeof value.finalRevision !== 'string' || !value.finalRevision)
            fail('invalid_response', 'Invalid application revision');
          const encoded = JSON.stringify([value.revision, value.finalRevision]);
          if (encoded !== previous) { previous = encoded; yield value; }
          if (signal?.aborted) return;
          if (onChange) {
            if (observed === version) await new Promise(resolve => {
              const ready = () => { signal?.removeEventListener('abort', ready); wake = undefined; resolve(); };
              wake = ready;
              signal?.addEventListener('abort', ready, { once: true });
              if (signal?.aborted || observed !== version) ready();
            });
          } else await delay(signal);
        }
      } catch (error) { if (!signal?.aborted) throw error; }
      finally { dispose?.(); }
    },
    operations: Object.freeze({ get: operationId => getOperation(operationId), async *subscribe({ operationId, signal }) {
      assertApplicationOperationId(operationId);
      let last;
      while (!signal?.aborted) {
        const value = await getOperation(operationId, signal), encoded = JSON.stringify(value);
        if (value && last !== encoded) { yield value; last = encoded; }
        if (value?.status === 'final') return;
        try { await delay(signal); } catch (error) { if (signal?.aborted) return; throw error; }
      }
    } }),
    async readView(options = {}) {
      const view = options.view ?? 'final';
      if (!['local', 'final'].includes(view)) fail('invalid_view', 'Choose the local or final application view');
      const snapshot = await request(`application/view?view=${view}`);
      if (!snapshot || snapshot.view !== view || typeof snapshot.revision !== 'string' || !snapshot.revision ||
          typeof snapshot.finalRevision !== 'string' || !snapshot.finalRevision || !isStateObject(snapshot.state) || !Array.isArray(snapshot.scopes))
        fail('invalid_response', 'Invalid application read snapshot');
      assertStateJson(snapshot.state);
      let released = false;
      const check = () => { if (released) fail('view_released', 'The application read view was released'); };
      return Object.freeze({ view, revision: snapshot.revision, finalRevision: snapshot.finalRevision,
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
