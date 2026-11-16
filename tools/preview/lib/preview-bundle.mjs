// The release build embeds these exact verified assets in standalone scripts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as support from "@tendriller/runtime/preview-support";
const manifestPath = fileURLToPath(import.meta.resolve("@tendriller/runtime/manifest"));
export const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
export const implementation = support;
const base = "/_tendril/runtime/" + manifest.id + "/";
export const assets = Object.fromEntries(manifest.assets.map(file => [base + file.path, readFileSync(join(dirname(manifestPath), file.path)).toString("base64")]));
assets[base + "manifest.json"] = readFileSync(manifestPath).toString("base64");
assets["/_tendril/sw.js"] = assets[base + "sw.js"];
