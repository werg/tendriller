import { createTransportDiagnostics } from '../../session/transport-diagnostics.mjs';
import type { RuntimeTransport, TransportDiagnostics, TransportDiagnosticSource, TransportDiagnosticReport } from '../../contract/transport-diagnostics.mjs';

type AgentLookup = (peerId: string) => string | null | undefined;
const namers = new WeakMap<RuntimeTransport, (lookup: AgentLookup | null) => void>();

/** Lets the page's own menu name links by the page agent roster's public handles.
 * The lookup runs locally on each report; peer keys never enter the report. */
export function nameTransportAgents(api: RuntimeTransport, lookup: AgentLookup | null): void { namers.get(api)?.(lookup); }

/** One page registers its participant, without granting the runtime data access. */
export function createTransportBinding(): { api: RuntimeTransport; suspend(): void; resume(): void } {
  let lookup: AgentLookup | null = null;
  const agentHandle = (peerId: string) => lookup?.(peerId) ?? null;
  let source: TransportDiagnosticSource | undefined, inspector: TransportDiagnostics = createTransportDiagnostics(undefined, { agentHandle });
  let off = () => {}, suspended = false;
  const listeners = new Set<(report: TransportDiagnosticReport) => void>();
  const emit = (report: TransportDiagnosticReport) => { for (const listener of [...listeners]) try { void Promise.resolve(listener(report)).catch(() => {}); } catch {} };
  const observe = () => { inspector = createTransportDiagnostics(source, { agentHandle }); if (inspector.status().state === 'closed') emit(inspector.status()); else off = inspector.onChange(emit); };
  const api: RuntimeTransport = Object.freeze({
    install(participation: TransportDiagnosticSource) {
      if (!participation || typeof participation !== 'object') throw TypeError('Register an owned application participant');
      if (source) { if (source === participation) return; throw Error('TRANSPORT_ALREADY_INSTALLED'); }
      source = participation; off(); inspector.close(); if (!suspended) observe();
    },
    status: () => inspector.status(), refresh: () => inspector.refresh(),
    onChange(listener: (report: TransportDiagnosticReport) => void) {
      listeners.add(listener); try { void Promise.resolve(listener(inspector.status())).catch(() => {}); } catch {}
      return () => { listeners.delete(listener); };
    },
  });
  // A roster change renames cached links without another local read.
  namers.set(api, next => { lookup = next; emit(inspector.status()); });
  return { api,
    suspend() { if (suspended) return; suspended = true; off(); inspector.close(); },
    resume() { if (!suspended) return; suspended = false; observe(); },
  };
}
