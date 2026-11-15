import catalog from "../../recipes/catalog.json";
import { servicePage } from "./accounts/ui";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The CLI and public starter gallery share one catalog, without separate marketing examples. */
export const completeStarters = catalog.recipes.filter(recipe => recipe.kind === "workflow");

export function starterPrompt(recipe: (typeof catalog.recipes)[number], base: string): string {
  return `Read ${base}/agent.md and create a Tendriller page for me from the ${recipe.title} starter (${base}/${recipe.path}/AGENT.md). ${recipe.request || recipe.description} Use these page source files: ${(recipe.files || ["index.html"]).map(file => `${base}/${recipe.path}/${file}`).join(", ")}. Attach and verify this conversation's live receiver, and explain how to open the page. Ask for my owner email only if you do not already know it. Never ask me to paste an agent credential into the browser.`;
}

export function starterLinks(limit = 3): string {
  return `<div class="grid starter-shortcuts">${completeStarters.slice(0, limit).map(recipe => `<article class="card"><h3>${escape(recipe.title)}</h3><p>${escape(recipe.description)}</p><a href="/starters#${escape(recipe.id)}">Start with this workflow →</a></article>`).join("")}</div>`;
}

export function starterGallery(base: string): Response {
  const workflows = completeStarters.map(recipe => {
    const preview = recipe.preview;
    return `<article class="card starter" id="${escape(recipe.id)}" aria-labelledby="title-${escape(recipe.id)}">
      ${preview ? `<figure><img src="/${escape(preview.image)}" alt="${escape(preview.alt)}" width="780" height="1688" loading="lazy"><figcaption>Actual page preview · example data · <a href="/${escape(preview.image)}">View full preview</a></figcaption></figure>` : ""}
      <div class="starter-copy"><p class="eyebrow">Complete workflow</p><h2 id="title-${escape(recipe.id)}">${escape(recipe.title)}</h2><p>${escape(recipe.description)}</p>
      <details><summary>Devices and permissions</summary><ul>${(recipe.permissions || []).map(permission => `<li>${escape(permission)}</li>`).join("")}</ul></details>
      <details><summary>Page source files</summary><ul>${(recipe.files || ["index.html"]).map(file => `<li><a href="/${escape(recipe.path)}/${escape(file)}">${escape(file)}</a></li>`).join("")}</ul></details>
      <details class="request"><summary>Request to give your agent</summary><label for="request-${escape(recipe.id)}">Copy this into the agent conversation you want to continue</label><textarea id="request-${escape(recipe.id)}" readonly rows="7">${escape(starterPrompt(recipe, base))}</textarea></details>
      <div class="actions"><button type="button" data-request="request-${escape(recipe.id)}">Copy request for my agent</button><a href="/${escape(recipe.path)}/AGENT.md">Agent instructions</a></div><p class="copy-status" role="status" aria-live="polite"></p></div></article>`;
  }).join("");
  const examples = catalog.recipes.filter(recipe => recipe.kind === "example").map(recipe => `<article class="card"><p class="eyebrow">Input example</p><h3>${escape(recipe.title)}</h3><p>${escape(recipe.description)}</p><p class="muted">${escape(recipe.support || "A smaller example to adapt with your agent.")}</p><a href="/${escape(recipe.path)}/index.html">Read the page source</a></article>`).join("");
  return servicePage("Choose a starter", `<style>
    [hidden]{display:none!important}.starter{display:grid;grid-template-columns:minmax(9rem,.65fr) minmax(0,1.4fr);gap:1.5rem;margin:1.5rem 0;scroll-margin-top:1rem}.starter figure{margin:0;min-width:0}.starter img{display:block;width:100%;height:24rem;object-fit:cover;object-position:top;border:1px solid #b8cbbb;border-radius:.7rem;background:#edf3eb}.starter figcaption{font-size:.78rem;margin-top:.4rem;color:#536a5e}.starter-copy{min-width:0}.starter details{margin:.9rem 0}.starter summary{cursor:pointer;font-weight:650}.starter textarea{display:block;box-sizing:border-box;width:100%;font:inherit;line-height:1.4;padding:.7rem;border:1px solid #a9beaf;border-radius:.6rem;color:inherit;background:transparent;resize:vertical}.copy-status{min-height:1.5em}.starter button{min-height:44px}.starter :focus-visible{outline:3px solid #b57220;outline-offset:3px}.starter ul{padding-left:1.3rem}.starter li{margin:.4rem 0}@media(max-width:620px){.starter{grid-template-columns:1fr}.starter figure{max-width:20rem;margin:auto;width:100%}.starter img{height:18rem}.starter-copy h2{font-size:1.55rem}}@media(prefers-color-scheme:dark){.starter figcaption{color:#b4c8b7}.starter img{border-color:#486550;background:#203b2a}}
    </style><section class="hero"><p class="eyebrow">A useful place to begin</p><h1>Choose your first workflow.</h1><p>These working pages include the agent loop, recovery behavior and a tested example. Pick one, copy the request into your agent conversation, and make it your own.</p><p class="muted">The previews use example data. Your agent creates a separate page for your work and verifies its live connection before publishing.</p><a href="#workflows">Explore six complete starters ↓</a></section>
    <section id="workflows" aria-label="Complete starters">${workflows}</section><section aria-labelledby="examples-heading"><h2 id="examples-heading">Smaller input examples</h2><p>Explore one input or interface idea. These are lighter building blocks, with less workflow and recovery coverage than the six starters above.</p><div class="grid">${examples}</div></section>`, `<script>
    document.querySelectorAll('[data-request]').forEach(button=>button.addEventListener('click',async()=>{const input=document.getElementById(button.dataset.request),card=button.closest('article'),status=card.querySelector('.copy-status');try{await navigator.clipboard.writeText(input.value);status.textContent='Request copied. Paste it into your agent conversation.';}catch{input.closest('details').open=true;input.focus();input.select();status.textContent='Select and copy this request, then paste it into your agent conversation.';}}));
    document.querySelectorAll('.starter img').forEach(image=>image.addEventListener('error',()=>{image.hidden=true;image.nextElementSibling.textContent='Preview image is not available in this deployment. The working starter and agent instructions are ready.';}));
    </script>`);
}
