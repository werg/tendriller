import {
  emit,
  program
} from "./chunk-MAGRVNAE.mjs";

// packages/peer-session/src/tendriller.ts
function createApplicationBackend(session) {
  return {
    applicationId: session.applicationId,
    identity: session.identity,
    get status() {
      return session.status;
    },
    signal: session.signal,
    onStatus: session.onStatus.bind(session),
    submit: session.submit.bind(session),
    changes: session.changes.bind(session),
    readView: session.readView.bind(session),
    operations: session.operations,
    events: { publish: (topic, payload, options = {}) => session.submit({ ...options, program: program(emit(topic, payload)) }), read: session.readEvents.bind(session) }
  };
}

export {
  createApplicationBackend
};
