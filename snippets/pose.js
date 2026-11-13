/* Tendriller snippet: pose.js — on-device body pose (MediaPipe Pose Landmarker) and a rep counter.
 *
 *   <script src="_tendril/snippets/camera.js"></script>
 *   <script src="_tendril/snippets/pose.js"></script>
 *   <script>
 *     const pose = tendrilSnippets.pose;
 *     startBtn.onclick = async () => {
 *       const cam = await tendrilSnippets.camera.open("#view", { facing: "user" });
 *       const reps = pose.repCounter({ joint: "left_knee", low: 100, high: 160,   // squats
 *         onRep: (n) => { counter.textContent = n; if (n % 10 === 0) tendril.send({ type: "reps", n }, { wake: false }); } });
 *       const run = await pose.start(cam.video, { fps: 15, onResult: (people) => people[0] && reps.update(people[0]) });
 *       // later: run.stop()
 *     };
 *     // One-off: const people = await pose.detect(imgOrVideo);
 *   </script>
 *
 * detect(source) → [person], person = {landmarks: {nose:{x,y,z,visibility}, left_elbow:{…}, …}, list:[33 points]}
 *   x, y are 0..1 of the source frame (same coordinates as overlay.js); z is relative depth.
 * angle(a, b, c) → degrees at b.  JOINTS lists the named joints repCounter understands.
 * repCounter({joint | points:[a,b,c], low=90, high=160, minVisibility=0.5, onRep})
 *   counts one rep each time the joint angle goes below `low` and back above `high`.
 *   .update(person) → {count, angle, phase:"up"|"down"}; .reset()
 * Model and runtime (≈ 6 MB) load from jsDelivr / Google storage on first use.
 * load({model:"lite"|"full"|"heavy", delegate:"GPU"|"CPU"}) to preload; GPU falls back to CPU.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1";
  const MODEL = (m) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;
  const NAMES = ["nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb",
    "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel", "right_heel",
    "left_foot_index", "right_foot_index"];
  const JOINTS = {
    left_elbow: ["left_shoulder", "left_elbow", "left_wrist"], right_elbow: ["right_shoulder", "right_elbow", "right_wrist"],
    left_knee: ["left_hip", "left_knee", "left_ankle"], right_knee: ["right_hip", "right_knee", "right_ankle"],
    left_hip: ["left_shoulder", "left_hip", "left_knee"], right_hip: ["right_shoulder", "right_hip", "right_knee"],
    left_shoulder: ["left_hip", "left_shoulder", "left_elbow"], right_shoulder: ["right_hip", "right_shoulder", "right_elbow"],
  };

  const supported = () => typeof WebAssembly === "object" && !!document.createElement("canvas").getContext;

  let lib = null;
  const tasks = {}; // "VIDEO" | "IMAGE" → Promise<PoseLandmarker>
  let opts = { model: "lite", delegate: "GPU", numPoses: 1 };

  async function create(runningMode) {
    lib ||= import(MP + "/vision_bundle.mjs");
    const { FilesetResolver, PoseLandmarker } = await lib;
    const files = await FilesetResolver.forVisionTasks(MP + "/wasm");
    const make = (delegate) => PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL(opts.model), delegate }, runningMode, numPoses: opts.numPoses,
    });
    try {
      return await make(opts.delegate);
    } catch (e) {
      if (opts.delegate === "CPU") throw e;
      return make("CPU");
    }
  }
  function load(o = {}, mode = "VIDEO") {
    opts = { ...opts, ...o };
    return (tasks[mode] ||= create(mode).catch((e) => { delete tasks[mode]; throw e; }));
  }

  let lastTs = 0;
  async function detect(source) {
    const video = source instanceof HTMLVideoElement;
    const lm = await load({}, video ? "VIDEO" : "IMAGE");
    const ts = Math.max(performance.now(), lastTs + 1);
    lastTs = ts;
    const r = video ? lm.detectForVideo(source, ts) : lm.detect(source);
    return (r.landmarks || []).map((list) => ({
      list,
      landmarks: Object.fromEntries(list.map((p, i) => [NAMES[i], p])),
    }));
  }

  async function start(video, { fps = 15, onResult, onError } = {}) {
    await load();
    let stopped = false, timer = null;
    const loop = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) onResult && onResult(await detect(video));
      } catch (e) {
        onError ? onError(e) : console.warn("pose:", e);
      }
      timer = setTimeout(loop, 1000 / fps);
    };
    loop();
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  function angle(a, b, c) {
    const ab = Math.atan2(a.y - b.y, a.x - b.x), cb = Math.atan2(c.y - b.y, c.x - b.x);
    let deg = Math.abs((ab - cb) * 180 / Math.PI);
    return deg > 180 ? 360 - deg : deg;
  }

  function repCounter({ joint = "left_knee", points, low = 90, high = 160, minVisibility = 0.5, onRep } = {}) {
    const [a, b, c] = points || JOINTS[joint];
    let count = 0, phase = "up", last = null;
    return {
      get count() { return count; },
      update(person) {
        const L = person.landmarks || person;
        const pa = L[a], pb = L[b], pc = L[c];
        if (!pa || !pb || !pc || [pa, pb, pc].some((p) => (p.visibility ?? 1) < minVisibility)) return { count, angle: last, phase };
        last = angle(pa, pb, pc);
        if (phase === "up" && last < low) phase = "down";
        else if (phase === "down" && last > high) {
          phase = "up";
          count++;
          if (onRep) onRep(count);
        }
        return { count, angle: last, phase };
      },
      reset() { count = 0; phase = "up"; },
    };
  }

  ns.pose = { supported, load, detect, start, angle, repCounter, NAMES, JOINTS };
})();
