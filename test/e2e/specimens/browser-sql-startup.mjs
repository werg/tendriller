// Fixture readiness only. Product session/transport/operation deadlines are unchanged.
export const SQL_FIXTURE_STARTUP = Object.freeze({ metadataMs: 25_000, sqlMs: 30_000 });
const stages = ['metadata-ready', 'engine-load-start', 'engine-load-ready', 'opfs-ready', 'sql-read-ready'];

export function startSqlFixtureWorker(worker, input, progress = () => {}) {
  return new Promise((resolve, reject) => {
    let phase = 'metadata', done = false, sqlReady = false, timer;
    const finish = error => {
      if (done) return;
      done = true; clearTimeout(timer);
      worker.removeEventListener('message', message); worker.removeEventListener('error', failed);
      if (error) { worker.terminate(); reject(error); } else resolve();
    };
    const arm = () => { timer = setTimeout(() => finish(new Error(phase === 'metadata'
      ? 'SQL_FIXTURE_METADATA_TIMEOUT' : 'SQL_FIXTURE_DATABASE_TIMEOUT')),
    phase === 'metadata' ? SQL_FIXTURE_STARTUP.metadataMs : SQL_FIXTURE_STARTUP.sqlMs); };
    const failed = event => finish(new Error(event.message || 'SQL_FIXTURE_WORKER_FAILED'));
    const message = ({ data }) => {
      if (data?.type === 'failure') { finish(new Error(data.message)); return; }
      if (data?.type === 'startup-progress' && stages.includes(data.stage)
        && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0) {
        if (data.stage === 'metadata-ready') {
          if (phase !== 'metadata') { finish(new Error('SQL_FIXTURE_METADATA_REPEATED')); return; }
          phase = 'sql'; clearTimeout(timer); arm();
        }
        if (data.stage === 'sql-read-ready' && phase === 'sql') sqlReady = true;
        progress({ stage: data.stage, elapsedMs: data.elapsedMs });
      }
      if (data?.type === 'open') finish(phase === 'sql' && sqlReady ? null : new Error('SQL_FIXTURE_SQL_NOT_QUALIFIED'));
    };
    worker.addEventListener('message', message); worker.addEventListener('error', failed);
    arm();
    try { worker.postMessage(input); } catch (error) { finish(error); }
  });
}
