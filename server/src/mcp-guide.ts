import type { Env } from './env';
import { HttpError } from './http';
import { onboardingDescriptor } from './onboarding';
import { serviceIdentity } from './service-identity';
import { serviceReadiness } from './service-state';

export { ASSISTANT_GUIDES as assistantGuides } from '../../contract/onboarding.mjs';
import { ASSISTANT_GUIDES as assistantGuides } from '../../contract/onboarding.mjs';
export type AssistantGuideTopic = keyof typeof assistantGuides;

export async function assistantGuide(env: Env, origin: string, topic: unknown = 'start') {
  if (typeof topic !== 'string' || !Object.hasOwn(assistantGuides, topic))
    throw new HttpError(400, 'invalid_guide_topic', 'Choose start, build, capabilities, sensors, connect, deployment, delivery, conversation or troubleshooting.');
  const path = assistantGuides[topic as AssistantGuideTopic];
  const response = await env.ASSETS.fetch(new Request(origin + path));
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(503, 'guide_unavailable',
      `The onboarding document at ${origin + path} is unavailable. Inspect ${origin}/.well-known/tendriller.json and ask this service's operator to restore its guide. Keep setup on ${origin}; do not switch to another host.`);
  }
  const url = origin + path;
  const discovery = await assistantDiscovery(env, origin);
  const notice = !discovery.readiness.creation.available && ['start', 'build'].includes(topic)
    ? `New application setup is blocked: ${discovery.readiness.creation.message}\n${discovery.readiness.creation.nextAction}\nExisting applications remain governed by their current permissions and write availability.\n\n`
    : '';
  const text = notice + (await response.text()).replaceAll('https://tendriller.dev', origin)
    .replace(/(\[[^\]\n]*\]\()([^\s)]+)(\))/g,
      (_match, before, target, after) => `${before}${new URL(target, url).href}${after}`);
  return { topic, ...discovery, url, text, onboarding: onboardingDescriptor(origin) };
}

export function assistantSetup(origin: string, empty?: boolean) {
  const onboarding = onboardingDescriptor(origin);
  return {
    guideTool: 'tendril_guide', topic: 'start', serviceOrigin: origin,
    startHere: origin + assistantGuides.start,
    buildGuide: onboarding.start_here,
    discoveryUrl: origin + '/.well-known/tendriller.json',
    serviceDescriptor: onboarding.interfaces.service_descriptor,
    readinessUrl: onboarding.interfaces.readiness,
    conversationGuide: onboarding.documentation.conversation_delivery,
    conversationWake: 'not-established',
    conversationNextAction: 'Read the conversation guide and verify injection into the exact active turn plus two requests in the same existing thread across turn completion. A connected page owner or forwarded event is not an active assistant worker.',
    starter: onboarding.starter,
    originPolicy: 'same-origin-only',
    guideUnavailableAction: `If tendril_guide is missing from the installed tools, read ${origin + assistantGuides.start} directly, or use ${origin}/.well-known/tendriller.json. Refresh the installed plugin's tool catalog when possible. Keep all setup on ${origin}; do not substitute another service origin.`,
    nextAction: empty === true
      ? 'No applications are opted into hosted MCP for this OAuth grant yet. Call tendril_guide to build an app, or ask the owner to opt in an existing page at /connections or Page options → Agents.'
      : 'Use describe_application for an existing app. To build or connect an app, call tendril_guide or read startHere directly.',
  };
}

export async function assistantDiscovery(env: Env, origin: string, empty?: boolean) {
  const readiness = await serviceReadiness(env);
  const setup = assistantSetup(origin, empty);
  if (empty === true && !readiness.creation.available) setup.nextAction = readiness.creation.nextAction;
  return { ...serviceIdentity(env), readiness, setup };
}
