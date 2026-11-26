import { openNativePage } from '../../shared/native-page.mjs';
import { followCall } from '../../shared/media/call-agent.mjs';
import { definition, imports, topics } from './domain.mjs';

/**
 * Native agent participant for a video conferencing page.
 * Default `mode: 'transcript'` follows per-person speaker-attributed transcripts with
 * zero media overhead. Switch to `mode: 'audio'` to receive per-speaker PCM audio via Werift.
 */
export async function openPage(context) {
  const owner = await openNativePage(context, { definition, imports, topics });
  const mode = process.env.TENDRIL_CALL_AGENT_MODE === 'audio' ? 'audio' : 'transcript';
  const call = followCall(owner.session, {
    handle: context.agent?.handle ?? 'scribe',
    bio: mode === 'audio' ? 'Listening to call audio & transcript' : 'Following per-person call transcript',
    mode,
    onUtterance(utterance) {
      context.report?.({
        state: 'call_utterance',
        speaker: utterance.displayName,
        speakerId: utterance.speakerId,
        text: utterance.text,
        addressedTo: utterance.addressedTo,
      });
    },
    onAudioTrack(speaker, audio) {
      context.report?.({ state: 'call_audio_track', speaker: speaker.displayName, speakerId: speaker.speakerId });
      // Consume raw `.rtp`, `.pcm({ sampleRate: 16000 })`, or `.utterances({ vad: true })` here.
      void audio;
    },
  });
  const close = owner.close.bind(owner);
  return Object.assign(owner, {
    call,
    async close() {
      await call.close();
      await close();
    },
  });
}
