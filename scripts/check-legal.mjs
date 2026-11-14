// Fail deployment until reviewed, publishable pages have been supplied.
import { readFile } from "node:fs/promises";

const names = ["terms", "privacy", "acceptable-use", "copyright", "law-enforcement"];
for (const name of names) {
  let page;
  try { page = await readFile(new URL(`../legal/${name}.html`, import.meta.url), "utf8"); }
  catch { throw new Error(`Missing reviewed legal page: legal/${name}.html`); }
  if (page.length < 500 || !/^<!doctype html>/i.test(page.trim()) || /\b(TODO|PLACEHOLDER|DRAFT)\b/i.test(page)) {
    throw new Error(`Legal page is incomplete: legal/${name}.html`);
  }
}
console.log("Reviewed legal page files are present; confirm their approval before setting deployment READY variables.");
