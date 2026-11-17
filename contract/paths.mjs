import { RESOURCE_LIMITS } from "./limits.mjs";
/** A lone surrogate cannot be represented faithfully in a URL or UTF-8 name. */
export function isWellFormedUnicode(value) {
  for (const point of value) {
    const code = point.charCodeAt(0);
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
export const filePathSchema = {
  type: "string", minLength: 1, maxLength: RESOURCE_LIMITS.path_characters,
  "x-canonical-nfc": true, "x-well-formed-unicode": true,
  pattern: "^(?!/)(?!.*\\/$)(?!(?:_tendril|_publications)(?:/|$))(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\\\x00-\\x1f\\x7f]+$",
};
/** Reject unsafe or non-canonical names rather than translating them to other paths. */
export function assertFilePath(path) {
  if (typeof path !== "string" || !path || path.length > RESOURCE_LIMITS.path_characters ||
    !isWellFormedUnicode(path) || path.normalize("NFC") !== path || !new RegExp(filePathSchema.pattern).test(path) ||
    path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("Invalid canonical publication path");
  }
  return path;
}
