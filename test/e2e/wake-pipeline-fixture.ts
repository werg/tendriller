import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RUNTIME_RESOURCES } from "../../runtime/resources.mjs";

/** Real browser capture/DSP/adapter; only the microphone source is injected WAV PCM. */
export async function serveWakePipeline(realModel: boolean) {
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  const requests: Array<{ method: string; path: string }> = [];
  for (const name of ["voice.mjs", "voice-pcm-worklet.js", "resources.json"]) {
    assets.set(`/runtime/${name}`, { bytes: await readFile(`dist/runtime/assets/${name}`), type: name.endsWith("json") ? "application/json" : "text/javascript" });
  }
  const wakeFixtures = realModel ? JSON.parse(await readFile("test/fixtures/speech/wake-manifest.json", "utf8")) : null;
  const fixture = wakeFixtures ? { ...wakeFixtures.cases[0], phrase: wakeFixtures.phrase } : { ...JSON.parse(await readFile("test/fixtures/speech/manifest.json", "utf8")), phrase: "Please check" };
  const wav = await readFile(join("test/fixtures/speech", fixture.file));
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  if (sha(wav) !== fixture.sha256) throw new Error("Spoken fixture hash mismatch");
  assets.set("/known-speech.wav", { bytes: wav, type: "audio/wav" });
  if (realModel) {
    const cache = execFileSync(process.execPath, ["scripts/e2e-speech-assets.mjs"], { encoding: "utf8", timeout: 150_000 }).trim();
    for (const resource of RUNTIME_RESOURCES) {
      const bytes = await readFile(join(cache, resource.name));
      if (sha(bytes) !== resource.sha256) throw new Error("Speech resource hash mismatch");
      assets.set(`/${resource.url}`, { bytes, type: resource.type });
    }
    assets.set("/runtime/voice-worker.js", { bytes: await readFile("dist/runtime/assets/voice-worker.js"), type: "text/javascript" });
  } else {
    assets.set("/runtime/voice-worker.js", { type: "text/javascript", bytes: Buffer.from(`
      self.onmessage = event => {
        const {id,action,samples}=event.data;
        if(action==='init'){self.postMessage({id,ready:true});return;}
        const audio=new Float32Array(samples);let energy=0;for(const value of audio)energy+=value*value;
        self.postMessage({fixtureStats:{samples:audio.length,rms:Math.sqrt(energy/audio.length),finite:audio.every(Number.isFinite)}});
        self.postMessage({id,matched:audio.length>=3200&&energy>0,command:'measured acoustic pipeline'});
      };
    `) });
  }
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/"; requests.push({ method: request.method ?? "", path });
    const asset = assets.get(path);
    if (asset) { response.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.bytes.length }); response.end(asset.bytes); return; }
    if (path !== "/") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Wake acoustic pipeline qualification</title>
      <main><h1>Explicit on-device wake</h1><button id="start" disabled>Start microphone</button><button id="stop">Stop microphone</button><p id="status" role="status"></p></main>
      <script type="module">
      import {createVoice} from '/runtime/voice.mjs';
      const fixture=window.wakePipeline={states:[],commands:[],stats:[],starts:0,streams:[],started:false,error:null};
      const bytes=await(await fetch('/known-speech.wav')).arrayBuffer();
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.addEventListener('message',event=>{if(event.data.fixtureStats)fixture.stats.push(event.data.fixtureStats);});}};
      let audio, destination, buffer, silence;
      // Retain the DOM wrapper for the fixture lifetime. WebKit can otherwise
      // collect it and recreate navigator.mediaDevices without our instance
      // override, causing the test to request a real microphone after GC.
      fixture.mediaDevices=navigator.mediaDevices;
      Object.defineProperty(fixture.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
        fixture.starts++;const stream=destination.stream.clone();fixture.streams.push(stream);return stream;
      }});
      const runtime={identity:{page:'speech-pipeline',base:location.origin+'/'},assetUrl:path=>new URL('/runtime/'+path,location.origin).href,on:()=>()=>{}};
      const voice=fixture.voice=createVoice(runtime,{consent:()=>true,transcript:text=>fixture.commands.push(text),status:status=>{fixture.states.push(status);document.querySelector('#status').textContent=status.message||status.state;}});
      fixture.supported=!!(window.AudioContext&&window.AudioWorkletNode&&navigator.locks);
      document.querySelector('#start').disabled=false;
      document.querySelector('#start').onclick=()=>{
        if(fixture.supported){
          audio=new AudioContext();audio.resume();destination=audio.createMediaStreamDestination();
          // Keep an active zero-valued producer before cloning the synthetic
          // microphone; WebKit must not see an initially disconnected source.
          silence=audio.createConstantSource();silence.offset.value=0;silence.connect(destination);silence.start();
          audio.decodeAudioData(bytes.slice(0)).then(value=>{buffer=value;fixture.readyToPlay=true;}).catch(error=>fixture.error=error.message);
        }
        voice.startWake({phrase:${JSON.stringify(fixture.phrase)},mode:'model'}).then(result=>{fixture.started=result;if(!result)fixture.error=voice.wakeStatus.message;}).catch(error=>fixture.error=error.message);
      };
      document.querySelector('#stop').onclick=()=>voice.stop();
      fixture.play=()=>{const source=audio.createBufferSource();source.buffer=buffer;source.connect(destination);source.start();};
      fixture.close=async()=>{voice.dispose();for(const stream of fixture.streams)stream.getTracks().forEach(track=>track.stop());destination?.stream.getTracks().forEach(track=>track.stop());silence?.stop();if(audio)await audio.close();};
      </script></html>`);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No pipeline fixture address");
  return {
    origin: `http://127.0.0.1:${address.port}`, requests, fixture,
    async close() { const closed = new Promise<void>(resolve => server.close(() => resolve())); for (const socket of sockets) socket.destroy(); await closed; },
  };
}
