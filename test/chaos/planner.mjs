// Turns a seed into a stream of action entries against the evolving model.
// Entry 0 bootstraps one enrolled browser; a heal phase is inserted every
// `healEvery` chaos actions. Because structural model state depends only on
// parameters, the same seed and configuration always yield the same sequence.
import { ACTIONS, chooseAction } from './actions.mjs';
import { createRng } from './prng.mjs';

export function createPlanner({ seed, runId, healEvery = 15, registry = ACTIONS }) {
  const rng = createRng(seed);
  const context = { runId };
  let actions = 0, sinceHeal = 0;
  return {
    rng, context,
    get actions() { return actions; },
    /** The next entry for `model` ({ name, params }); does not apply it. */
    next(model) {
      if (!model.profiles.length && model.agent === 'running') {
        actions++; sinceHeal++;
        return { name: 'browser.enroll', params: registry['browser.enroll'].plan(rng, model, context) };
      }
      if (sinceHeal >= healEvery) { sinceHeal = 0; return { name: 'heal', params: {} }; }
      actions++; sinceHeal++;
      return chooseAction(rng, model, context, registry);
    },
  };
}

/** A run id derived from the seed keeps note tokens identical across replays of one seed. */
export const runIdForSeed = seed => seed.toString(36);
