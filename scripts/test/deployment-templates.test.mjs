import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = path => readFileSync(new URL('../../deploy/' + path, import.meta.url), 'utf8');

test('templates run the one agent program with the actual private store and a Node24 container', () => {
  const docker = template('Dockerfile');
  assert.match(docker, /FROM node:24-/); assert.match(docker, /VOLUME \["\/app\/\.tendriller"\]/);
  assert.match(docker, /CMD \["node", "node_modules\/@tendriller\/tools\/bin\/tendril.mjs", "agent", "run"\]/);
  assert.doesNotMatch(docker, /\/data\/\.tendriller/);
  assert.match(template('Dockerfile.dockerignore'), /^\.tendriller$/m);
  assert.match(template('Dockerfile.dockerignore'), /^\*\*\/\.tendriller$/m);
  for (const path of ['tendriller.service', 'dev.tendriller.agent.plist', 'install-windows-task.ps1']) {
    assert.match(template(path), /@tendriller[\/\\]tools[\/\\]bin[\/\\]tendril\.mjs/); assert.match(template(path), /agent(<\/string>\s*<string>| )run/);
    assert.doesNotMatch(template(path), /--session|participant\.mjs/);
  }
});

test('Windows installs a limited current-user logon task without SCM or overwrite', () => {
  const windows = template('install-windows-task.ps1');
  assert.match(windows, /-AtLogOn -User \$user/);
  assert.match(windows, /-LogonType Interactive -RunLevel Limited/);
  assert.match(windows, /-MultipleInstances IgnoreNew/);
  assert.match(windows, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(windows, /-WorkingDirectory \$directory/);
  assert.match(windows, /SupportsShouldProcess/);
  assert.doesNotMatch(windows, /New-Service|BinaryPathName|-Force\b|LogonType Password/);
});
