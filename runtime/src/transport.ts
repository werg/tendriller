import { createTransportDiagnostics } from '../../collaboration/transport-diagnostics.mjs';
import type { RuntimeTransport, TransportDiagnostics, TransportDiagnosticSource, TransportDiagnosticReport } from '../../contract/transport-diagnostics.mjs';

/** One page registers its participant, without granting the runtime data access. */
export function createTransportBinding(): { api: RuntimeTransport; suspend(): void; resume(): void } {
  let source: TransportDiagnosticSource | undefined, inspector: TransportDiagnostics = createTransportDiagnostics();
  let off = () => {}, suspended = false;
  const listeners = new Set<(report: TransportDiagnosticReport) => void>();
  const emit = (report: TransportDiagnosticReport) => { for (const listener of [...listeners]) try { void Promise.resolve(listener(report)).catch(() => {}); } catch {} };
  const observe = () => { inspector = createTransportDiagnostics(source); if (inspector.status().state === 'closed') emit(inspector.status()); else off = inspector.onChange(emit); };
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
  return { api,
    suspend() { if (suspended) return; suspended = true; off(); inspector.close(); },
    resume() { if (!suspended) return; suspended = false; observe(); },
  };
}
