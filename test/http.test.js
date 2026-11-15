// The web door. First the function itself, with made-up requests; then the real local server
// (src/serve.js) started on a spare port and called over the network of this computer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { respond } from '../src/http.js';
import { localTables } from '../src/disk.js';

const DATA = fileURLToPath(new URL('./data', import.meta.url));
const tables = localTables({ folder: DATA });
const URL_ = 'https://example.test/mcp';
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

const post = (body, headers = {}, options = { origins: 'any' }) =>
  respond(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { tables, ...options });

test('only POST is answered', async () => {
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const reply = await respond(new Request(URL_, { method }), { tables, origins: 'any' });
    assert.equal(reply.status, 405);
    assert.match(reply.headers.get('allow'), /POST/);
  }
});

test('a newer client: one request in, one JSON answer out, with matching headers', async () => {
  const reply = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_laws', arguments: { state: 'RI' }, _meta: META } },
    { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'find_laws' },
  );
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get('content-type'), /application\/json/);
  assert.equal(reply.headers.get('mcp-session-id'), null, 'no sessions');
  const body = await reply.json();
  assert.equal(body.result.resultType, 'complete');
  assert.equal(body.result.structuredContent.matched, 1);
});

test('a header that disagrees with the body is refused', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_laws', arguments: {}, _meta: META } };
  for (const headers of [{ 'mcp-name': 'get_law' }, { 'mcp-method': 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' }]) {
    const reply = await post(body, headers);
    assert.equal(reply.status, 400);
    const said = await reply.json();
    assert.equal(said.error.code, -32020);
    assert.match(said.error.message, /^Header mismatch/);
  }
});

test('the newer protocol maps its errors to web statuses', async () => {
  const unknown = await post({ jsonrpc: '2.0', id: 1, method: 'nothing/here', params: { _meta: META } });
  assert.equal(unknown.status, 404);
  const version = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
  assert.equal(version.status, 400);
  assert.equal((await version.json()).error.code, -32022);
  const noCapabilities = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
  assert.equal(noCapabilities.status, 400);
});

test('an older client: handshake over the web, errors under a plain 200', async () => {
  const hello = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(hello.status, 200);
  assert.equal((await hello.json()).result.protocolVersion, '2025-11-25');
  const ready = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(ready.status, 202);
  assert.equal(await ready.text(), '');
  const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).error.code, -32601);
});

test('bad requests: not JSON, wrong type, too large', async () => {
  const broken = await post('{not json');
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, -32700);
  const form = await post('a=b', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  const huge = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } }));
  assert.equal(huge.status, 413);
});

test('who may call: a public host lets any page, a local one only this computer', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const open = await post(body, { origin: 'https://some.app' }, { origins: 'any' });
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('access-control-allow-origin'), '*');
  const refused = await post(body, { origin: 'https://some.app' }, { origins: 'local' });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('access-control-allow-origin'), null);
  const mine = await post(body, { origin: 'http://localhost:5173' }, { origins: 'local' });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const noOrigin = await post(body, {}, { origins: 'local' });
  assert.equal(noOrigin.status, 200, 'a program that is not a web page sends no Origin');
  const preflight = await respond(new Request(URL_, { method: 'OPTIONS', headers: { origin: 'https://some.app' } }), { tables, origins: 'any' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /mcp-protocol-version/);
});

test('the real local server answers over this computer\'s network', async (t) => {
  const port = 18340 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/serve.js', import.meta.url))], { env: { ...process.env, PORT: String(port), CLINX_DATA_DIR: DATA }, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stderr.once('data', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the server stopped with ${code}`)));
  });
  const at = `http://127.0.0.1:${port}/mcp`;
  const call = (body, headers = {}) => fetch(at, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.tools.length, 9);

  const called = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'calendar', arguments: { state: 'IL' } } });
  assert.equal((await called.json()).result.isError, false);

  assert.equal((await fetch(at)).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  assert.equal((await call({ jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await call({ jsonrpc: '2.0', id: 4, method: 'ping', params: { pad: 'x'.repeat(70_000) } })).status, 413);
});
