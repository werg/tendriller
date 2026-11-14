/* Device playground: tendrilSnippets.playground.mount('#explore').
 * Shows live capabilities, example event shapes, and working user-triggered inputs.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const load = (name) => new Promise((resolve, reject) => {
    const key = ({ "input-kit": "inputs", "hardware-lab": "hardwareLab" })[name] || name;
    if (ns[key]) return resolve(ns[key]);
    const s = document.createElement("script"); s.src = `_tendril/snippets/${name}.js`;
    s.onload = () => resolve(ns[key]); s.onerror = () => reject(new Error(`Cannot load ${name}`)); document.head.append(s);
  });
  async function mount(target) {
    const host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Playground target not found");
    const title = document.createElement("h2"); title.textContent = "Explore this device";
    const summary = document.createElement("p"); summary.setAttribute("role", "status");
    const list = document.createElement("div");
    const hidden = document.createElement("details");
    const hiddenTitle = document.createElement("summary");
    const hiddenList = document.createElement("div");
    hidden.append(hiddenTitle, hiddenList);
    const input = document.createElement("div");
    input.dataset.inputKit = "";
    const hardware = document.createElement("div");
    const starters = document.createElement("section");
    host.replaceChildren(title, summary, list, input, hardware, starters, hidden);
    const report = await tendril.capabilities();
    const all = Object.entries(report.capabilities);
    const availableCount = all.filter(([, c]) => c.available).length;
    summary.textContent = `${availableCount} inputs and device features detected. Permissions are requested only when you use a control.`;
    hiddenTitle.textContent = `Show ${all.length - availableCount} unavailable or unsupported features`;
    if (availableCount === all.length) hidden.hidden = true;
    list.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.5rem;margin-block:1rem";
    hiddenList.style.cssText = list.style.cssText;
    for (const [name, cap] of all) {
      const card = document.createElement("div");
      card.style.cssText = "border:1px solid currentColor;border-radius:.5rem;padding:.6rem";
      const heading = document.createElement("strong"); heading.textContent = name.replaceAll("_", " ");
      const detail = document.createElement("div");
      detail.textContent = `${cap.available ? "Available" : "Unavailable"} · permission ${cap.permission}${cap.needs_user_tap ? " · tap needed" : ""}`;
      card.append(heading, detail); (cap.available ? list : hiddenList).append(card);
    }
    const available = ["photo", "audio", "location", "motion", "file"].filter((m) => m === "file" || report.capabilities[m === "photo" ? "camera" : m === "audio" ? "microphone" : m]?.available);
    if (available.length) (await load("input-kit")).mount(input, { modalities: available });
    await load("connectors");
    await Promise.all([load("serial"), load("bluetooth")]);
    (await load("hardware-lab")).mount(hardware);
    const starterTitle = document.createElement("h2"); starterTitle.textContent = "Build from a working page";
    const starterNote = document.createElement("p"); starterNote.textContent = "Choose an idea and your connected agent can build it into this page.";
    const ideas = [
      ["field-notebook", "Field notebook", "Collect observations, photos, and location."],
      ["voice-coach", "Voice coach", "Talk through a task and hear short replies."],
      ["motion-companion", "Motion companion", "Reflect on a movement session."],
      ["photo-inspector", "Photo inspector", "Ask about something you see."],
      ["collaborative-canvas", "Collaborative canvas", "Draw and explore together."],
      ["adaptive-checkin", "Adaptive check-in", "Let the agent reshape a check-in."],
    ];
    const ideaGrid = document.createElement("div");
    ideaGrid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.65rem";
    const starterStatus = document.createElement("p"); starterStatus.setAttribute("role", "status"); starterStatus.setAttribute("aria-live", "polite");
    for (const [id, name, description] of ideas) {
      const card = document.createElement("div"); card.style.cssText = "border:1px solid currentColor;border-radius:.5rem;padding:.65rem";
      const heading = document.createElement("h3"); heading.textContent = name;
      const info = document.createElement("p"); info.textContent = description;
      const choose = document.createElement("button"); choose.type = "button"; choose.textContent = `Build ${name}`;
      choose.onclick = async () => {
        choose.disabled = true; starterStatus.textContent = `Asking the agent to build ${name}…`;
        try {
          const result = await tendril.send({ type: "recipe_choice", recipe: id, at: Date.now() });
          starterStatus.textContent = result?.queued ? `Saved your ${name} choice for the agent to receive later.` : `Sent ${name} to the agent.`;
        } catch (error) { starterStatus.textContent = error?.message || "Could not send your choice."; }
        finally { choose.disabled = false; }
      };
      card.append(heading, info, choose); ideaGrid.append(card);
    }
    const catalogLink = document.createElement("a"); catalogLink.href = "https://github.com/werg/tendriller/tree/master/recipes"; catalogLink.textContent = "Browse recipe source";
    starters.append(starterTitle, starterNote, ideaGrid, starterStatus, catalogLink);
    return report;
  }
  ns.playground = { supported: () => true, mount };
})();
