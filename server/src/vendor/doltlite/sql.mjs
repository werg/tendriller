// packages/peer-session/src/sql.ts
async function createSqlMaterializationRuntime(options) {
  const { DeterministicMaterializer, createDoltLiteMaterializationRuntime } = await import("./chunks/browser-JGGSYTMS.mjs");
  return createDoltLiteMaterializationRuntime(await DeterministicMaterializer.open(options));
}
export {
  createSqlMaterializationRuntime
};
