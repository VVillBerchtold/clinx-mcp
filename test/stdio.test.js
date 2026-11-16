// The helper-program door, tried the way an assistant app uses it: start the program, write
// messages to it one per line, read the answers one per line, close it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/stdio.js', import.meta.url));
const DATA = fileURLToPath(new URL('./data', import.meta.url));

/** Start the program, send the lines, close its input, and collect what it wrote. */
function talk(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, CLINX_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, err, replies: out.split('\n').filter(Boolean).map((line) => JSON.parse(line)), raw: out }));
    child.stdin.end(lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  });
}

test('an older client: handshake, list the tools, call one, close', async () => {
  const { code, err, replies, raw } = await talk([
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find_bills', arguments: { state: 'RI', stage: 'Became law' } } },
  ]);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(replies.length, 3, 'the notification gets no answer');
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[0].result.protocolVersion, '2025-06-18');
  assert.equal(byId[1].result.tools.length, 17);
  assert.equal(byId[2].result.structuredContent.matched, 2);
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.split('\n').filter(Boolean).every((line) => line.startsWith('{')), 'one JSON message per line, nothing else');
});

test('a newer client: no handshake, each request names its version', async () => {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const { code, replies } = await talk([
    { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'state_overview', arguments: { state: 'IL' }, _meta: meta } },
  ]);
  assert.equal(code, 0);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.deepEqual(byId.d.result.supportedVersions, ['2026-07-28']);
  assert.equal(byId.c.result.resultType, 'complete');
  assert.equal(byId.c.result.structuredContent.laws.count, 3);
});

test('a line that is not JSON is answered with an error and the program carries on', async () => {
  const { code, replies } = await talk(['this is not json', '', { jsonrpc: '2.0', id: 5, method: 'ping' }]);
  assert.equal(code, 0);
  assert.equal(replies.length, 2);
  assert.ok(replies.some((r) => r.error?.code === -32700));
  assert.ok(replies.some((r) => r.id === 5 && r.result));
});

test('the messages Claude Code 2.1.306 sent when it connected on 15 November 2026 are answered', async () => {
  // Copied from the wire as that client sent them, then one tool call in the same shape.
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'claude-code', title: 'Claude Code', version: '2.1.306', description: "Anthropic's agentic coding tool", websiteUrl: 'https://claude.com/claude-code' },
    'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: true }, elicitation: { form: {}, url: {} } },
  };
  const { code, replies } = await talk([
    { jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: { _meta: meta } },
    { method: 'tools/list', jsonrpc: '2.0', id: 0, params: { _meta: meta } },
    { method: 'tools/call', jsonrpc: '2.0', id: 1, params: { name: 'find_bills', arguments: { state: 'RI', stage: 'Became law' }, _meta: meta } },
  ]);
  assert.equal(code, 0);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.deepEqual(byId['server-discover-probe-1'].result.supportedVersions, ['2026-07-28']);
  assert.equal(byId[0].result.tools.length, 17);
  assert.equal(byId[1].result.resultType, 'complete');
  assert.equal(byId[1].result.structuredContent.matched, 2);
});
