import { createSpeechOutput } from "../../src/speech-output";
const w = window as any;
w.prefs = {};
w.events = [];
w.tts = createSpeechOutput("/page/", { on: () => () => {}, emit: (type, value) => w.events.push({ type, value }) }, () => w.prefs);
