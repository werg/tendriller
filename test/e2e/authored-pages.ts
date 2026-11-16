// Verification specimens, not framework templates. All UI belongs to these pages.
export const conversationPage = `
<main><h1>Conversation delivery check</h1>
<ol id="messages" aria-label="Conversation"></ol>
<form id="compose"><label>Message to the agent<textarea id="draft"></textarea></label><button id="send">Send</button></form>
<p id="delivery" role="status"></p></main>
<script>
const draft = document.querySelector('#draft');
const key = 'specimen-draft:' + tendril.identity.page;
draft.value = localStorage.getItem(key) || '';
draft.oninput = () => localStorage.setItem(key, draft.value);
const render = () => {
  const rows = tendril.conversation.entries().map(entry => {
    const row = document.createElement('li'); row.className = entry.from;
    row.dataset.cid = entry.cid || ''; row.dataset.status = entry.status || 'accepted';
    const who = document.createElement('strong'); who.textContent = entry.from === 'user' ? 'You' : 'Agent';
    const text = document.createElement('span'); text.textContent = ': ' + entry.text;
    row.append(who, text);
    if (entry.status === 'rejected') {
      const restore = document.createElement('button'); restore.textContent = 'Use rejected text';
      restore.onclick = () => { draft.value = entry.text; draft.oninput(); draft.focus(); };
      row.append(restore);
    }
    return row;
  });
  document.querySelector('#messages').replaceChildren(...rows);
  for (const entry of tendril.conversation.entries()) if (entry.from === 'agent' && entry.message_id) tendril.conversation.presented(entry.message_id);
};
tendril.on('transcript', render); tendril.on('connect', render);
tendril.on('conversation_result', result => { document.querySelector('#delivery').textContent = result.status; render(); });
document.querySelector('#compose').onsubmit = async event => {
  event.preventDefault(); const text = draft.value; if (!text.trim()) return;
  const button = document.querySelector('#send'); button.disabled = true;
  try {
    const result = await tendril.conversation.send(text);
    if (result.status !== 'rejected' && draft.value === text) { draft.value = ''; draft.oninput(); }
    document.querySelector('#delivery').textContent = result.status; render();
  } finally { button.disabled = false; }
};
render();
</script>`;

export const voicePage = conversationPage + `
<section aria-label="Voice test">
<p>This fixture explicitly enables on-device speech through these buttons.</p>
<button id="enable-speech">Enable neural speech</button>
<button id="record" aria-pressed="false">Record</button>
<button id="stop-voice">Stop voice</button><p id="voice-status" role="status"></p>
</section>
<script type="module">
const { createVoice } = await import(tendril.assetUrl('voice.mjs'));
window.voice = createVoice(tendril, {
  consent: () => true, // Test fixture: each capability is explicitly triggered below.
  transcript: text => { void tendril.conversation.send(text, { via: 'voice' }); },
  status: value => {
    document.querySelector('#voice-status').textContent = value.message || value.state;
    if (value.kind === 'capture') document.querySelector('#record').setAttribute('aria-pressed', String(value.state === 'recording'));
  },
  speakReplies: true,
});
document.querySelector('#enable-speech').onclick = async () => { await voice.enableOutput('neural'); };
document.querySelector('#record').onclick = async () => {
  if (voice.listening) voice.finishCapture(); else await voice.startCapture();
};
document.querySelector('#stop-voice').onclick = () => voice.stop();
</script>`;
