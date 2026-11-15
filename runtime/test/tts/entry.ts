import { createSpeechOutput } from "../../src/speech-output";
import { createPreferences } from "../../src/preferences";
const w = window as any;
w.preferences = createPreferences("fixture");
w.events = [];
w.tts = createSpeechOutput("/page/runtime/", { on: () => () => {}, emit: (type, value) => w.events.push({ type, value }) }, w.preferences);
