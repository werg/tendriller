import { ARCHIVE_METADATA } from './archive-metadata.mjs';
// Package public onboarding from the same maintained sources used in the repo.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const ONBOARDING_DOCS = Object.freeze([
  'agent.md', 'docs/MCP_AGENT_GUIDE.md', 'docs/CAPABILITIES.md', 'docs/SENSORS.md', 'docs/OBSERVATION_REFERENCE.md', 'docs/AGENT_DELIVERY.md',
  'docs/BUILD_AN_APP.md', 'docs/APP_PATTERNS.md', 'docs/AI_INPUT.md',
  'docs/STATE_MODELS.md', 'docs/SESSION_BOOTSTRAP.md',
  'docs/MULTIPARTICIPANT.md', 'docs/TRANSPORT_DIAGNOSTICS.md', 'docs/AGENT_BINDINGS.md', 'docs/APPLICATION_SIGNALS.md',
  'docs/CHATGPT_INTEGRATION.md', 'docs/CLOUDFLARE_ASSISTANT.md',
  'docs/TROUBLESHOOTING.md', 'docs/tools/CLI.md', 'docs/DEPLOYMENT_GUIDE.md', 'docs/SERVERLESS_HOST.md',
  'docs/MIGRATION_RC16_RC17.md', 'docs/LOCAL_HOST.md',
]);
export const ONBOARDING_IMAGES = Object.freeze([
  'docs/assets/app-patterns-desktop.png', 'docs/assets/app-patterns-phone.png', 'docs/assets/app-patterns-states.png',
]);
export const TUTORIAL_FILES = Object.freeze([
  '.gitignore', 'README.md', 'package.json', 'domain.mjs', 'setup.mjs', 'account-setup.mjs', 'host-adoption.mjs',
  'session.mjs', 'assistant.mjs', 'local.mjs', 'build.mjs', 'index.html', 'page.mjs', 'worker.mjs',
  'pairing-browser.mjs', 'pairing-worker.mjs', 'pairing-native.mjs', 'connection.mjs', 'connect-view.mjs',
  'helpers/cli-lifetime.mjs', 'helpers/browser-profile.mjs', 'helpers/participant-lifecycle.mjs', 'helpers/submission-state.mjs',
  'ui/patterns.mjs', 'ui/showcase.html', 'ui/showcase.mjs',
  'helpers/operation-view.mjs', 'helpers/reviewed-input.mjs', 'helpers/signal-request.mjs', 'helpers/diagnostics-panel.mjs',
  'media/panel.mjs', 'media/camera.mjs', 'media/voice.mjs', 'media/inference-client.mjs',
  'media/inference-service.mjs', 'media/inference-protocol.mjs',
  'media/inference-peer.mjs', 'media/provider-openai.mjs',
  'sql/.gitignore', 'sql/README.md', 'sql/package.json', 'sql/local.mjs',
  'sql/engine.mjs', 'sql/domain.mjs', 'sql/setup.mjs', 'sql/session.mjs',
  'sql/demo.mjs', 'sql/worker.mjs', 'sql/index.html', 'sql/page.mjs', 'sql/build.mjs', 'sql/ui-state.mjs',
  'deploy/participant.mjs', 'deploy/Dockerfile', 'deploy/Dockerfile.dockerignore',
  'deploy/tendriller.service', 'deploy/dev.tendriller.participant.plist', 'deploy/install-windows-task.ps1',
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
