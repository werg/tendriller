const t = window.tendril, $ = id => document.getElementById(id);
const own = () => t.connected && t.device.role === 'owner' && !t.device.pending;
const participates = () => t.connected && t.device.role !== 'display' && !t.device.pending;
let identity = null, ownerIdentity = null, loadVersion = 0, ownerVersion = 0;
const cards = new Map(), reviews = new Map();
const retained = new Map();
const scope = window.__TENDRIL__?.id || location.pathname;
async function request(path, method = 'GET', body) {
  const response = await fetch(`_tendril/${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'This change could not be saved.');
  return result;
}
function element(tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
const note = text => { $('task-status').textContent = text; };
const managerNote = text => { $('assignment-status').textContent = text; };
function draftKey(id) { return `tendril:${scope}:assignment:${identity}:${id}`; }
function saveDraft(card) {
  if (!identity) return;
  try { if (card.input.value.trim() !== card.answer) localStorage.setItem(draftKey(card.item.id), card.input.value); else localStorage.removeItem(draftKey(card.item.id)); }
  catch { note('Keep this page open until your answer is saved; this browser could not save the draft.'); }
}
function renderRetained() {
  $('retained-drafts').hidden = !retained.size || !participates(); $('retained-draft-list').replaceChildren();
  for (const draft of retained.values()) { const label = element('label', draft.title), field = element('textarea'); field.value = draft.answer; field.readOnly = true; label.append(field); $('retained-draft-list').append(label); }
}
function retainDraft(draft) { if (!draft.participant || draft.participant !== (identity || ownerIdentity) || !draft.answer.trim()) return; retained.set(draft.prompt_id, draft); renderRetained(); }
function clearPrivate(clearDrafts = true) { ++loadVersion; ++ownerVersion; identity = ownerIdentity = null; cards.clear(); reviews.clear(); $('my-tasks').replaceChildren(); $('assignment-list').replaceChildren(); $('assignment-participant').replaceChildren(); $('participant-code').textContent = ''; if (clearDrafts) retained.clear(); renderRetained(); }
window.addEventListener('tendril:private-draft-saved', event => retainDraft(event.detail));
$('download-retained-drafts').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'tendriller-private-drafts', version: 1, drafts: [...retained.values()] }, null, 2)], { type: 'application/json' })); const link = element('a'); link.href = url; link.download = 'private-session-drafts.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
$('discard-retained-drafts').onclick = () => { for (const draft of retained.values()) { try { localStorage.removeItem(`tendril:${scope}:response:${draft.participant}:${draft.prompt_id}`); if (draft.prompt_id.startsWith('assignment:')) localStorage.removeItem(`tendril:${scope}:assignment:${draft.participant}:${draft.prompt_id.slice(11)}`); if (draft.prompt_id.startsWith('feedback:')) localStorage.removeItem(`tendril:${scope}:feedback:${draft.participant}:${draft.prompt_id.slice(9)}`); } catch {} } retained.clear(); renderRetained(); };
function cardFor(item) {
  let card = cards.get(item.id);
  if (card) return card;
  const root = element('article'), title = element('h3'), prompt = element('p'), feedback = element('p'), label = element('label', 'Your private answer'), input = element('textarea'), saved = element('p'), send = element('button', 'Send task answer'), restore = element('button', 'Use saved task answer');
  input.maxLength = 8000; input.rows = 4; label.append(input); prompt.style.whiteSpace = feedback.style.whiteSpace = 'pre-wrap';
  root.append(title, prompt, feedback, label, send, restore, saved); $('my-tasks').append(root);
  card = { root, title, prompt, feedback, input, saved, send, item, answer: '', responseRevision: 0, busy: false };
  input.oninput = () => saveDraft(card);
  restore.onclick = () => { input.value = card.answer; saveDraft(card); note('Saved task answer restored.'); };
  send.onclick = async () => {
    if (!participates() || card.busy || card.item.status !== 'open' || !input.value.trim()) return;
    const participant = identity, assignment = card.item, answer = input.value.trim(); card.busy = true; send.disabled = true; note('Saving your private task answer…');
    try {
      const result = await request('responses', 'POST', { prompt_id: assignment.prompt_id, answer,
        expected_assignment_revision: assignment.revision, ...(card.responseRevision ? { expected_revision: card.responseRevision } : {}) });
      if (identity !== participant) return;
      card.answer = answer; card.responseRevision = result.revision; saveDraft(card); saved.textContent = `Saved answer · revision ${result.revision}`;
      note(input.value.trim() === answer ? 'Task answer saved privately.' : 'Your previous answer is saved. Your newer draft is kept.');
    } catch (error) { note(`${error.message} Your draft is kept. Refresh my tasks to review the latest instructions before sending again.`); }
    finally { card.busy = false; send.disabled = card.item.status !== 'open'; }
  };
  cards.set(item.id, card); return card;
}
async function loadMine() {
  $('private-tasks').hidden = !participates();
  if (!participates()) return;
  const version = ++loadVersion;
  try {
    const [data, answers] = await Promise.all([request('assignments'), request('responses')]);
    if (version !== loadVersion || !participates()) return;
    if (identity && identity !== data.participant) { cards.clear(); retained.clear(); renderRetained(); $('my-tasks').replaceChildren(); }
    identity = data.participant;
    $('participant-code').textContent = identity ? `Your participant code: ${identity.slice(0, 8)}` : '';
    try {
      const currentPrompt = t.state.get('facilitation.prompt.id') || 'opening';
      const currentTasks = new Set(data.assignments.map(item => item.id));
      const answerPrefix = `tendril:${scope}:response:${identity}:`, taskPrefix = `tendril:${scope}:assignment:${identity}:`;
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index); if (!key) continue;
        if (key.startsWith(answerPrefix) && key.slice(answerPrefix.length) !== currentPrompt)
          retainDraft({ participant: identity, prompt_id: key.slice(answerPrefix.length), title: 'Earlier question', answer: localStorage.getItem(key) || '' });
        if (key.startsWith(taskPrefix) && !currentTasks.has(key.slice(taskPrefix.length)))
          retainDraft({ participant: identity, prompt_id: `assignment:${key.slice(taskPrefix.length)}`, title: 'Earlier private task', answer: localStorage.getItem(key) || '' });
      }
    } catch { /* Existing in-memory drafts remain available when storage is disabled. */ }
    const present = new Set();
    for (const item of data.assignments) {
      present.add(item.id); const card = cardFor(item), changed = card.item.revision !== item.revision;
      const answer = answers.responses.find(row => row.prompt_id === item.prompt_id);
      const clean = card.input.value.trim() === card.answer; card.item = item; card.answer = answer?.answer || ''; card.responseRevision = answer?.revision || 0;
      if (clean) { let draft = null; try { draft = localStorage.getItem(draftKey(item.id)); } catch {} card.input.value = draft ?? card.answer; }
      card.title.textContent = item.title; card.prompt.textContent = item.prompt; card.feedback.textContent = item.feedback ? `Facilitator feedback: ${item.feedback}` : '';
      card.feedback.hidden = !item.feedback; card.send.disabled = card.busy || item.status !== 'open'; card.input.readOnly = item.status !== 'open';
      card.saved.textContent = item.status === 'closed' ? 'This task is closed. Your answer and feedback are kept.' : answer ? `Saved answer · revision ${answer.revision}` : 'No answer sent yet.';
      if (changed && !clean) note('The task changed. Your draft is kept; review the new instructions before sending.');
    }
    for (const [id, card] of cards) if (!present.has(id)) { card.root.remove(); cards.delete(id); }
    if (!data.assignments.length) note('No private tasks yet. The shared question above is still available.');
  } catch (error) { if (version === loadVersion) note(error.message); }
}
function reviewFor(item) {
  let review = reviews.get(item.id); if (review) return review;
  const root = element('article'), title = element('h3'), recipient = element('small'), instructions = element('p'), answer = element('p'), label = element('label', 'Private feedback'), feedback = element('textarea'), save = element('button', 'Save private feedback'), close = element('button', 'Close task');
  feedback.maxLength = 8000; label.append(feedback); instructions.style.whiteSpace = answer.style.whiteSpace = 'pre-wrap';
  const actions = element('div'); actions.className = 'actions'; actions.append(save, close); root.append(title, recipient, instructions, answer, label, actions); $('assignment-list').append(root);
  review = { root, title, recipient, instructions, answer, feedback, save, close, item, clean: '', busy: false };
  const saveLocalFeedback = () => { if (!ownerIdentity || !own()) return; try { const key = `tendril:${scope}:feedback:${ownerIdentity}:${item.id}`; if (feedback.value.trim() !== review.clean) localStorage.setItem(key, feedback.value); else localStorage.removeItem(key); } catch { managerNote('Keep this page open until your feedback is saved; local draft storage is unavailable.'); } };
  feedback.oninput = saveLocalFeedback;
  const update = async changes => {
    if (!own() || review.busy) return; review.busy = true; save.disabled = close.disabled = true;
    try { const result = await request(`assignments/${item.id}`, 'PATCH', { expected_revision: review.item.revision, ...changes });
      review.item = result; review.clean = result.feedback; saveLocalFeedback(); managerNote('Private task updated. Participants see it when they refresh.'); await loadOwner(); await loadMine();
    } catch (error) { managerNote(`${error.message} Your feedback draft is kept. Refresh tasks before trying again.`); }
    finally { review.busy = false; save.disabled = close.disabled = false; }
  };
  save.onclick = () => void update({ feedback: feedback.value.trim() });
  close.onclick = () => void update({ feedback: feedback.value.trim(), status: review.item.status === 'closed' ? 'open' : 'closed' });
  reviews.set(item.id, review); return review;
}
async function loadOwner() {
  $('assignment-manager').hidden = !own(); if (!own()) return;
  const version = ++ownerVersion;
  try {
    const [directory, tasks, answers] = await Promise.all([request('assignments/participants'), request('assignments/all'), request('responses/all')]);
    if (version !== ownerVersion || !own()) return;
    ownerIdentity = directory.participants.find(participant => participant.role === 'owner')?.id || null;
    const select = $('assignment-participant'), selected = select.value; select.replaceChildren();
    for (const participant of directory.participants) { const option = element('option', `${participant.label} (${participant.id.slice(0, 8)})`); option.value = participant.id; select.append(option); }
    if (directory.participants.some(row => row.id === selected)) select.value = selected;
    const present = new Set();
    for (const item of tasks.assignments) {
      present.add(item.id); const review = reviewFor(item), clean = review.feedback.value.trim() === review.clean;
      review.item = item; review.clean = item.feedback; if (clean) { let draft = null; try { draft = localStorage.getItem(`tendril:${scope}:feedback:${ownerIdentity}:${item.id}`); } catch {} review.feedback.value = draft ?? item.feedback; }
      review.title.textContent = item.title; review.recipient.textContent = `Participant ${item.participant.slice(0, 8)} · revision ${item.revision}`;
      review.instructions.textContent = item.prompt; review.answer.textContent = answers.responses.find(row => row.prompt_id === item.prompt_id && row.participant === item.participant)?.answer || 'No answer yet.';
      review.close.textContent = item.status === 'closed' ? 'Reopen task' : 'Close task';
    }
    for (const [id, review] of reviews) if (!present.has(id)) { review.root.remove(); reviews.delete(id); }
    try { const prefix = `tendril:${scope}:feedback:${ownerIdentity}:`; for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(prefix) && !present.has(key.slice(prefix.length))) retainDraft({ participant: ownerIdentity, prompt_id: `feedback:${key.slice(prefix.length)}`, title: 'Private feedback from an earlier task', answer: localStorage.getItem(key) || '' }); } } catch {}
  } catch (error) { if (version === ownerVersion) managerNote(error.message); }
}
$('assignment-form').onsubmit = async event => {
  event.preventDefault(); if (!own()) return; const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const title = $('assignment-title').value, prompt = $('assignment-prompt').value;
  try { await request('assignments', 'POST', { participant: $('assignment-participant').value, title: title.trim(), prompt: prompt.trim() });
    if ($('assignment-title').value === title) $('assignment-title').value = '';
    if ($('assignment-prompt').value === prompt) $('assignment-prompt').value = '';
    managerNote('Task assigned privately.'); await Promise.all([loadOwner(), loadMine()]);
  } catch (error) { managerNote(error.message); } finally { button.disabled = false; }
};
$('refresh-tasks').onclick = () => void loadMine(); $('refresh-assignments').onclick = () => void loadOwner();
function refresh() { if (t.device.role === 'display') clearPrivate(); void loadMine(); void loadOwner(); }
t.on('connect', refresh); t.on('role', () => { clearPrivate(); refresh(); }); t.on('assignments_changed', () => void loadOwner());
let generation = t.state.get('facilitation.session_id');
t.state.on(() => { const next = t.state.get('facilitation.session_id'); if (next !== generation) { generation = next; for (const card of cards.values()) if (card.input.value.trim() !== card.answer) retainDraft({ participant: identity, prompt_id: card.item.prompt_id, title: card.item.title, answer: card.input.value }); for (const review of reviews.values()) if (review.feedback.value.trim() !== review.clean) retainDraft({ participant: ownerIdentity, prompt_id: `feedback:${review.item.id}`, title: `Private feedback: ${review.item.title}`, answer: review.feedback.value }); clearPrivate(false); refresh(); } });
window.addEventListener('focus', () => { if (document.visibilityState === 'visible') refresh(); });
refresh();

// The common archive panel uses revision-checked server snapshots and private downloads.
window.tendrilSnippets.sessionArchive.mount($('session-archive'), {
  scope: 'facilitation', title: 'Save this conversation', description: 'Archive the shared summary, private answers, assignments and feedback before starting another session.',
  guard: () => [...cards.values()].some(card => card.busy || card.input.value.trim() !== card.answer) || [...reviews.values()].some(review => review.busy || review.feedback.value.trim() !== review.clean) || $('answer').dataset.dirty === 'true' || $('assignment-title').value.trim() || $('assignment-prompt').value.trim() || ($('summary-draft').value.trim() && $('summary-draft').value.trim() !== (t.state.get('facilitation.summary') || '')) ? 'Save your answer and feedback drafts before archiving.' : null,
  afterArchive: () => { clearPrivate(); refresh(); },
});
