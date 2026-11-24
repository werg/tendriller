import { mountListDetail, mountInlineReview, mountViewState } from './patterns.mjs';
import { mountConnectionView } from '../connect-view.mjs';

const root = document.querySelector('#workspace');
const node = (tag, text, className) => {
  const result = document.createElement(tag); result.textContent = text;
  if (className) result.className = className; return result;
};
if (new URL(location.href).searchParams.has('states')) {
  document.querySelector('h1').textContent = 'Every state has a next step';
  root.className = 'state-grid';
  for (const state of [
    { phase:'loading', title:'Loading episodes…', detail:'Your review workspace will appear here.' },
    { phase:'empty', title:'No episodes yet', detail:'Import a training run to start your first review.', action:{ label:'Import a run', run() {} } },
    { phase:'error', title:'Episodes could not be loaded', detail:'Your draft is safe. Check the connection and try again.', action:{ label:'Try again', run() {} } },
  ]) {
    const panel = document.createElement('div'); panel.className = 'sample'; root.append(panel);
    mountViewState(panel).render(state);
  }
  const slot = document.createElement('div'); root.append(slot);
  mountConnectionView(slot).render({
    phase:'approve', title:'Approve this browser', detail:'Continue on the service to connect this browser to your app.',
    action:{ label:'Approve this browser', run() {} },
  });
} else {
  const records = [
    { id:'episode-17', title:'The missing delivery', subtitle:'Episode 017 · 6 actions · Needs review', status:'review',
      summary:'The agent checks the order, confirms the new delivery date, and asks before contacting the carrier.' },
    { id:'episode-18', title:'A calendar conflict', subtitle:'Episode 018 · 4 actions · Reviewed', status:'reviewed',
      summary:'The agent proposes two available times and keeps the original booking until the person chooses.' },
    { id:'episode-19', title:'A clearer project brief', subtitle:'Episode 019 · 5 actions · Needs review', status:'review',
      summary:'The agent turns a rough brief into a scoped plan with explicit open questions.' },
  ];
  mountListDetail(root, {
    records, searchLabel:'Search episodes', filters:[['review','Needs review'],['reviewed','Reviewed']],
    renderDetail(record, content) {
      content.append(node('span', record.status === 'review' ? 'Needs review' : 'Reviewed', 'tag'), node('span', 'Agent actions', 'tag'));
      const summary = node('p', record.summary, 'episode-summary');
      content.append(summary);
      const heading = node('h3', 'What the agent did'), timeline = document.createElement('ol'); timeline.className = 'timeline';
      for (const [title, body] of [
        ['Understood the request', 'Identified the person’s goal and checked the available evidence.'],
        ['Checked the source', 'Read the relevant record before proposing a change.'],
        ['Asked before acting', 'Prepared a clear next step for the person to review.'],
      ]) {
        const item = document.createElement('li'); item.append(node('strong', title), node('span', body)); timeline.append(item);
      }
      content.append(heading, timeline);
      const details = document.createElement('details'); details.className = 'context';
      details.append(node('summary', 'System context · 18,000 characters'), node('p', 'Instruction context. '.repeat(900)));
      content.append(details);
      const related = node('p', 'Consumed by '), link = node('a', 'Customer support training run');
      link.href = '?item=episode-18'; related.append(link); content.append(related);
      const confirmSummary = ({ after }) => {
        record.summary = after; summary.textContent = after;
        return { confirmed:true, value:after };
      };
      const editor = mountInlineReview(content, {
        label:'Reviewer summary', value:record.summary,
        // Demonstration only. In a connected app, capture the revision and
        // original operation ID, then confirm the accepted applied result.
        onSave:confirmSummary, onUndo:confirmSummary,
      });
      return () => editor.close();
    },
  });
}
