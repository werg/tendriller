import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: [new URL('../src/control/experiences.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { planContextSave } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const base = { purpose: 'Garden notes', current_task: 'Inspect leaves', open_questions: ['Which plant?'] };

test('editing the purpose preserves the latest agent task, decisions and handled checkpoint', () => {
  const latest = { ...base, current_task: 'Compare photographs', completed: ['Captured three photographs'], decisions: ['Use morning light'], last_handled_seq: 42 };
  const before = structuredClone(latest);
  const plan = planContextSave(base, { ...base, purpose: 'A seasonal garden record' }, latest);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.edited, ['purpose']);
  assert.deepEqual(plan.next, { ...latest, purpose: 'A seasonal garden record' });
  assert.deepEqual(latest, before);
});

test('concurrent changes to the same context field require an explicit review', () => {
  const plan = planContextSave(base, { ...base, current_task: 'Count new shoots' }, { ...base, current_task: 'Compare photographs', last_handled_seq: 42 });
  assert.deepEqual(plan.conflicts, ['current_task']);
});

test('identical concurrent edits do not create a false conflict', () => {
  const same = { ...base, current_task: 'Compare photographs' };
  assert.deepEqual(planContextSave(base, same, { ...same, last_handled_seq: 42 }).conflicts, []);
});

test('open question arrays are checked for conflicts while unedited questions stay current', () => {
  const latest = { ...base, open_questions: ['Which specimen?'], last_handled_seq: 42 };
  assert.deepEqual(planContextSave(base, { ...base, open_questions: ['When to prune?'] }, latest).conflicts, ['open_questions']);
  const untouched = planContextSave(base, { ...base, purpose: 'Field work' }, latest);
  assert.deepEqual(untouched.conflicts, []);
  assert.deepEqual(untouched.next.open_questions, latest.open_questions);
});
