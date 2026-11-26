import { createTransportDiagnostics } from '../../session/transport-diagnostics.mjs';
import type { RuntimeTransport, TransportDiagnostics, TransportDiagnosticSource, TransportDiagnosticReport } from '../../contract/transport-diagnostics.mjs';
import { describeTransportPeer, type AdmissionMembers, type PeerDirectory } from './transport-peers';

type AgentRoster = () => PeerDirectory['agents'];
const rosters = new WeakMap<RuntimeTransport, (roster: AgentRoster | null) => void>();
const ADMISSION_READ_MS = 5000;

/** Lets the page's own menu name links by the page agent roster's public handles.
 * The roster is read locally on each report; peer keys never enter the report. */
export function nameTransportAgents(api: RuntimeTransport, roster: AgentRoster | null): void { rosters.get(api)?.(roster); }

const admissionOf = (value: unknown): AdmissionMembers | null =>
  value && typeof value === 'object' && Array.isArray((value as AdmissionMembers).members) ? value as AdmissionMembers : null;

/** One page registers its participant, without granting the runtime data access. */
export function createTransportBinding(): { api: RuntimeTransport; suspend(): void; resume(): void } {
  let roster: AgentRoster | null = null, admission: AdmissionMembers | null = null;
  const describePeer = (peerId: string) => {
    let agents: PeerDirectory['agents'] = [];
    try { agents = roster?.() ?? []; } catch {}
    return describeTransportPeer(peerId, { agents, admission });
  };
  let source: TransportDiagnosticSource | undefined, inspector: TransportDiagnostics = createTransportDiagnostics(undefined, { describePeer });
  let off = () => {}, suspended = false;
  const listeners = new Set<(report: TransportDiagnosticReport) => void>();
  const emit = (report: TransportDiagnosticReport) => { for (const listener of [...listeners]) try { void Promise.resolve(listener(report)).catch(() => {}); } catch {} };
  const extensions = () => typeof source?.extensions?.call === 'function' && typeof source.extensions.subscribe === 'function' ? source.extensions : null;
  const adopt = (value: unknown) => { const next = admissionOf(value); if (next) { admission = next; emit(inspector.status()); } };
  const observe = () => {
    inspector = createTransportDiagnostics(source, { describePeer });
    if (inspector.status().state === 'closed') { emit(inspector.status()); return; }
    const stopReport = inspector.onChange(emit);
    // The owner's admission extension pushes each signed membership change; this is a local port, never a host read.
    let stopAdmission = () => {};
    try { stopAdmission = extensions()?.subscribe(notice => { const value = notice as { topic?: unknown; state?: unknown } | null; if (value?.topic === 'admission') adopt(value.state); }) ?? (() => {}); } catch {}
    off = () => { stopReport(); try { stopAdmission(); } catch {} };
  };
  // An explicit refresh also reads the current admission members once, bounded and best-effort.
  const readAdmission = () => {
    const owner = extensions(); if (!owner) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.resolve().then(() => owner.call('admission.state', [])).then(adopt, () => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, ADMISSION_READ_MS); }),
    ]).finally(() => clearTimeout(timer));
  };
  const api: RuntimeTransport = Object.freeze({
    install(participation: TransportDiagnosticSource) {
      if (!participation || typeof participation !== 'object') throw TypeError('Register an owned application participant');
      if (source) { if (source === participation) return; throw Error('TRANSPORT_ALREADY_INSTALLED'); }
      source = participation; off(); inspector.close(); if (!suspended) observe();
    },
    status: () => inspector.status(),
    async refresh() {
      if (suspended || inspector.status().state !== 'available') return inspector.refresh();
      await Promise.all([inspector.refresh(), readAdmission()]);
      return inspector.status();
    },
    onChange(listener: (report: TransportDiagnosticReport) => void) {
      listeners.add(listener); try { void Promise.resolve(listener(inspector.status())).catch(() => {}); } catch {}
      return () => { listeners.delete(listener); };
    },
  });
  // A roster change renames cached links without another local read.
  rosters.set(api, next => { roster = next; emit(inspector.status()); });
  return { api,
    suspend() { if (suspended) return; suspended = true; off(); off = () => {}; inspector.close(); },
    resume() { if (!suspended) return; suspended = false; observe(); },
  };
}
