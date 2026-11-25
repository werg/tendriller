import type { RuntimeTransport, TransportDiagnosticReport } from '../../contract/transport-diagnostics.mjs';

/** The standard menu renders only the bounded local report, never peer identities. */
export function mountTransportInspector(transport: RuntimeTransport): { element: HTMLElement; open(): void; close(): void } {
  const section = document.createElement('section'); section.className = 'section'; section.setAttribute('aria-label', 'Application connections');
  const heading = document.createElement('h3'); heading.textContent = 'Application connections';
  const summary = document.createElement('p'); summary.setAttribute('aria-live', 'polite'); summary.setAttribute('aria-atomic', 'true');
  const scope = document.createElement('p'); scope.className = 'note'; scope.textContent = 'Authenticated session links only. A raw transport selection is not a successful connection. Counters measure framed payload, excluding encryption/socket overhead and SDP. Counters belong to the current link and reset on replacement. They are not billing or stored/materialized/retained/finalized operation proof.';
  const list = document.createElement('ul');
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'secondary'; refresh.textContent = 'Refresh connection details';
  const freshness = document.createElement('p'); freshness.className = 'note'; freshness.textContent = 'Local samples only; no periodic polling or network probes.';
  section.append(heading, summary, scope, list, refresh, freshness);
  let disposed = false, reading = false;
  const amount = (value: number | null, unit: string) => value === null ? 'unavailable' : `${value.toLocaleString()} ${unit}`;
  const render = (report: TransportDiagnosticReport) => {
    if (disposed) return;
    const count = report.authenticatedPeers;
    summary.textContent = report.state === 'closed' ? report.phase === 'closed' ? 'The application participant is closed.' : 'Local connection observation is closed.'
      : report.state === 'unavailable' ? count === null ? 'Connection details unavailable. This page has not registered a participant with local diagnostics.' : 'This participant does not expose local connection details.'
      : count === null ? 'Authenticated connectivity has not been reported.'
      : `${count} authenticated ${count === 1 ? 'peer' : 'peers'} reported. Application state: ${report.phase.replaceAll('-', ' ')}.`;
    if (report.error) summary.textContent += report.error === 'timed_out' ? ' The local read timed out; try refreshing.' : ' Local details could not be read; try refreshing.';
    list.replaceChildren();
    for (const link of report.connections) {
      const item = document.createElement('li'), title = document.createElement('strong'), data = document.createElement('p');
      title.textContent = `Link ${link.link}: ${link.kind === 'direct' ? 'Direct' : link.kind === 'relay' ? 'Relay' : 'Transport unavailable'} (authenticated)`;
      data.textContent = `Sent: ${amount(link.sentBytes, 'bytes')}; received: ${amount(link.receivedBytes, 'bytes')}. Peer protocol requests: ${amount(link.sentRequests, 'sent')}; ${amount(link.receivedRequests, 'received')}.`;
      const lanes = document.createElement('p'); lanes.className = 'note';
      lanes.textContent = `Reliable: ${amount(link.sentReliableBytes, 'sent bytes')}; ${amount(link.receivedReliableBytes, 'received bytes')}. Live: ${amount(link.sentLiveBytes, 'sent bytes')}; ${amount(link.receivedLiveBytes, 'received bytes')}.`;
      item.append(title, data, lanes);
      if (link.reason) { const reason = document.createElement('p'); reason.className = 'note'; reason.textContent = link.reason === 'direct_timeout' ? 'Fallback reason: the direct attempt timed out.' : 'Fallback reason: the direct attempt failed.'; item.append(reason); }
      list.append(item);
    }
    if (!report.sampled && report.state === 'available') freshness.textContent = 'Select Refresh for current local transport details. No periodic polling or network probes.';
    else freshness.textContent = 'Last local sample; counters are not continuously monitored. No network probes.';
    if (report.limited) freshness.textContent += ' Some details were omitted.';
    refresh.disabled = reading || report.state !== 'available';
  };
  const read = async () => {
    if (disposed || reading || transport.status().state !== 'available') return;
    reading = true; refresh.disabled = true;
    try { await transport.refresh(); }
    finally { reading = false; if (!disposed) render(transport.status()); }
  };
  refresh.addEventListener('click', () => { void read(); });
  const off = transport.onChange(render);
  return { element: section, open() { void read(); }, close() { disposed = true; off(); section.remove(); } };
}
