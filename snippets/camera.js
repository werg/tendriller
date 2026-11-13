/* Tendriller snippet: camera.js — open a camera, show a viewfinder, capture JPEG photos.
 *
 *   <div id="view" style="width:100%;aspect-ratio:4/3"></div>
 *   <button id="snap">Take photo</button>
 *   <script src="_tendril/snippets/camera.js"></script>
 *   <script>
 *     const camera = tendrilSnippets.camera;
 *     let cam;
 *     document.getElementById("snap").onclick = async () => {
 *       cam ??= await camera.open("#view", { facing: "environment" }); // first tap asks permission
 *       const photo = await cam.capture({ maxWidth: 1280, quality: 0.85, send: { note: "drawer" } });
 *       // photo = {id, url, width, height, blob}; with `send` the agent also gets
 *       // event {type:"photo", blob:id, url, width, height, note:"drawer"} (wakes it).
 *     };
 *   </script>
 *
 * open(target, {facing:"environment"|"user", width, height, mirror}) → cam
 *   target: element/selector to hold the viewfinder (a <video> is used directly).
 *   cam.capture({maxWidth=1280, quality=0.85, upload=true, send=false|true|{...extra, wake}, name})
 *   cam.switch(facing), cam.close(), cam.video, cam.stream
 * Errors are thrown with a human-readable message and also shown in the target (role="alert").
 * Coordinates: captures are the full camera frame, so overlay.js normalized coordinates line up.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function explain(err) {
    const n = err && err.name;
    if (!window.isSecureContext) return "The camera needs a secure (HTTPS) page.";
    if (n === "NotAllowedError" || n === "SecurityError")
      return "Camera permission was denied. Allow camera access for this site in the browser settings, then try again.";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "No suitable camera was found on this device.";
    if (n === "NotReadableError" || n === "AbortError") return "The camera is in use by another app or could not be started.";
    return "Could not open the camera: " + ((err && err.message) || err);
  }

  function showError(host, msg) {
    if (!host || host.tagName === "VIDEO") return;
    let box = host.querySelector("[data-camera-error]");
    if (!box) {
      box = document.createElement("p");
      box.setAttribute("data-camera-error", "");
      box.setAttribute("role", "alert");
      box.style.cssText = "margin:0;padding:1em;font:inherit;color:inherit";
      host.appendChild(box);
    }
    box.textContent = msg;
  }

  async function getStream(facing, width, height) {
    if (!supported()) throw new Error(window.isSecureContext ? "This browser has no camera access." : "The camera needs a secure (HTTPS) page.");
    const video = { facingMode: { ideal: facing }, width: { ideal: width }, height: { ideal: height } };
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      const err = new Error(explain(e));
      err.name = e.name || "CameraError";
      throw err;
    }
  }

  /** Draw the current video frame to a JPEG (or other type) Blob, scaled to maxWidth. */
  async function frameBlob(video, { maxWidth = 1280, quality = 0.85, type = "image/jpeg" } = {}) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error("The camera has no picture yet.");
    const scale = Math.min(1, maxWidth / vw);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Encoding failed"))), type, quality));
    return { blob, width: canvas.width, height: canvas.height };
  }

  async function open(target, { facing = "environment", width = 1920, height = 1080, mirror } = {}) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    let video = host && host.tagName === "VIDEO" ? host : null;
    if (!video) {
      video = document.createElement("video");
      video.style.cssText = "display:block;width:100%;height:100%;object-fit:cover;background:#000";
      if (host) host.appendChild(video);
    }
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-label", "Camera viewfinder");
    video.muted = true;
    video.autoplay = true;

    let stream;
    const start = async (f) => {
      try {
        stream = await getStream(f, width, height);
      } catch (e) {
        showError(host, e.message);
        throw e;
      }
      const err = host && host.querySelector && host.querySelector("[data-camera-error]");
      if (err) err.remove();
      video.srcObject = stream;
      // Mirror the preview for selfie cameras only; captures are never mirrored.
      video.style.transform = (mirror ?? f === "user") ? "scaleX(-1)" : "";
      await video.play().catch(() => {});
      if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
    };
    await start(facing);

    const cam = {
      video,
      get stream() { return stream; },
      facing,
      async capture({ maxWidth = 1280, quality = 0.85, upload = true, send = false, name } = {}) {
        const { blob, width: w, height: h } = await frameBlob(video, { maxWidth, quality });
        const out = { blob, width: w, height: h };
        if (!upload) return out;
        if (!window.tendril || !window.tendril.upload) throw new Error("tendril.upload is not available on this page.");
        const { id, url } = await window.tendril.upload(blob, { name: name || "photo.jpg" });
        Object.assign(out, { id, url });
        if (send) {
          const extra = typeof send === "object" ? { ...send } : {};
          const wake = extra.wake ?? true;
          delete extra.wake;
          await window.tendril.send({ type: "photo", blob: id, url, width: w, height: h, ...extra }, { wake });
        }
        return out;
      },
      async switch(f) {
        cam.close(false);
        cam.facing = f || (cam.facing === "user" ? "environment" : "user");
        await start(cam.facing);
      },
      close(removeVideo = true) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
        if (removeVideo && video !== host) video.remove();
      },
    };
    return cam;
  }

  ns.camera = { supported, open, frameBlob, explain };
})();
