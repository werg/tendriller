// Calm, zero-jargon review card for AI Agent "Data PRs" (SQL branch proposals).
import { approveSqlProposal, dismissSqlProposal } from '../helpers/proposals.mjs';

/**
 * Render a reviewable proposal card showing plain-English change counts, expandable row diff,
 * and 1-click Approve / Dismiss buttons.
 */
export function renderProposalCard(session, item, { workflowTopic = 'proposals', onResolved } = {}) {
  const card = document.createElement('section');
  card.className = 'tendril-proposal-card';
  const summary = item?.payload?.summary ?? { totalChanges: 0, inserted: 0, updated: 0, deleted: 0, tables: [] };

  const header = document.createElement('div');
  header.className = 'tendril-proposal-header';
  const title = document.createElement('strong');
  title.textContent = item.title || 'Proposed updates';
  const badge = document.createElement('span');
  badge.className = 'tendril-proposal-badge';
  badge.textContent = `${summary.totalChanges} change${summary.totalChanges === 1 ? '' : 's'} (+${summary.inserted} / ~${summary.updated} / -${summary.deleted})`;
  header.append(title, ' ', badge);

  const details = document.createElement('details');
  const detailsSummary = document.createElement('summary');
  detailsSummary.textContent = 'Preview changes';
  const list = document.createElement('ul');
  for (const tbl of item?.payload?.diff?.tables ?? []) {
    for (const row of tbl.inserted ?? []) {
      const li = document.createElement('li');
      li.textContent = `+ ${tbl.table}: ${JSON.stringify(row)}`;
      list.append(li);
    }
    for (const upd of tbl.updated ?? []) {
      const li = document.createElement('li');
      li.textContent = `~ ${tbl.table} (${JSON.stringify(upd.key)}): updated`;
      list.append(li);
    }
    for (const row of tbl.deleted ?? []) {
      const li = document.createElement('li');
      li.textContent = `- ${tbl.table}: ${JSON.stringify(row)}`;
      list.append(li);
    }
  }
  details.append(detailsSummary, list);

  const actions = document.createElement('div');
  actions.className = 'tendril-proposal-actions';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.textContent = 'Approve & apply';
  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    dismissBtn.disabled = true;
    status.textContent = 'Applying…';
    try {
      const res = await approveSqlProposal(session, { id: item.id, workflowTopic });
      status.textContent = res.applied ? 'Applied.' : `Could not apply (${res.reason || 'changed concurrently'}).`;
      onResolved?.(res);
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      approveBtn.disabled = false;
      dismissBtn.disabled = false;
    }
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    dismissBtn.disabled = true;
    try {
      const res = await dismissSqlProposal(session, { id: item.id, workflowTopic });
      status.textContent = res.dismissed ? 'Dismissed.' : 'Could not dismiss.';
      onResolved?.(res);
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      approveBtn.disabled = false;
      dismissBtn.disabled = false;
    }
  });

  actions.append(approveBtn, ' ', dismissBtn, ' ', status);
  card.append(header, details, actions);
  return card;
}
