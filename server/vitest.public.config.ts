import { workerTestConfig } from "./vitest.shared.ts";
export default await workerTestConfig("src/index.ts", ["test/*.test.ts"]);
