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

export async function assignPrivateTask(handle: PageHandle, participantId: string) {
  const page = createClient(handle);
  const { participants } = await page.participants();
  if (!participants.some(participant => participant.id === participantId)) throw new Error("Choose an approved participant");
  const assignment = await page.createAssignment({ participant: participantId, title: "Observer", prompt: "Describe the quietest corner." });
  return page.updateAssignment(assignment.id, { expected_revision: assignment.revision, feedback: "You can take a moment before answering." });
}

export async function archiveFinishedNotebook(handle: PageHandle, requestId: string) {
  const page = createClient(handle);
  // Call only after reviewing the finished workflow and waiting for local work.
  const preview = await page.previewArchive("notebook");
  return page.createArchive({ scope: "notebook", title: "Completed notebook", request_id: requestId,
    expected_state_revision: preview.state_revision, expected_interaction_revision: preview.interaction_revision });
}
