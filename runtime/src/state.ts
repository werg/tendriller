// One JSON/path implementation for authority, optimism, replay and preview.
import { statePath, readStatePath, applyStateOps, stateMergePatch, isStateObject } from "../../contract/state.mjs";
import type { NormalizedStateOp } from "../../contract/state.mjs";
import type { Path } from "./types";
export type Op = NormalizedStateOp;
export const isPlainObject = isStateObject;
export function toPath(path?: Path | null): string[] { return statePath(path ?? []); }
export function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
export function getPath(root: unknown, path: string[]): any { return readStatePath(root, path).value; }
export const mergePatchToOps = stateMergePatch;
export const applyOps = applyStateOps;
export function applyOp(root: Record<string, any>, op: Op): Record<string, any> { return applyOps(root, [op]); }
