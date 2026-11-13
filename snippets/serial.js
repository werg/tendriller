/* Tendriller snippet: serial.js — talk to a microcontroller over USB serial (Web Serial).
 *
 *   <button id="connect">Connect board</button>
 *   <script src="_tendril/snippets/serial.js"></script>
 *   <script>
 *     const serial = tendrilSnippets.serial;
 *     if (!serial.supported()) connect.replaceWith(serial.unsupportedReason());
 *     connect.onclick = async () => {                       // the port picker needs a tap
 *       const port = await serial.connect({ baudRate: 115200,
 *         onLine: (line) => { if (line.startsWith("ERR")) tendril.send({ type: "serial", line }); } });
 *       await port.writeLine("STATUS");
 *       // port.close()
 *     };
 *   </script>
 *
 * From the agent via eval (after the user connected once on the page):
 *   return await tendrilSnippets.serial.current?.request("STATUS", { timeoutMs: 2000 })
 *
 * connect({baudRate=115200, filters, onLine, onError, previous=false}) → port:
 *   {write(text), writeLine(text), request(text, {timeoutMs}) → next line, lines (last 200), close()}
 *   previous:true reuses an already-granted port without a picker (no tap needed).
 * Web Serial exists only in Chromium desktop browsers (Chrome, Edge, Opera) on HTTPS; not on
 * iOS, Android Chrome (except USB-OTG in recent versions), Firefox or Safari.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const supported = () => "serial" in navigator;
  const unsupportedReason = () => supported() ? "" :
    !window.isSecureContext ? "Web Serial needs a secure (HTTPS) page." :
    "Web Serial is not available in this browser. Use Chrome or Edge on a desktop computer.";

  async function connect({ baudRate = 115200, filters, onLine, onError, previous = false } = {}) {
    if (!supported()) throw new Error(unsupportedReason());
    let port;
    if (previous) port = (await navigator.serial.getPorts())[0];
    if (!port) {
      try {
        port = await navigator.serial.requestPort(filters ? { filters } : {});
      } catch (e) {
        throw new Error(e.name === "NotFoundError" ? "No serial port was chosen." : e.name === "SecurityError" ? "Opening the port picker needs a tap." : e.message);
      }
    }
    await port.open({ baudRate });
    const enc = new TextEncoder();
    const lines = [];
    const waiters = [];
    let closed = false, reader = null;

    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      while (port.readable && !closed) {
        reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).replace(/\r$/, "");
              buf = buf.slice(i + 1);
              lines.push(line);
              if (lines.length > 200) lines.shift();
              const w = waiters.shift();
              if (w) w(line);
              if (onLine) onLine(line);
            }
          }
        } catch (e) {
          if (!closed && onError) onError("Serial read error: " + e.message); // e.g. unplugged
        } finally {
          reader.releaseLock();
        }
      }
    })();

    const api = {
      port, lines,
      async write(text) {
        const w = port.writable.getWriter();
        try { await w.write(typeof text === "string" ? enc.encode(text) : text); } finally { w.releaseLock(); }
      },
      writeLine: (text) => api.write(text + "\n"),
      request(text, { timeoutMs = 2000 } = {}) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => { waiters.splice(waiters.indexOf(done), 1); reject(new Error("No reply within " + timeoutMs + " ms")); }, timeoutMs);
          const done = (line) => { clearTimeout(t); resolve(line); };
          waiters.push(done);
          api.writeLine(text).catch(reject);
        });
      },
      async close() {
        closed = true;
        try { await reader?.cancel(); } catch {}
        await port.close().catch(() => {});
        if (ns.serial.current === api) ns.serial.current = null;
      },
    };
    ns.serial.current = api;
    return api;
  }

  ns.serial = { supported, unsupportedReason, connect, current: null };
})();
