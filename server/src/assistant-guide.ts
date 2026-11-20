import type { Env } from './env';
import { HttpError } from './http';
import { onboardingDescriptor } from './onboarding';

// Fixed public paths are shared with SDK consumers; callers cannot choose a fetch destination.
export { ASSISTANT_GUIDES as assistantGuides } from '../../contract/onboarding.mjs';
import { ASSISTANT_GUIDES as assistantGuides } from '../../contract/onboarding.mjs';
export type AssistantGuideTopic = keyof typeof assistantGuides;
export async function assistantGuide(env: Env, origin: string, topic: unknown = 'start') {
  if (typeof topic !== 'string' || !Object.hasOwn(assistantGuides, topic))
    throw new HttpError(400, 'invalid_guide_topic', 'Choose start, build, capabilities, connect, delivery or troubleshooting.');
  const path = assistantGuides[topic as AssistantGuideTopic];
  const response = await env.ASSETS.fetch(new Request(origin + path));
  if (!response.ok) throw new HttpError(503, 'guide_unavailable', 'The deployed onboarding document is unavailable.');
  const url = origin + path;
  const text = (await response.text()).replaceAll('https://tendriller.dev', origin)
    .replace(/(\[[^\]\n]*\]\()([^\s)]+)(\))/g,
      (_match, before, target, after) => `${before}${new URL(target, url).href}${after}`);
  return { topic, serviceOrigin: origin, url, text,
    onboarding: onboardingDescriptor(origin) };
}
export function assistantSetup(origin: string, empty: boolean) {
  return {
    guideTool: 'tendril_guide', topic: 'start', serviceOrigin: origin,
    startHere: origin + assistantGuides.start,
    nextAction: empty
      ? 'No applications are connected to this account yet. For a new app, call tendril_guide now and follow its build route; an empty list is not a missing plugin. For an existing app, follow its connect route.'
      : 'Use describe_application for an existing app. To build another app or discover sensors and UI patterns, call tendril_guide.',
  };
}
