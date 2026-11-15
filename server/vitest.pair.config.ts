import { workerTestConfig } from "./vitest.shared.ts";
// Test the built service and vendored archive, never a contrib source checkout.
export default await workerTestConfig("../dist/service/worker.mjs", ["integration/*.test.ts"]);
