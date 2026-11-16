const base = process.argv[2];
if (!/^https:\/\/[a-z0-9.-]+$/.test(base ?? ''))
  throw Error('Pass a service HTTPS origin');
for (let attempt = 0; attempt < 5; attempt++) {
  const response = await fetch(`${base}/status`, { signal: AbortSignal.timeout(15_000) });
  if (response.ok && (await response.text()).includes('Operational')) {
    console.log(`Page creation is open at ${base}`);
    process.exit(0);
  }
  if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 2_000));
}
throw Error(`Page creation did not reopen at ${base}`);
