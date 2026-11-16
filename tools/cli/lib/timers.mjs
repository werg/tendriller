import { randomUUID } from "node:crypto";
import { runSavedCommand } from "./command-record.mjs";

/** Preserve a reviewed timer command across process loss and uncertain replies. */
export async function changeTimer(api, operation, timer, settings, {
  cid, expectedRevision, expectedGenerations = {}, scope, resumeFile, destination,
} = {}) {
  if (typeof destination !== "string") throw new TypeError("Timer commands require their page API destination");
  const target = new URL(destination);
  if (!/^https?:$/.test(target.protocol) || target.search || target.hash) throw new TypeError("Invalid timer page API destination");
  const pageApi = target.origin + target.pathname.replace(/\/+$/, "");
  if (!["create", "update", "delete"].includes(operation)) throw new TypeError("Unknown timer operation");
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new TypeError("Timer settings must be an object");
  for (const field of ["cid", "expected_revision", "expected_generations", "scope"])
    if (Object.hasOwn(settings, field)) throw new TypeError(`Supply timer ${field} through its command flag, not inside settings`);
  if (operation !== "create" && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
    throw new TypeError("Timer changes require the explicitly reviewed revision");
  if (operation !== "create" && (typeof timer !== "string" || !timer)) throw new TypeError("A timer ID is required");
  if (operation === "create" && expectedRevision !== undefined) throw new TypeError("Creation does not take a timer revision");
  const path = operation === "create" ? "/timers" : `/timers/${encodeURIComponent(timer)}`;
  return runSavedCommand({ resumeFile,
    intent: { destination: pageApi, operation, timer: timer ?? null, settings, cid: cid ?? null,
      expectedRevision: expectedRevision ?? null, expectedGenerations, scope: scope ?? null },
    requestSchema: operation === "create" ? "timerCreate" : operation === "update" ? "timerWrite" : "timerDelete",
    resultSchema: operation === "delete" ? "timerDeleted" : "timer",
    prepare(original) {
      return { ...original.settings, cid: original.cid ?? randomUUID(), expected_generations: original.expectedGenerations,
        ...(original.scope === null ? {} : { scope: original.scope }),
        ...(original.expectedRevision === null ? {} : { expected_revision: original.expectedRevision }) };
    },
    send: body => operation === "create" ? api.post(path, body) : operation === "update" ? api.patch(path, body) : api.del(path, { json: body }),
  });
}
