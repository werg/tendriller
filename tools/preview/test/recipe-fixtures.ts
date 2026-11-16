import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startServer } from '../lib/preview.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export function fixtureFor(recipe: string) {
  return JSON.parse(readFileSync(resolve(root, 'recipes', recipe, 'scenario.json'), 'utf8'));
}
export function startRecipe(recipe: string, state: object = {}, fixture: object = {}) {
  return startServer(resolve(root, 'recipes', recipe), state, { ...fixtureFor(recipe), ...fixture });
}
