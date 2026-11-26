import type { RuntimeTransport, TransportDiagnosticConnection, TransportDiagnosticReport } from '../../contract/transport-diagnostics.mjs';

/** Human data size in decimal units (1 KB = 1000 bytes), e.g. "140.1 KB". */
export function formatDataSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ${units[unit]}`;
}

const size = (value: number | null) => value === null ? 'not measured' : formatDataSize(value);
const route = (link: TransportDiagnosticConnection) => link.kind === 'direct' ? 'Direct connection'
  : link.kind === 'relay' ? link.reason === 'direct_timeout' ? 'Via relay (a direct connection timed out)'
    : link.reason === 'direct_failed' ? 'Via relay (a direct connection could not be made)' : 'Via relay'
  : 'Connection type not reported';

/** Plain-language summary of the bounded local report; never peer keys or addresses. */
export function connectionSummary(report: TransportDiagnosticReport): string {
  const count = report.authenticatedPeers;
  let text = report.state === 'closed' ? report.phase === 'closed' ? 'Not connected. This page has stopped syncing; reload it to reconnect.' : 'Connection details are paused.'
    : report.state === 'unavailable' ? 'Connection details are not available on this page.'
    : count === null ? 'Checking for connected devices…'
    : count > 0 ? `Connected to ${count} ${count === 1 ? 'device' : 'devices'}.`
    : report.phase === 'connecting' ? 'Connecting… Your changes are saved on this device.'
    : 'Not connected. Your changes are saved on this device and will sync when a device or your agent is online.';
  if (report.error) text += report.error === 'timed_out' ? ' Reading connection details took too long; select Refresh to try again.' : ' Connection details could not be read; select Refresh to try again.';
  return text;
}

/** The standard menu renders only the bounded local report, never peer identities. */
export function mountTransportInspector(transport: RuntimeTransport): { element: HTMLElement; open(): void; close(): void } {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
  };
  const section = make('section', 'section'); section.setAttribute('aria-label', 'Application connections');
  const heading = make('h3', undefined, 'Application connections');
  const summary = make('p'); summary.setAttribute('aria-live', 'polite'); summary.setAttribute('aria-atomic', 'true');
  const list = make('ul', 'conn-list'); list.setAttribute('aria-label', 'Connected devices');
  const refresh = make('button', 'secondary', 'Refresh'); refresh.type = 'button'; refresh.setAttribute('aria-label', 'Refresh connection details');
  const technical = make('details', 'conn-tech'); const technicalSummary = make('summary', undefined, 'Technical details');
  const lanes = make('ul'); const sampling = make('p');
  const scope = make('p', undefined, 'Data counts are framed sync payload on the current link, before encryption and network overhead, and restart when a link is replaced. They are not billing figures and do not show that a change was stored or finalized.');
  technical.append(technicalSummary, lanes, sampling, scope);
  section.append(heading, summary, list, technical, refresh);
  let disposed = false, reading = false;
  const render = (report: TransportDiagnosticReport) => {
    if (disposed) return;
    summary.textContent = connectionSummary(report);
    list.replaceChildren(); lanes.replaceChildren();
    let device = 0;
    for (const link of report.connections) {
      const name = link.agent ? `@${link.agent}` : `Device ${++device}`;
      const item = make('li', 'conn-item');
      const data = link.receivedBytes === null && link.sentBytes === null ? 'Data use not measured'
        : `Received ${size(link.receivedBytes)} · Sent ${size(link.sentBytes)}`;
      item.append(make('strong', 'conn-name', name), make('p', 'conn-route', route(link)), make('p', undefined, data));
      list.append(item);
      const detail = [`${name} (link ${link.link}, ${link.kind}${link.reason ? `, ${link.reason.replace('_', ' ')}` : ''})`,
        `reliable ${size(link.sentReliableBytes)} sent, ${size(link.receivedReliableBytes)} received`,
        `live ${size(link.sentLiveBytes)} sent, ${size(link.receivedLiveBytes)} received`];
      if (link.signalRejections?.total != null) detail.push(`${link.signalRejections.total.toLocaleString()} live signals rejected`);
      lanes.append(make('li', undefined, detail.join('; ') + '.'));
    }
    list.hidden = report.connections.length === 0; lanes.hidden = report.connections.length === 0;
    sampling.textContent = (!report.sampled && report.state === 'available' ? 'Not sampled yet; select Refresh.' : 'Sampled on this device when you open this panel or select Refresh.')
      + ' Nothing is polled or probed over the network.' + (report.limited ? ' Some links were left out.' : '');
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
