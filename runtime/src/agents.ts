import type { AgentLiveStatus, HostedMcpConnectInput, PageAgentRoster, PagePersonEntry, PageViewerInfo, RuntimeAgents } from "../../contract/index.mjs";
import type { AgentsRosterNotice, PageAgentEntry } from "../../contract/publication-watch.mjs";
import type { TendrilConfig } from "./types";

const storageKey = (pageId: string) => `tendril:agents:${pageId}`;

function readCached(pageId: string): { primary_agent_id: string | null; agents: PageAgentEntry[] } {
  try {
    const raw = localStorage.getItem(storageKey(pageId));
    if (!raw) return { primary_agent_id: null, agents: [] };
    const parsed = JSON.parse(raw) as { primary_agent_id?: unknown; agents?: unknown };
    if (!Array.isArray(parsed?.agents)) return { primary_agent_id: null, agents: [] };
    return {
      primary_agent_id: typeof parsed.primary_agent_id === "string" ? parsed.primary_agent_id : null,
      agents: parsed.agents.filter((item): item is PageAgentEntry =>
        Boolean(item && typeof item === "object" && typeof (item as PageAgentEntry).id === "string" && typeof (item as PageAgentEntry).handle === "string")),
    };
  } catch {
    return { primary_agent_id: null, agents: [] };
  }
}

function writeCached(pageId: string, primary_agent_id: string | null, agents: readonly PageAgentEntry[]): void {
  try {
    localStorage.setItem(storageKey(pageId), JSON.stringify({ primary_agent_id, agents }));
  } catch {
    /* Private browsing / blocked storage: in-memory roster still works. */
  }
}

export interface AgentsStore {
  readonly api: RuntimeAgents;
  applyNotice(notice: AgentsRosterNotice): void;
}

export function createAgentsStore(cfg: TendrilConfig): AgentsStore {
  const cached = readCached(cfg.id);
  let primaryId: string | null = cached.primary_agent_id;
  let agents: PageAgentEntry[] = cached.agents;
  let canManage: boolean | undefined;
  let dashboard: string | undefined;
  let connections: string | undefined;
  let platforms: string | undefined;
  let viewer: PageViewerInfo | undefined;
  let people: PagePersonEntry[] = [];
  let pendingGuests: number | undefined;
  let live: Record<string, AgentLiveStatus> = {};
  let mcpConnector: ((input: HostedMcpConnectInput) => Promise<unknown>) | null = null;
  const listeners = new Set<(roster: PageAgentRoster) => void>();

  const snapshot = (): PageAgentRoster => Object.freeze({
    primary_agent_id: primaryId,
    agents: Object.freeze(agents.map(item => Object.freeze({ ...item }))),
    ...(canManage !== undefined ? { can_manage: canManage } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(connections ? { connections } : {}),
    ...(platforms ? { platforms } : {}),
    ...(viewer ? { viewer: Object.freeze({ ...viewer }) } : {}),
    ...(people.length ? { people: Object.freeze(people.map(item => Object.freeze({ ...item }))) } : {}),
    ...(pendingGuests !== undefined ? { pending_guests: pendingGuests } : {}),
    live: Object.freeze({ ...live }),
  });

  const emit = () => {
    const current = snapshot();
    for (const listener of listeners) {
      try { listener(current); } catch { /* Listener errors cannot break roster delivery. */ }
    }
  };

  const applyRoster = (data: {
    primary_agent_id?: string | null;
    agents?: readonly PageAgentEntry[];
    can_manage?: boolean;
    dashboard?: string;
    connections?: string;
    platforms?: string;
    viewer?: PageViewerInfo;
    people?: readonly PagePersonEntry[];
    pending_guests?: number;
  }) => {
    primaryId = typeof data.primary_agent_id === "string" ? data.primary_agent_id : null;
    if (Array.isArray(data.agents)) {
      agents = data.agents.map(item => ({
        id: item.id,
        handle: item.handle,
        bio: item.bio ?? "",
        public_key: item.public_key,
        kind: item.kind === "hosted-mcp" ? "hosted-mcp" : "workspace",
        is_primary: item.id === primaryId || Boolean(item.is_primary),
        granted_at: Number(item.granted_at ?? 0),
      }));
    }
    if (typeof data.can_manage === "boolean") canManage = data.can_manage;
    if (typeof data.dashboard === "string") dashboard = data.dashboard;
    if (typeof data.connections === "string") connections = data.connections;
    if (typeof data.platforms === "string") platforms = data.platforms;
    if (data.viewer && typeof data.viewer.handle === "string") viewer = { ...data.viewer };
    if (Array.isArray(data.people)) {
      people = data.people.filter((p): p is PagePersonEntry => Boolean(p && typeof p.id === "string" && typeof p.handle === "string")).map(p => ({ ...p }));
    }
    if (typeof data.pending_guests === "number") pendingGuests = data.pending_guests;
    writeCached(cfg.id, primaryId, agents);
    emit();
    return snapshot();
  };

  const baseUrl = () => new URL(cfg.base, location.href).href;

  const api: RuntimeAgents = Object.freeze({
    snapshot,
    async refresh() {
      const res = await fetch(`${baseUrl()}_tendril/agents`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(err?.error?.message || `Could not load agents (${res.status})`);
      }
      const data = await res.json() as {
        primary_agent_id?: string | null;
        agents?: PageAgentEntry[];
        can_manage?: boolean;
        dashboard?: string;
        connections?: string;
        platforms?: string;
        viewer?: PageViewerInfo;
        people?: PagePersonEntry[];
        pending_guests?: number;
      };
      return applyRoster(data);
    },
    async setPrimary(agentId: string | null) {
      const res = await fetch(`${baseUrl()}_tendril/agents/primary`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId }),
      });
      const data = await res.json().catch(() => null) as {
        primary_agent_id?: string | null;
        agents?: PageAgentEntry[];
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(data?.error?.message || `Could not update primary agent (${res.status})`);
      return applyRoster(data ?? { primary_agent_id: agentId, agents });
    },
    onChange(listener: (roster: PageAgentRoster) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    resolveHandle(handleOrKey: string) {
      const raw = String(handleOrKey ?? "").trim();
      if (!raw) return null;
      const normalized = raw.replace(/^@+/, "").toLowerCase();
      return agents.find(item =>
        item.id === raw || item.public_key === raw || item.handle.toLowerCase() === normalized,
      ) ?? null;
    },
    reportLiveStatus(map: Record<string, AgentLiveStatus>) {
      live = { ...map };
      emit();
    },
    get canConnectMcp() {
      return mcpConnector !== null;
    },
    registerMcpConnector(connector: (input: HostedMcpConnectInput) => Promise<unknown>) {
      mcpConnector = connector;
      emit();
      return () => {
        if (mcpConnector === connector) {
          mcpConnector = null;
          emit();
        }
      };
    },
    async connectMcp(input: HostedMcpConnectInput) {
      if (!mcpConnector) {
        throw new Error("This page has not registered an in-browser hosted MCP connector yet.");
      }
      return await mcpConnector(input);
    },
  });

  return {
    api,
    applyNotice(notice: AgentsRosterNotice) {
      if (!notice || notice.type !== "agents" || !Array.isArray(notice.agents)) return;
      applyRoster({ primary_agent_id: notice.primary_agent_id ?? null, agents: notice.agents });
    },
  };
}
