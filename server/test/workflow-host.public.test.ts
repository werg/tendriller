import { beforeAll, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { create, inDO } from './helpers';
import { configureWorkflows, handleWorkflows, synchronizeWorkflows } from '../src/workflows';
import { scopes } from '../src/scopes';
import type { WorkflowHost, WorkflowModule } from '../../contract/host.d.mts';
import { RESOURCE_LIMITS } from '../../contract/limits.mjs';

beforeAll(async () => { await applyD1Migrations(env.ACCOUNTS, inject('d1Migrations')); await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); });
const agent = { kind: 'agent' as const, name: 'main', credentialHash: 'test' };
const guest = { kind: 'page' as const, name: 'guest', accountId: 'guest', role: 'guest' as const, linkId: 'link', sessionHash: 'session', deviceId: null };
const module: WorkflowModule = { id: 'testmod', interfaceVersion: '1', schemaVersion: '1', implementationVersion: 'test-1', operations: {
  activate: { access: 'controller', mutate: true, run: h => h.scopes.register('testmod:job', { paths: [['payload']], operations: [] }) },
  write: { access: 'controller', mutate: true, scopes: () => ['testmod:job'], run: (h, value: any) => { h.records.put('private', 'record', value); h.state.apply([{ op: 'set', path: ['payload'], value: { public: true } }]); h.emit({ accepted: true }); return { ok: true }; } },
  guarded: { access: 'controller', mutate: true, scopes: () => ['testmod:job'], run: h => {
    // An extension cannot replace the host command's scope or generation guard.
    h.state.apply([{ op: 'set', path: ['payload', 'guarded'], value: true }],
      { expected_generations: {}, scope: 'forged' } as any);
    return { ok: true };
  } },
  read: { access: 'controller', mutate: false, run: h => h.records.get('private', 'record') },
  reject: { access: 'controller', mutate: true, scopes: () => ['testmod:job'], run: h => { h.records.put('private', 'record', { corrupt: true }); h.scopes.rotate('testmod:job'); h.fail(409, 'rejected', 'Rollback required'); } },
} };
it('enforces module permissions, transaction isolation, scope meaning and receipt replay', async () => {
  const page = await create();
  await inDO(page.id, async t => {
    configureWorkflows([module]);
    const call = (operation: string, data: unknown = {}, expected_generations: Record<string, string> = {}, who: any = agent, cid = crypto.randomUUID()) => handleWorkflows(t,
      new Request(`https://local/workflows/testmod/${operation}`, { method: 'POST', body: JSON.stringify({ cid, expected_generations, data }) }), `workflows/testmod/${operation}`, who);
    try {
      await expect(call('activate', {}, {}, guest)).rejects.toMatchObject({ code: 'forbidden' });
      const scope = await (await call('activate')).json<any>();
      await expect(call('write', { private: 'secret' })).rejects.toMatchObject({ code: 'generation_required' });
      const guards = { [scope.id]: scope.generation }, cid = crypto.randomUUID();
      expect(await (await call('write', { private: 'secret' }, guards, agent, cid)).json()).toEqual({ ok: true });
      const revision = t.getState().rev;
      expect(await (await call('write', { private: 'secret' }, guards, agent, cid)).json()).toEqual({ ok: true });
      expect(t.getState().rev).toBe(revision);
      expect(await (await call('guarded', {}, guards)).json()).toEqual({ ok: true });
      expect(t.getState().state).toMatchObject({ payload: { guarded: true } });
      await expect(call('read', {}, {}, guest)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(call('reject', {}, guards)).rejects.toMatchObject({ code: 'rejected' });
      expect(await (await call('read')).json()).toEqual({ private: 'secret' });
      expect(scopes(t)[0].generation).toBe(scope.generation);
      expect(JSON.stringify(t.getState().state)).not.toContain('secret');
      const event = t.db.one<{ context: string; data: string }>("SELECT context,data FROM events WHERE context IS NOT NULL ORDER BY seq DESC LIMIT 1")!;
      expect(JSON.parse(event.context)).toEqual({ workflow: 'testmod', operation: 'write', generations: guards });
      expect(event.data).not.toContain('secret');
      configureWorkflows([{ ...module, interfaceVersion: '2' }]);
      await expect(call('write', { private: 'stale' }, guards)).rejects.toMatchObject({ code: 'stale_generation' });
      expect(scopes(t)[0].generation).not.toBe(scope.generation);
      configureWorkflows([]); synchronizeWorkflows(t);
      expect(scopes(t)).toEqual([]);
    } finally { configureWorkflows([]); }
  });
});

it('expires all workflow capabilities when a callback returns and rolls back asynchronous callbacks', async () => {
  const page = await create();
  await inDO(page.id, async t => {
    let retained: WorkflowHost | undefined;
    let continuation: Promise<unknown> | undefined;
    const lifetime: WorkflowModule = { ...module, operations: {
      retain: { access: 'controller', mutate: false, run: h => { retained = h; return { ok: true }; } },
      deferred: { access: 'controller', mutate: true, run: h => {
        h.records.put('private', 'rollback', { invalid: true });
        continuation = Promise.resolve().then(() => h.records.put('private', 'late', { invalid: true }));
        return continuation;
      } },
    } };
    const call = (operation: string) => handleWorkflows(t, new Request(`https://local/workflows/testmod/${operation}`, {
      method: 'POST', body: JSON.stringify({ cid: crypto.randomUUID(), expected_generations: {}, data: {} }),
    }), `workflows/testmod/${operation}`, agent);
    try {
      expect(() => configureWorkflows([{ ...lifetime, operations: { invalid: {
        access: 'controller', mutate: true, run: async () => null,
      } } }])).toThrow('synchronous');
      configureWorkflows([lifetime]);
      await call('retain');
      expect(() => retained!.records.get('private', 'record')).toThrow('expire');
      expect(() => retained!.state.get()).toThrow('expire');
      expect(() => retained!.scopes.get('testmod:job')).toThrow('expire');
      expect(() => retained!.participants()).toThrow('expire');
      expect(() => retained!.records.put('private', 'late', {})).toThrow('expire');
      await expect(call('deferred')).rejects.toThrow('synchronously');
      await expect(continuation).rejects.toThrow('expire');
      expect(t.db.all('SELECT * FROM workflow_records WHERE module=?', 'testmod')).toEqual([]);
      expect(t.db.all('SELECT * FROM commands')).toEqual([]);
    } finally { configureWorkflows([]); }
  });
});

it('rolls back private records, state, generations and effects when the page record budget is exhausted', async () => {
  const page = await create();
  await inDO(page.id, async t => {
    let effect = false;
    const limited: WorkflowModule = { ...module, operations: { ...module.operations,
      archive: { access: 'controller', mutate: true, scopes: () => ['testmod:job'], run: h => {
        h.records.put('archive', 'first', { preserved: true });
        h.state.apply([{ op: 'set', path: ['payload'], value: { reset: true } }]);
        h.scopes.rotate('testmod:job');
        h.afterCommit(() => { effect = true; });
        h.records.put('archive', 'second', { exceeds: true });
        return { ok: true };
      } },
    } };
    configureWorkflows([limited]);
    const call = (operation: string, guards = {}) => handleWorkflows(t, new Request(`https://local/workflows/testmod/${operation}`, {
      method: 'POST', body: JSON.stringify({ cid: crypto.randomUUID(), expected_generations: guards, data: {} }),
    }), `workflows/testmod/${operation}`, agent);
    try {
      const scope = await (await call('activate')).json<any>();
      t.db.run(`WITH RECURSIVE records(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM records WHERE n<?)
        INSERT INTO workflow_records(module,collection,key,value) SELECT 'another-module','records',CAST(n AS TEXT),'{}' FROM records`, RESOURCE_LIMITS.private_records - 1);
      await expect(call('archive', { [scope.id]: scope.generation })).rejects.toMatchObject({ code: 'resource_quota' });
      expect(t.db.all('SELECT * FROM workflow_records WHERE module=?', 'testmod')).toEqual([]);
      expect(t.getState().state).toEqual({});
      expect(scopes(t)[0].generation).toBe(scope.generation);
      expect(effect).toBe(false);
    } finally { configureWorkflows([]); }
  });
});
