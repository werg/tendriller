import assert from 'node:assert/strict';

const phases = new Set(['startup', 'blocked', 'restored', 'offline', 'impaired', 'frozen', 'idle', 'cleanup']);
const events = new Set(['start', 'end', 'fault-on', 'fault-off', 'command', 'direct', 'relay', 'stop-request', 'failure']);
const counters = ['hostRequests', 'relayBytes', 'sentReliableBytes', 'receivedReliableBytes', 'sentLiveBytes', 'receivedLiveBytes'];

export function activityTimeline({ now = () => new Date().toISOString(), limit = 256 } = {}) {
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 256);
  const items = [];
  let dropped = 0;
  return {
    record(phase, event, values = {}) {
      assert.ok(phases.has(phase) && events.has(event), 'Unknown timeline label');
      const item = { at: now(), phase, event };
      assert.match(item.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      for (const key of counters) {
        if (values[key] === undefined) continue;
        assert.ok(Number.isSafeInteger(values[key]) && values[key] >= 0, 'Invalid counter');
        item[key] = values[key];
      }
      // Unknown fields are intentionally discarded, including IDs, URLs and payloads.
      if (items.length === limit) { items.shift(); dropped++; }
      items.push(item);
    },
    snapshot: () => ({ items: structuredClone(items), dropped }),
  };
}

export function validateCounters(value) {
  assert.equal(typeof value.instance, 'string');
  assert.ok(value.instance.length > 0, 'Counter epoch required');
  for (const key of counters) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0, `Invalid ${key}`);
  return value;
}

export function counterDelta(before, after) {
  validateCounters(before); validateCounters(after);
  assert.equal(after.instance, before.instance, 'Counter restart invalidates the segment');
  return Object.fromEntries(counters.map(key => {
    const delta = after[key] - before[key];
    assert.ok(Number.isSafeInteger(delta) && delta >= 0, `Counter reset: ${key}`);
    return [key, delta];
  }));
}

export function assertIdle(before, after) {
  const delta = counterDelta(before, after);
  assert.equal(delta.hostRequests, 0, 'Idle segment made host requests');
  assert.equal(delta.relayBytes, 0, 'Idle segment carried host relay payload');
  return { delta, modelTurns: null, modelScope: 'not-observed', byteScope: 'application-transport-counters',
    limitation: 'No claim about kernel internal work, provider infrastructure, physical radio sleep or future model wake.' };
}

export function assertDirectWork(before, after) {
  const delta = counterDelta(before, after);
  assert.equal(delta.relayBytes, 0, 'Authenticated direct work used relay payload');
  assert.ok(delta.sentReliableBytes > 0 && delta.receivedReliableBytes > 0, 'Bidirectional reliable work required');
  assert.ok(delta.sentLiveBytes > 0 && delta.receivedLiveBytes > 0, 'Bidirectional live work required');
  return delta;
}
