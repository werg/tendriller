#!/usr/bin/env node
// Machine telemetry runs independently of any conversational agent session.
import { checkService } from "../../cli/lib/service.mjs";
import { Collector, emitHostSamples, parseSampleArguments, readConfig } from '../lib/stream-collector.mjs';
import { INIT_USAGE, initializeCollector, parseInitArguments } from '../lib/stream-init.mjs';

const usage = `Usage: tendril-stream <private-config.json> | tendril-stream --sample [interval_ms] [--gpu]\n       ${INIT_USAGE}`;

try {
  if (process.argv[2] === '--help' || process.argv[2] === 'init' && process.argv[3] === '--help' && process.argv.length === 4) {
    process.stdout.write(usage + '\n');
  } else if (process.argv[2] === 'init') {
    const result = await initializeCollector(parseInitArguments(process.argv.slice(3)));
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (process.argv[2] === '--sample') {
    const options = parseSampleArguments(process.argv.slice(3));
    const abort = new AbortController();
    const stop = () => {
      abort.abort();
      // These are live samples: discard pending pipe writes on shutdown so a
      // remote reader that stopped draining cannot keep the sampler alive.
      process.stdout.destroy();
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    try { await emitHostSamples({ ...options, signal: abort.signal }); }
    finally { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop); }
    // Node keeps native stdout writes alive even after stdout.destroy(). This
    // sampler owns no durable work; an explicit exit discards only live output.
    if (abort.signal.aborted) process.exit(0);
  } else {
    const file = process.argv[2];
    if (!file || process.argv.length !== 3) throw Error(usage);
    const config = await readConfig(file);
    await checkService(config.api);
    const collector = await Collector.open(config);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void collector.stop(); });
    await collector.run();
  }
} catch (error) {
  // Validation errors are ours; network failures never interpolate server bodies.
  const safe = String(error.message || 'Collector failed').replace(/(?:tp|tk)_[a-z2-7]{32,64}/g, '[credential]');
  process.stderr.write(`tendril-stream: ${safe}\n`);
  process.exitCode = 1;
}
