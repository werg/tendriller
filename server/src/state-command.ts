import type { Tendril } from "./tendril";
import type { ScopeDescriptor, StateConflict } from "../../contract/index.mjs";
import { mutate, preconditions } from "./scopes";
import { validateOps, validateStateChecks, statePaths } from "./state";
import { HttpError } from "./http";

type StateReceipt = { rev: number; scopes: ScopeDescriptor[]; error?: never }
  | { error: "state_conflict"; message: string; rev: number; conflict: StateConflict };

/** Both accepted writes and state conflicts have one durable, immutable outcome. */
export function stateCommand(t: Tendril, actor: string, input: unknown, rawOps: unknown, except?: WebSocket): StateReceipt {
  const ops = validateOps(rawOps), checks = validateStateChecks(input), command = preconditions(input);
  return mutate(t, actor, command, { paths: statePaths(ops, checks), operations: ["state"] }, { ops, ...checks }, () => {
    try { return { rev: t.applyState(ops, actor, except, { ...command, ...checks }), scopes: t.getState().scopes }; }
    catch (error) {
      if (!(error instanceof HttpError) || error.code !== "state_conflict") throw error;
      // Persist before the transport reports rejection. Throwing here would
      // roll the receipt back and allow the same command to succeed on retry.
      return { error: "state_conflict", message: error.message, rev: error.extra!.rev as number, conflict: error.extra!.conflict as StateConflict };
    }
  });
}
