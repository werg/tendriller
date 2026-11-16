import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { assertValid } from "@tendriller/core/contract";

function save(file, record) {
  if (!file) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch {} }
}

/** Capture a metadata command once; a lost reply never recaptures live guards. */
export async function runSavedCommand({ resumeFile, intent, prepare, send, requestSchema, resultSchema }) {
  const original = structuredClone(intent);
  let record = resumeFile && existsSync(resumeFile) ? JSON.parse(readFileSync(resumeFile, "utf8")) : null;
  if (record && !isDeepStrictEqual(record.intent, original))
    throw new Error("The saved command does not match this intent; choose a new resume record for new work");
  if (!record) {
    record = { intent: original, request: assertValid(requestSchema, await prepare(original)), phase: "pending" };
    save(resumeFile, record);
  }
  if (record.phase === "accepted") return assertValid(resultSchema, record.result);
  const result = assertValid(resultSchema, await send(assertValid(requestSchema, record.request)));
  save(resumeFile, { ...record, phase: "accepted", result });
  return result;
}
