// Explicit voice fixture: transcripts belong to page callbacks; application commands are separate.
export const voicePage = `
<main><h1>Explicit voice</h1><p id="spoken" role="status"></p>
<label>Recognized transcript<textarea id="draft"></textarea></label>
<section aria-label="Voice test">
<p>These controls explicitly enable on-device input and output.</p>
<button id="enable-speech">Enable neural speech</button>
<button id="record" aria-pressed="false">Record</button>
<button id="stop-voice">Stop voice</button><p id="voice-status" role="status"></p>
</section></main>
<script type="module">
const { createVoice } = await import(tendril.assetUrl('voice.mjs'));
window.voice = createVoice(tendril, {
  consent: () => true,
  transcript: text => { document.querySelector('#draft').value = text; },
  status: value => {
    document.querySelector('#voice-status').textContent = value.message || value.state;
    if (value.kind === 'capture') document.querySelector('#record').setAttribute('aria-pressed', String(value.state === 'recording'));
  },
});
window.speakReviewed = text => { document.querySelector('#spoken').textContent = text; voice.speak(text); };
document.querySelector('#enable-speech').onclick = () => voice.enableOutput('neural');
document.querySelector('#record').onclick = () => voice.listening ? voice.finishCapture() : voice.startCapture();
document.querySelector('#stop-voice').onclick = () => voice.stop();
addEventListener('pagehide', () => voice.dispose(), { once: true });
</script>`;
