import { createSpeechOutput } from "../../src/voice/output";
import { createPreferences } from "../../src/voice/preferences";
const w = window as any;
w.preferences = createPreferences("fixture");
w.preferences.update({ audio: true });
w.events = [];
w.tts = createSpeechOutput("/page/runtime/", { on: () => () => {}, emit: (type, value) => w.events.push({ type, value }) }, w.preferences);
