// Shared branding for Tendriller-owned pages. Relative bases also work on page subdomains.
export const brandBase = "/_tendril/brand/";

export function brandHead(base = brandBase): string {
  return `<link rel="icon" type="image/png" sizes="64x64" href="${base}icon-64.png"><link rel="apple-touch-icon" sizes="180x180" href="${base}icon-180.png">`;
}

export const brandLink = `<a class="brand" href="/" aria-label="Tendriller home"><img src="${brandBase}icon-64.png" alt="" width="44" height="44">Tendriller</a>`;

export const brandStyle = `<style>.brand{display:inline-flex;align-items:center;gap:.65rem;flex-shrink:0}.brand img{display:block;object-fit:contain}.brand-art{display:block;width:min(100%,28rem);margin:0 auto 1.5rem}.brand-art img{display:block;width:100%;height:auto}.holding-brand{display:block;width:88px;height:88px;margin-bottom:1rem}</style>`;

export const brandLogo = `<picture class="brand-art"><source srcset="${brandBase}logo.webp" type="image/webp"><img src="${brandBase}logo.png" alt="Tendriller — a cheerful robot drill with vacuum tubes and leafy circuit tendrils" width="1536" height="1024" fetchpriority="high"></picture>`;
