import { ARCHIVE_METADATA } from './archive-metadata.mjs';
// Package public onboarding from the same maintained sources used in the repo.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const ONBOARDING_DOCS = Object.freeze([
  'agent.md', 'docs/MCP_AGENT_GUIDE.md', 'docs/CAPABILITIES.md', 'docs/SENSORS.md', 'docs/OBSERVATION_REFERENCE.md', 'docs/AGENT_DELIVERY.md',
  'docs/BUILD_AN_APP.md', 'docs/APP_PATTERNS.md', 'docs/AGENT_REQUESTS.md', 'docs/AGENT_RESTART.md', 'docs/CONVERSATION_DELIVERY.md', 'docs/AI_INPUT.md',
  'docs/STATE_MODELS.md', 'docs/APPLICATION_BACKENDS.md', 'docs/SESSION_BOOTSTRAP.md', 'docs/AUTHORITY_AND_PUBLICATIONS.md',
  'docs/PEER_ARCHITECTURE.md', 'docs/MEMBERSHIP.md',
  'docs/MULTIPARTICIPANT.md', 'docs/TRANSPORT_DIAGNOSTICS.md', 'docs/AGENT_BINDINGS.md', 'docs/APPLICATION_SIGNALS.md',
  'docs/CHATGPT_INTEGRATION.md', 'docs/CLOUDFLARE_ASSISTANT.md',
  'docs/TROUBLESHOOTING.md', 'docs/tools/CLI.md', 'docs/DEPLOYMENT_GUIDE.md', 'docs/SERVERLESS_HOST.md',
  'docs/LOCAL_HOST.md',
]);
export const ONBOARDING_IMAGES = Object.freeze([
  'docs/assets/app-patterns-desktop.png', 'docs/assets/app-patterns-phone.png', 'docs/assets/app-patterns-states.png',
]);
export const TUTORIAL_FILES = Object.freeze([
  '.gitignore',
  'README.md',
  'package.json',
  'setup.mjs',
  'consumers/codex-queue.mjs',
  'consumers/request-worker.mjs',
  'shared/cli-lifetime.mjs',
  'shared/connect-view.mjs',
  'shared/connection.mjs',
  'shared/helpers/agent-consumer.mjs',
  'shared/helpers/agent-requests.mjs',
  'shared/helpers/hosted-mcp.mjs',
  'shared/helpers/browser-bootstrap.mjs',
  'shared/helpers/browser-profile.mjs',
  'shared/helpers/codex-rpc.mjs',
  'shared/helpers/data-feed.mjs',
  'shared/helpers/dev-telemetry.mjs',
  'shared/helpers/diagnostics-panel.mjs',
  'shared/helpers/finality-view.mjs',
  'shared/helpers/mobile-media.mjs',
  'shared/helpers/operation-view.mjs',
  'shared/helpers/page-provisioning.mjs',
  'shared/helpers/prepare-host.mjs',
  'shared/helpers/provisioning-view.mjs',
  'shared/helpers/reviewed-input.mjs',
  'shared/helpers/signal-request.mjs',
  'shared/helpers/submission-state.mjs',
  'shared/local.mjs',
  'shared/media/camera.mjs',
  'shared/media/inference-client.mjs',
  'shared/media/inference-peer.mjs',
  'shared/media/inference-protocol.mjs',
  'shared/media/inference-service.mjs',
  'shared/media/panel.mjs',
  'shared/media/provider-openai.mjs',
  'shared/media/voice.mjs',
  'shared/native-page.mjs',
  'shared/observation/README.md',
  'shared/observation/browser.mjs',
  'shared/observation/domain.mjs',
  'shared/observation/native.mjs',
  'shared/observation/panel.mjs',
  'shared/observation/protocol.mjs',
  'shared/observation/receiver.mjs',
  'shared/participant-lifecycle.mjs',
  'shared/publish.mjs',
  'shared/ui/chat-session.mjs',
  'shared/ui/dashboard.mjs',
  'shared/ui/patterns.mjs',
  'shared/ui/showcase.html',
  'shared/ui/showcase.mjs',
  'templates/inventory/README.md',
  'templates/inventory/agent.mjs',
  'templates/inventory/build.mjs',
  'templates/inventory/demo.mjs',
  'templates/inventory/domain.mjs',
  'templates/inventory/engine.mjs',
  'templates/inventory/index.html',
  'templates/inventory/page.mjs',
  'templates/inventory/publish.mjs',
  'templates/inventory/setup.mjs',
  'templates/inventory/ui-state.mjs',
  'templates/inventory/worker.mjs',
  'templates/notes/agent.mjs',
  'templates/notes/build.mjs',
  'templates/notes/domain.mjs',
  'templates/notes/index.html',
  'templates/notes/page.mjs',
  'templates/notes/publish.mjs',
  'templates/notes/setup.mjs',
  'templates/notes/worker.mjs',
  'deploy/Dockerfile',
  'deploy/Dockerfile.dockerignore',
  'deploy/tendriller.service',
  'deploy/dev.tendriller.agent.plist',
  'deploy/install-windows-task.ps1',
]);
// Root deploy/ is the single maintained source; only its explicit public files ship.
export const TUTORIAL_SOURCES = Object.freeze(Object.fromEntries(TUTORIAL_FILES.map(file =>
  [file, file.startsWith('deploy/') ? file : `docs/tutorial/${file}`])));

export function tutorialSource(root, file) {
  if (!Object.hasOwn(TUTORIAL_SOURCES, file)) throw Error(`Unlisted starter source: ${file}`);
  return join(root, TUTORIAL_SOURCES[file]);
}

export function copyTutorialSources(root, destination) {
  for (const file of TUTORIAL_FILES) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(tutorialSource(root, file), target);
  }
}

export const TUTORIAL_DOWNLOAD = '/downloads/tendriller-first-app.tgz';

export function combinedOnboarding(root) {
  const sections = ONBOARDING_DOCS.map(path => {
    const source = new URL(path, 'https://tendriller.dev/');
    // Relative Markdown links must keep their original meaning after combining files.
    const content = readFileSync(join(root, path), 'utf8').replace(/(\[[^\]\n]*\]\()([^\s)]+)(\))/g,
      (_match, before, target, after) => `${before}${new URL(target, source).href}${after}`);
    return `\n---\n\nSource: ${source.href}\n\n${content.trim()}\n`;
  });
  return '# Tendriller: complete agent onboarding\n\n' +
    'Generated from the maintained guides. Begin with Build an app; follow links for protocol details.\n' +
    'Index: https://tendriller.dev/llms.txt\n' + sections.join('');
}

export function buildOnboardingAssets(root, out) {
  writeFileSync(join(out, 'llms-full.txt'), combinedOnboarding(root));
  for (const path of ONBOARDING_IMAGES) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    copyFileSync(join(root, path), join(out, path));
  }
  mkdirSync(join(out, 'downloads'), { recursive: true });
  // Explicit inputs prevent accidental publication of local devices, handles,
  // keys, node_modules or generated UI from a developer's tutorial checkout.
  const staged = mkdtempSync(join(tmpdir(), 'tendriller-starter-'));
  try {
    copyTutorialSources(root, staged);
    execFileSync('tar', [...ARCHIVE_METADATA,
      '-czf', join(out, TUTORIAL_DOWNLOAD.slice(1)), '-C', staged, ...TUTORIAL_FILES]);
  } finally { rmSync(staged, { recursive: true, force: true }); }
}
