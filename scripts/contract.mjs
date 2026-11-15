// Generate the checked-in schema and reference from the same executable contract.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schemaDocument, schemas } from "../contract/index.mjs";

const files = [
  ["../contract/v1.json", JSON.stringify(schemaDocument, null, 2) + "\n"],
  ["../recipes/ui-schema.json", JSON.stringify({ $schema: schemaDocument.$schema, title: "Tendriller agent-editable interface", ...schemas.interface }, null, 2) + "\n"],
];
for (const [relative, expected] of files) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  if (process.argv.includes("--write")) writeFileSync(path, expected);
  else if (readFileSync(path, "utf8") !== expected) {
    console.error(`${relative} is stale. Run npm run contract:generate and commit the result.`);
    process.exitCode = 1;
  }
}
