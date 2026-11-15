// Typechecked SDK examples. Private handles belong in the host's private storage.
import { createClient, type PageHandle } from "../client.mjs";

export async function continuePage(handle: PageHandle, lastHandledSequence: number) {
  const page = createClient(handle);
  const context = await page.session();
  const batch = await page.readEvents({ after: lastHandledSequence, wait: 300 });
  const latest = batch.events.at(-1);
  if (latest) await page.say({ text: "I received your measurement.", in_reply_to: latest.seq });
  // Reading or replying alone does not mean work is handled. Return the batch
  // for the host to process before it persists a handled checkpoint.
  return { context, batch };
}

export async function writeProtectedState(handle: PageHandle, scopeId: string) {
  const page = createClient(handle);
  const { scopes } = await page.scopes();
  const scope = scopes.find(item => item.id === scopeId);
  if (!scope) throw new Error("The scope is unavailable");
  // Persist this entire command before delivery; retries retain the same token.
  const command = {cid:crypto.randomUUID(),scope:scopeId,expected_generations:{[scopeId]:scope.generation},
    ops:[{op:"set" as const,path:["job","status"],value:"complete"}]};
  return page.updateState(command);
}
