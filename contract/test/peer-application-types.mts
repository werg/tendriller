import type { ApplicationBackend, ApplicationOperation, ApplicationReadView } from '../application.mjs';
declare const application: ApplicationBackend;
const status = application.status;
application.onRecovery(notice => { const loss: boolean = notice.unknownLoss; void loss; });
application.onStatus(value => { const phase: string = value.phase; void phase; });
void application.inspectRecovery();
async function inspect() {
  const view: ApplicationReadView = await application.readView();
  const label: 'applied' = view.view;
  await view.query('items'); await view.readEvents(); await view.release();
  const operation: ApplicationOperation = await application.submit({}, { operationId: 'edit' });
  if (operation.status === 'applied') { const outcome: 'accepted' | 'rejected' = operation.outcome; void outcome; }
  // @ts-expect-error Finality is not an application outcome.
  if (operation.status === 'final') {}
  // @ts-expect-error Application reads capture one coherent applied revision.
  await application.readView({ view: 'final' });
  void label;
}
void status; void inspect;
