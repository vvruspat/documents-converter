import assert from 'node:assert/strict';
import test from 'node:test';
import { createReasoningPolicy } from './reasoning.js';

test('chooses supported role-specific efforts and shares the public catalog across concurrent reads', async () => {
  let loads = 0;
  const choose = createReasoningPolicy(async (_url, init) => {
    loads++;
    assert.equal(init?.headers, undefined);
    return Response.json({data: [
      {id:'optional', reasoning:{mandatory:false, supported_efforts:['none','low','high']}},
      {id:'required', reasoning:{mandatory:true, supported_efforts:['low','minimal','none']}},
      {id:'standard'},
    ]});
  });
  const results = await Promise.all([
    choose('optional','ocr'), choose('optional','chat'), choose('required','ocr'),
    choose('required','chat'), choose('standard','ocr'), choose('unknown','chat'),
  ]);
  assert.deepEqual(results, [...['none','low','minimal','low'].map(effort => ({reasoning:{effort}})), {}, {}]);
  assert.equal(loads, 1);
});

test('a catalog failure does not block recognition or cause a lookup per page', async () => {
  let calls = 0;
  const choose = createReasoningPolicy(async () => { calls++; return new Response(null, {status:503}); });
  assert.deepEqual(await choose('unknown','ocr'), {});
  assert.deepEqual(await choose('unknown','ocr'), {});
  assert.equal(calls, 1);
});
