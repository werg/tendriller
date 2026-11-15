import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartSeries, sourceKey } from '../../examples/training-dashboard/model.mjs';

const point = (source, run, step, loss, ts) => ({ ts, data: { source, run, step, loss } });
test('overlapping training steps stay separate across sources and experiments', () => {
  const records = [point('a', 'run-1', 2, 0.4, 200), point('b', 'run-1', 1, 5, 100),
    point('a', 'run-2', 1, 10, 300), point('a', 'run-1', 1, 0.8, 100)];
  const model = chartSeries(records, 'loss');
  assert.equal(model.axis, 'step');
  assert.equal(model.groups.length, 3);
  assert.deepEqual(model.groups.find(g => g.label === 'a / run-1').points, [{ x: 1, y: 0.8 }, { x: 2, y: 0.4 }]);
  assert.equal(chartSeries(records, 'loss', sourceKey(records[0].data)).groups.length, 1);
});

test('mixed step availability uses timestamps consistently and ignores nonnumeric values', () => {
  const records = [point('a', 'one', 1, 4, 100), point('b', 'two', undefined, 3, 200), point('a', 'one', 2, 'NaN', 300)];
  records.push({ ts: 400, data: { source: 'b', run: 'two', metrics: { loss: 1 } } });
  const model = chartSeries(records, 'loss');
  assert.equal(model.axis, 'time');
  assert.deepEqual(model.groups.flatMap(g => g.points).map(p => p.x), [100, 200, 400]);
});
