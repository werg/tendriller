import {
  createExecutionManifest,
  utf8
} from "./chunk-MAGRVNAE.mjs";
import {
  sha256
} from "./chunk-HYFY2E3E.mjs";

// packages/materializer/src/manifest.ts
async function eventExecutionManifest() {
  return createExecutionManifest({
    profile: "chronolog-events-v1",
    engine: "none",
    engineDigest: await sha256(utf8("chronolog/events-only/v1")),
    platformDigest: await sha256(utf8("chronolog/change-program/v3;literal-events;operation-conflicts/v1;verified-input-order/v1"))
  });
}

export {
  eventExecutionManifest
};
