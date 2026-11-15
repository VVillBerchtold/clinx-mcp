// What a host is told about each request, by kind. The point of these tests is as much what is
// left out as what is kept: nothing typed freely, and nothing about who asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/core.js';
import { localTables } from '../src/disk.js';
import { respond } from '../src/http.js';
import { describeRequest, NOT_A_REQUEST } from '../src/usage.js';

const DATA = fileURLToPath(new URL('./data', import.meta.url));
const tables = localTables({ folder: DATA, now: () => Date.parse('2026-11-15T12:00:00Z') });
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'Claude-Code', version: '2.1.306' } };

const asked = async (message) => describeRequest(message, await handle(message, tables));
const call = (name, args, meta) => asked({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });

test('a tool call: the tool, the place, the filters by name, and whether it was answered', async () => {
  assert.deepEqual(await call('find_bills', { state: 'tx', kind: 'contract-pharmacy', text: 'my private search words', limit: 5 }, META), {
    method: 'tools/call',
    tool: 'find_bills',
    outcome: 'answered',
    place: 'TX',
    filters: 'kind=contract-pharmacy limit text',
    looked_up: '',
    client: 'claude-code',
    version: '2026-07-28',
  });
  const notices = await call('find_notices', { open_for_comment: true, type: 'Proposed Rule', from: '2026-01-01' });
  assert.equal(notices.filters, 'from open_for_comment=true type=Proposed Rule');
  assert.equal(notices.place, '');
  assert.equal(notices.client, '');
  assert.equal(notices.version, '');
  assert.equal((await call('calendar', { state: 'FED' })).place, 'FED');
  assert.equal((await call('about_the_data', {})).filters, '');
});

test('what was typed freely never gets in: words, dates, limits, ids that were not found', async () => {
  const secret = 'Jane Doe 555-12-3456 jane@example.org';
  const rows = [
    await call('find_bills', { text: secret, state: secret }),
    await call('find_bills', { stage: secret, kind: secret }),
    await call('get_bill', { bill_id: secret }),
    await call('get_notice', { notice_id: secret }),
    await call('calendar', { from: '2027-01-15', to: '2027-02-15', bill_id: secret, notice_id: secret }),
    await call(secret, { text: secret }),
    await asked({ jsonrpc: '2.0', id: 1, method: secret, params: { [secret]: secret } }),
    await asked({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: secret, capabilities: {}, clientInfo: { name: 'x', version: secret } } }),
    describeRequest(secret, null),
    describeRequest({ method: 7, secret }, null),
  ];
  for (const row of rows) {
    const text = JSON.stringify(row);
    for (const piece of ['Jane', 'Doe', '555', 'jane@', 'example.org', '2027-01-15', '2027-02-15']) assert.ok(!text.includes(piece), `${piece} in ${text}`);
    assert.deepEqual(Object.keys(row), Object.keys(NOT_A_REQUEST), 'always the same eight fields, nothing more');
  }
  assert.equal(rows[0].place, '');
  assert.equal(rows[1].filters, 'kind stage', 'a value that is not one of the listed choices is not kept');
  assert.equal(rows[5].tool, 'unknown');
  assert.equal(rows[6].method, 'other');
  assert.equal(rows[7].version, 'other');
});

test('a client program\'s name is cut down to plain letters', async () => {
  const meta = (name) => ({ ...META, 'io.modelcontextprotocol/clientInfo': { name } });
  assert.equal((await call('about_the_data', {}, meta('  My <b>App</b>\n(v2) of jane@example.org  '))).client, 'my b app b v2 of jane example.org');
  assert.equal((await call('about_the_data', {}, meta('x'.repeat(200)))).client.length, 40);
  assert.equal((await call('about_the_data', {}, meta({ nested: 'thing' }))).client, '');
  const hello = await asked({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Cursor', version: '9' } } });
  assert.deepEqual([hello.method, hello.client, hello.version, hello.outcome], ['initialize', 'cursor', '2025-06-18', 'answered']);
});

test('a row that was found is named by its public id, taken from the answer', async () => {
  assert.equal((await call('get_bill', { bill_id: 'RI-2025-HB5634' })).looked_up, 'ri-2025-hb5634');
  assert.equal((await call('get_law', { law_id: 'ri-2025-s114' })).looked_up, 'ri-2025-s114');
  assert.equal((await call('get_notice', { notice_id: '91 FR 60568' })).looked_up, 'fr-2026-19535', 'the id found, not the words typed');
  const missing = await call('get_bill', { bill_id: 'ri-1999-nothing' });
  assert.deepEqual([missing.outcome, missing.looked_up, missing.filters], ['mistake', '', 'bill_id']);
});

test('how it went: answered, a mistake, refused, no answer, tables unreachable', async () => {
  assert.equal((await call('find_bills', { limit: 1000 })).outcome, 'mistake');
  assert.equal((await asked({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).outcome, 'refused');
  const note = await asked({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual([note.method, note.outcome], ['notification', 'no answer']);
  assert.deepEqual([(await asked({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).method, (await asked({ jsonrpc: '2.0', id: 1, method: 'ping' })).outcome], ['tools/list', 'answered']);
  const { makeTables } = await import('../src/tables.js');
  const broken = makeTables({ source: 'https://example.invalid/', fetcher: async () => { throw new Error('offline'); } });
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_laws', arguments: { state: 'RI' } } };
  assert.equal(describeRequest(message, await handle(message, broken)).outcome, 'tables unreachable');
});

test('the web door hands each request to the host\'s counter, and a broken counter costs nobody an answer', async () => {
  const seen = [];
  const post = (body, options, headers = {}) => respond(new Request('https://example.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { tables, origins: 'any', ...options });
  const counted = (row) => seen.push(row);

  await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'state_overview', arguments: { state: 'IL' } } }, { counted });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { counted });
  await post('{not json', { counted });
  await post('a=b', { counted }, { 'content-type': 'text/plain' });
  await respond(new Request('https://example.test/mcp', { method: 'GET' }), { tables, origins: 'any', counted });
  await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }, { counted }, { 'mcp-method': 'tools/call' });
  await respond(new Request('https://example.test/mcp', { method: 'OPTIONS', headers: { origin: 'https://some.app' } }), { tables, origins: 'any', counted });
  assert.deepEqual(seen.map((r) => [r.method, r.tool, r.outcome, r.place]), [
    ['tools/call', 'state_overview', 'answered', 'IL'],
    ['notification', '', 'no answer', ''],
    ['not a request', '', 'refused', ''],
    ['not a request', '', 'refused', ''],
    ['not a request', '', 'refused', ''],
    ['tools/list', '', 'refused', ''],
  ], 'a browser\'s preflight is not a question and is not counted');

  const reply = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { counted: () => { throw new Error('the counter is down'); } });
  assert.equal(reply.status, 200);
  const none = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, {});
  assert.equal(none.status, 200, 'with no counter given, nothing is counted at all');
});
