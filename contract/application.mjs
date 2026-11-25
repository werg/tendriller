/** Application identity and the sole owned-session installation boundary. */
export class ApplicationError extends Error {
  constructor(code, message) { super(message); this.name = 'ApplicationError'; this.code = code; }
}
const fail = (code, message) => { throw new ApplicationError(code, message); };
export function applicationSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id) || Object.keys(value).some(key => key !== 'id'))
    fail('invalid_application', 'Application selection requires its stable 32-byte identity');
  return Object.freeze({ id: value.id });
}
export function createApplicationBinding(selection, initial) {
  const selected = applicationSelection(selection);
  let backend;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const install = value => {
    if (backend) fail('backend_already_selected', 'The application backend cannot change within a page history');
    if (!value || value.applicationId !== selected.id || typeof value.submit !== 'function' ||
        typeof value.readView !== 'function' || typeof value.changes !== 'function' || !value.status ||
        typeof value.onStatus !== 'function' || !value.operations || ['get', 'retry', 'subscribe'].some(key => typeof value.operations[key] !== 'function'))
      fail('invalid_backend', 'Install the selected owned application session with durable submission and coherent local reads');
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
export function publishConversation(events, message, options) {
  assertApplicationOperationId(message?.messageId);
  if (typeof message?.text !== 'string' || !message.text.trim() || message.text.length > 32_768) fail('invalid_message', 'Conversation text must be nonempty and bounded');
  if (message.inReplyTo !== undefined) assertApplicationOperationId(message.inReplyTo);
  return events.publish('conversation', { type: 'message.posted', version: 1, messageId: message.messageId,
    text: message.text, ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }) }, options);
}
