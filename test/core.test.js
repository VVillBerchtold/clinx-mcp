// The server's answers, checked message by message against small real slices of the tables
// (test/data). No network is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { handle, answer, SERVER, MODERN, LEGACY, CODE } from '../src/core.js';
import { makeTables } from '../src/tables.js';
import { localTables } from '../src/disk.js';
import { TOOLS } from '../src/tools.js';
import { echo, fitRows, leftOutForSize, sizeOf, ANSWER_MOST } from '../src/inputs.js';

export const DATA = fileURLToPath(new URL('./data', import.meta.url));
// The clock stands still on the day the slices were cut, so "coming up" and "open for comment"
// give the same answers whenever the tests run.
const TODAY = '2026-11-15';
const tables = localTables({ folder: DATA, now: () => Date.parse(`${TODAY}T12:00:00Z`) });
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const SERVER_KEY = 'io.modelcontextprotocol/serverInfo';

const ask = (method, params, id = 1) => handle({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, tables);
const modern = (method, params = {}, id = 1) => ask(method, { ...params, _meta: META }, id);
const run = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result;
/** A tool's answer as an object. The reply carries it once, as JSON in one block of text. */
const read = (result) => JSON.parse(result.content[0].text);

test('the newer protocol: discovery says what the server is and speaks', async () => {
  const { result } = await modern('server/discover');
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, MODERN);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.cacheScope, 'public');
  assert.ok(result.ttlMs > 0);
  assert.equal(result._meta[SERVER_KEY].name, SERVER.name);
  assert.match(result.instructions, /340B/);
});

test('discovery is answered even with no _meta, so any client can find out what is spoken', async () => {
  const { result } = await ask('server/discover');
  assert.deepEqual(result.supportedVersions, MODERN);
});

test('the newer protocol: every answer is marked complete and says who answered', async () => {
  const { result } = await modern('tools/list');
  assert.equal(result.resultType, 'complete');
  assert.equal(result._meta[SERVER_KEY].version, SERVER.version);
  assert.equal(result.cacheScope, 'public');
  assert.equal(result.tools.length, TOOLS.length);
  const called = await modern('tools/call', { name: 'about_the_data' });
  assert.equal(called.result.resultType, 'complete');
  assert.equal(called.result.isError, false);
});

test('the newer protocol: a version the server does not speak is refused with the ones it does', async () => {
  const reply = await ask('tools/list', { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2031-01-01' } });
  assert.equal(reply.error.code, CODE.version);
  assert.equal(reply.error.data.requested, '2031-01-01');
  assert.ok(reply.error.data.supported.includes('2026-07-28'));
});

test('the newer protocol: a request that leaves out the client capabilities is refused', async () => {
  const reply = await ask('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  assert.equal(reply.error.code, CODE.params);
});

test('the older protocol: initialize agrees the version the client asked for', async () => {
  for (const version of LEGACY) {
    const { result } = await ask('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(result.protocolVersion, version);
    assert.equal(result.serverInfo.name, SERVER.name);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.equal(result.resultType, undefined);
  }
});

test('the server names its icon: the ClinX mark on clinx.org, a PNG first and then a drawing', async () => {
  assert.deepEqual(SERVER.icons, [
    { src: 'https://clinx.org/brand/clinx-mark-square-1024.png', mimeType: 'image/png', sizes: ['1024x1024'] },
    { src: 'https://clinx.org/brand/clinx-mark-square.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
  ]);
  for (const icon of SERVER.icons) {
    // Only what the protocol defines for an icon, and only addresses on clinx.org over https.
    assert.deepEqual(Object.keys(icon), ['src', 'mimeType', 'sizes']);
    assert.match(icon.src, /^https:\/\/clinx\.org\/brand\/[a-z0-9-]+\.(png|svg)$/);
    for (const size of icon.sizes) assert.match(size, /^(\d+x\d+|any)$/);
  }
  // The newer protocol says who answered on every answer, so the icon travels with each one.
  assert.deepEqual((await modern('server/discover')).result._meta[SERVER_KEY].icons, SERVER.icons);
  assert.deepEqual((await modern('tools/list')).result._meta[SERVER_KEY].icons, SERVER.icons);
});

test('the older protocol: the website and the icon are told to a client of 2025-11-25, which defines them, and to no earlier one', async () => {
  for (const version of LEGACY) {
    const { serverInfo } = (await ask('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } })).result;
    if (version === '2025-11-25') assert.deepEqual(serverInfo, { name: SERVER.name, title: SERVER.title, version: SERVER.version, websiteUrl: SERVER.websiteUrl, icons: SERVER.icons });
    else assert.deepEqual(serverInfo, { name: SERVER.name, title: SERVER.title, version: SERVER.version });
  }
  // A version the server does not know is answered as 2025-11-25, so it gets the same.
  const unknown = (await ask('initialize', { protocolVersion: '2019-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } })).result;
  assert.deepEqual(unknown.serverInfo.icons, SERVER.icons);
});

test('the older protocol: an unknown version is answered with one the server speaks', async () => {
  const { result } = await ask('initialize', { protocolVersion: '2019-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(result.protocolVersion, LEGACY[0]);
});

test('the older protocol: ping, the tool list and a tool call work without _meta', async () => {
  assert.deepEqual((await ask('ping')).result, {});
  const { result } = await ask('tools/list');
  assert.equal(result.resultType, undefined);
  assert.deepEqual(result.tools.map((t) => t.name), ['find_bills', 'get_bill', 'find_laws', 'get_law', 'find_notices', 'get_notice', 'calendar', 'reporting_states', 'find_filings', 'get_filing', 'state_overview', 'find_health_centers', 'get_health_center_report', 'find_funding_opportunities', 'health_center_calendar', 'shortage_area_changes', 'about_the_data']);
});

test('a notification gets no answer', async () => {
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, tables), null);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, tables), null);
});

test('what is not a proper request is refused, never thrown', async () => {
  assert.equal((await answer('{nope', tables)).error.code, CODE.parse);
  assert.equal((await answer('[]', tables)).error.code, CODE.request);
  assert.equal((await answer('"hello"', tables)).error.code, CODE.request);
  assert.equal((await answer('{"jsonrpc":"1.0","id":1,"method":"ping"}', tables)).error.code, CODE.request);
  assert.equal((await ask('resources/list')).error.code, CODE.method);
  assert.equal((await ask('tools/call', { name: 'delete_everything' })).error.code, CODE.params);
  assert.equal((await ask('tools/call', { name: 'find_bills', arguments: [] })).error.code, CODE.params);
});

test('every tool is described so a client can show and call it', () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]+$/);
    assert.ok(tool.title && tool.description.length > 40, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    for (const name of tool.inputSchema.required ?? []) assert.ok(tool.inputSchema.properties[name], `${tool.name}.${name}`);
  }
});

test('every tool states its hints as plain true or false: it reads, removes nothing and reaches nothing outside', async () => {
  assert.equal(TOOLS.length, 17);
  // As the tools are written, and as a client is sent them, the older way and the newer way.
  const listed = (await ask('tools/list')).result.tools;
  const listedModern = (await modern('tools/list')).result.tools;
  assert.equal(listed.length, 17);
  assert.equal(listedModern.length, 17);
  for (const tool of [...TOOLS, ...listed, ...listedModern]) {
    // A directory that lists servers asks for these three to be said, never left to a default.
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}.${hint}`);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(tool.annotations.idempotentHint, true, tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
  }
});

test('find_bills: by state, role, stage, kind and words', async () => {
  const ri = read(await run('find_bills', { state: 'ri' }));
  assert.equal(ri.matched, 3);
  assert.ok(ri.bills.every((b) => b.place === 'RI' && b.official_page.startsWith('http') && b.clinx_page === 'https://clinx.org/bills/ri/'));
  assert.match(ri.retrieved, /^\d{4}-\d{2}-\d{2}$/);

  const law = read(await run('find_bills', { state: 'RI', stage: 'Became law' }));
  assert.deepEqual(law.bills.map((b) => b.bill_id).sort(), ['ri-2025-hb5634', 'ri-2025-sb114']);

  const congress = read(await run('find_bills', { state: 'US', role: 'main' }));
  assert.equal(congress.matched, 4);
  assert.ok(congress.bills.every((b) => b.clinx_page === 'https://clinx.org/bills/congress/'));

  const mention = read(await run('find_bills', { role: 'mention' }));
  assert.deepEqual(mention.bills.map((b) => b.bill_id), ['il-104th-hb3794']);

  const byNumber = read(await run('find_bills', { text: 'hb2371' }));
  assert.ok(byNumber.bills.some((b) => b.bill_id === 'il-104th-hb2371'));

  const limited = read(await run('find_bills', { limit: 2 }));
  assert.equal(limited.bills.length, 2);
  assert.equal(limited.matched, 14);
  const dates = limited.bills.map((b) => b.latest_step_date);
  assert.ok(dates[0] >= dates[1], 'newest activity first');

  const none = read(await run('find_bills', { text: 'zzzznotthere' }));
  assert.equal(none.matched, 0);
});

test('find_bills: a stage that names a chamber is found under the looser stage', async () => {
  const all = read(await run('find_bills', { limit: 100 })).bills;
  const reported = read(await run('find_bills', { stage: 'Reported by committee' }));
  assert.equal(reported.matched, all.filter((b) => b.stage === 'Reported by committee').length);
});

test('get_bill: the whole row and its dated steps', async () => {
  const result = await run('get_bill', { bill_id: 'RI-2025-HB5634' });
  const out = read(result);
  assert.equal(result.isError, false);
  assert.equal(out.bill.bill_id, 'ri-2025-hb5634');
  assert.equal(out.bill.stage, 'Became law');
  assert.ok(out.bill.bill_url.startsWith('http'));
  assert.ok(out.dated_steps.length > 2);
  assert.ok(out.dated_steps.every((e) => e.bill_id === 'ri-2025-hb5634'));
  assert.deepEqual(Object.keys(result), ['content', 'isError'], 'the answer is sent once, as text, and not a second time as structured content');
  assert.deepEqual(result.content.map((block) => block.type), ['text']);
});

test('find_laws and get_law', async () => {
  const il = read(await run('find_laws', { state: 'IL' }));
  assert.equal(il.matched, 3);
  assert.equal(il.dataset_version, '0.6.0');
  assert.ok(il.laws.every((l) => l.clinx_page === 'https://clinx.org/laws/il/' && l.official_page.startsWith('http')));

  const contract = read(await run('find_laws', { kind: 'contract-pharmacy' }));
  assert.deepEqual(contract.laws.map((l) => l.law_id).sort(), ['ar-2021-hb1881', 'il-2026-hb2371', 'ri-2025-s114']);

  const one = read(await run('get_law', { law_id: 'ri-2025-s114' }));
  assert.equal(one.law.state, 'RI');
  assert.ok(one.law.citation && one.law.summary && one.law.source_url);
  assert.equal(one.law.source_sha256, undefined, 'bookkeeping fields are left out');
});

test('calendar: what is coming up by default, a past stretch when asked', async () => {
  const coming = read(await run('calendar'));
  assert.ok(coming.matched >= 2);
  assert.equal(coming.from, TODAY, 'what is coming up starts today');
  assert.ok(coming.events.every((e) => e.day >= TODAY));
  const days = coming.events.map((e) => e.day);
  assert.deepEqual(days, [...days].sort());

  const past = read(await run('calendar', { state: 'RI', from: '2025-01-01', to: '2025-12-31', kind: 'signed' }));
  assert.equal(past.matched, 2);
  assert.ok(past.events.every((e) => e.place === 'RI' && e.kind === 'signed' && e.day === '2025-06-27' && e.official_page.startsWith('http')));

  const oneBill = read(await run('calendar', { bill_id: 'il-104th-hb2371', limit: 100 }));
  assert.ok(oneBill.matched > 3, 'a bill\'s dates are given from the start, not only what is coming');
});

test('calendar: coming up goes by today, not by the day the tables were last brought up to date', async () => {
  const later = localTables({ folder: DATA, now: () => Date.parse('2026-12-01T09:00:00Z') });
  const out = read((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calendar', arguments: { state: 'FED' } } }, later)).result);
  assert.equal(out.from, '2026-12-01');
  assert.equal(out.retrieved, '2026-11-15');
  assert.deepEqual(out.events.map((e) => e.day), ['2027-01-01', '2027-01-01', '2027-09-30', '2028-04-30'], 'the comment deadline of 23 November has passed');
});

test('calendar: federal agencies are a place of their own, with their own kinds of date', async () => {
  const fed = read(await run('calendar', { state: 'fed' }));
  assert.equal(fed.matched, 5);
  assert.ok(fed.events.every((e) => e.place === 'FED' && e.notice_id.startsWith('fr-') && e.bill_id === undefined && e.official_page.startsWith('https://www.federalregister.gov/')));
  assert.deepEqual(fed.events[0], { ...fed.events[0], day: '2026-11-23', kind: 'comments close', notice_id: 'fr-2026-19535' });

  const effective = read(await run('calendar', { kind: 'takes effect' }));
  assert.deepEqual(effective.events.map((e) => e.notice_id).sort(), ['fr-2026-15633', 'fr-2026-22743']);
  assert.ok(effective.events.every((e) => e.day === '2027-01-01'));

  const pilot = read(await run('calendar', { notice_id: 'FR-2026-15633' }));
  assert.deepEqual(pilot.events.map((e) => [e.day, e.kind]), [
    ['2026-08-03', 'notice published'],
    ['2026-08-24', 'date set by a notice'],
    ['2026-09-24', 'date set by a notice'],
    ['2027-01-01', 'takes effect'],
    ['2028-04-30', 'date set by a notice'],
  ], 'a notice\'s dates are given from the start, not only what is coming');
  assert.equal(pilot.from, undefined);

  const congress = read(await run('calendar', { state: 'US', from: '2025-01-01', limit: 100 }));
  assert.ok(congress.events.every((e) => e.place === 'US' && e.notice_id === undefined), 'Congress and the agencies are kept apart');
});

test('find_notices: by type, role, words, day of publication and open for comment', async () => {
  const all = read(await run('find_notices'));
  assert.equal(all.matched, 5);
  assert.deepEqual(all.notices.map((n) => n.published), [...all.notices.map((n) => n.published)].sort().reverse(), 'newest first');
  assert.ok(all.notices.every((n) => n.official_page.startsWith('https://www.federalregister.gov/') && n.clinx_page === `https://clinx.org/notices/#${n.notice_id}` && n.agency && n.citation));
  assert.equal(all.retrieved, '2026-11-15');
  assert.match(all.note, /Federal Register governs/);

  const open = read(await run('find_notices', { open_for_comment: true }));
  assert.deepEqual(open.notices.map((n) => [n.notice_id, n.comments_close, n.open_for_comment]), [['fr-2026-19535', '2026-11-23', true]]);
  const closed = read(await run('find_notices', { open_for_comment: false }));
  assert.equal(closed.matched, 4);
  assert.ok(closed.notices.every((n) => n.open_for_comment === undefined));

  const rules = read(await run('find_notices', { type: 'Rule' }));
  assert.deepEqual(rules.notices.map((n) => n.notice_id), ['fr-2026-22792', 'fr-2026-22743']);
  const main = read(await run('find_notices', { role: 'main' }));
  assert.deepEqual(main.notices.map((n) => n.notice_id), ['fr-2026-15633', 'fr-2025-14619']);

  const byWords = read(await run('find_notices', { text: 'rebate pilot' }));
  assert.ok(byWords.notices.some((n) => n.notice_id === 'fr-2026-15633'));
  const byCitation = read(await run('find_notices', { text: '91 FR 60568' }));
  assert.deepEqual(byCitation.notices.map((n) => n.notice_id), ['fr-2026-19535']);

  const in2025 = read(await run('find_notices', { to: '2025-12-31' }));
  assert.deepEqual(in2025.notices.map((n) => n.notice_id), ['fr-2025-14619']);
  const none = read(await run('find_notices', { text: 'zzzznotthere' }));
  assert.equal(none.matched, 0);
});

test('get_notice: the whole row, the agency that wrote it and its dated days', async () => {
  const result = await run('get_notice', { notice_id: 'FR-2026-15633' });
  const out = read(result);
  assert.equal(result.isError, false);
  assert.equal(out.notice.notice_id, 'fr-2026-15633');
  assert.equal(out.notice.type, 'Notice');
  assert.equal(out.notice.agency, out.notice.agencies[out.notice.agencies.length - 1]);
  assert.equal(out.notice.effective, '2027-01-01');
  assert.equal(out.notice.open_for_comment, false);
  assert.equal(out.notice.dates_read.length, 3);
  assert.ok(out.notice.dates_read.every((d) => d.day && d.what && d.words));
  assert.ok(out.notice.summary && out.notice.notice_url.startsWith('https://') && out.notice.pdf_url.startsWith('https://'));
  assert.equal(out.notice.clinx_page, 'https://clinx.org/notices/#fr-2026-15633');
  assert.equal(out.notice.explained_at, 'https://clinx.org/rebate-pilot/');
  assert.equal(out.notice.not_yet_read, undefined);
  assert.equal(out.dated_days.length, 5);
  assert.ok(out.dated_days.every((e) => e.notice_id === 'fr-2026-15633'));
  assert.deepEqual(Object.keys(result), ['content', 'isError'], 'the answer is sent once, as text, and not a second time as structured content');
  assert.deepEqual(result.content.map((block) => block.type), ['text']);

  const byCitation = read(await run('get_notice', { notice_id: '91 fr 60568' }));
  assert.equal(byCitation.notice.notice_id, 'fr-2026-19535');
  assert.equal(byCitation.notice.open_for_comment, true);
  assert.equal(byCitation.notice.explained_at, undefined);
  const byNumber = read(await run('get_notice', { notice_id: '2025-14619' }));
  assert.equal(byNumber.notice.notice_id, 'fr-2025-14619');
});

test('get_notice: a document nobody has read yet says so and gives no summary', async () => {
  const { readFile } = await import('node:fs/promises');
  const fetcher = async (url) => {
    const name = String(url).split('/').pop();
    const file = JSON.parse(await readFile(`${DATA}/${name}`, 'utf8'));
    if (name === '340b-notices.json') file.notices = file.notices.map((n) => (n.notice_id === 'fr-2026-22792' ? { ...n, role: '', summary: '' } : n));
    return { ok: true, status: 200, json: async () => file };
  };
  const unread = makeTables({ source: 'https://clinx.org/data/', fetcher, now: () => Date.parse(`${TODAY}T12:00:00Z`) });
  const call = async (name, args) => read((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, unread)).result);
  const one = await call('get_notice', { notice_id: 'fr-2026-22792' });
  assert.match(one.notice.not_yet_read, /no summary/);
  assert.equal(one.notice.summary, '');
  const listed = (await call('find_notices', { type: 'Rule' })).notices.find((n) => n.notice_id === 'fr-2026-22792');
  assert.equal(listed.summary, undefined);
  assert.equal(listed.role, undefined);
  assert.ok(listed.title && listed.official_page);
  assert.equal((await call('state_overview', { state: 'FED' })).notices.by_role['not yet read'], 1);
});

test('state_overview: federal agencies at a glance', async () => {
  const fed = read(await run('state_overview', { state: 'FED' }));
  assert.equal(fed.place, 'FED');
  assert.equal(fed.notices.count, 5);
  assert.deepEqual(fed.notices.by_role, { mention: 1, part: 2, main: 2 });
  assert.deepEqual(fed.notices.by_type, { Rule: 2, 'Proposed Rule': 1, Notice: 2 });
  assert.deepEqual(fed.notices.open_for_comment.map((n) => n.notice_id), ['fr-2026-19535']);
  assert.equal(fed.coming_up.length, 5);
  assert.equal(fed.coming_up[0].day, '2026-11-23');
  assert.deepEqual(fed.pages, { notices: 'https://clinx.org/notices/', calendar: 'https://clinx.org/calendar/agencies/', rebate_pilot: 'https://clinx.org/rebate-pilot/' });
  assert.equal(fed.laws, undefined);
  assert.equal(fed.bills, undefined);
});

test('state_overview: laws, bills and what is next, with pages that exist', async () => {
  const il = read(await run('state_overview', { state: 'il' }));
  assert.equal(il.laws.count, 3);
  assert.equal(il.bills.count, 6);
  assert.equal(il.bills.by_stage['Became law'], 2);
  assert.deepEqual(il.pages, { laws: 'https://clinx.org/laws/il/', bills: 'https://clinx.org/bills/il/', calendar: 'https://clinx.org/calendar/il/' });

  const us = read(await run('state_overview', { state: 'US' }));
  assert.equal(us.pages.laws, undefined);
  assert.equal(us.pages.bills, 'https://clinx.org/bills/congress/');
  assert.equal(us.pages.federal_notices, 'https://clinx.org/notices/', 'Congress points on to the agencies');
  assert.equal(il.pages.federal_notices, undefined);

  const empty = read(await run('state_overview', { state: 'WY' }));
  assert.equal(empty.laws.count, 0);
  assert.deepEqual(Object.keys(empty.pages), ['calendar']);
});

test('about_the_data: counts, dates, licence and where to download', async () => {
  const about = read(await run('about_the_data'));
  assert.deepEqual(about.counts, { laws: 5, bills: 14, notices: 5, calendar_dates: 84 });
  assert.equal(about.up_to_date_as_of.notices, '2026-11-15');
  assert.equal(about.today, TODAY);
  assert.deepEqual(about.notice_types, ['Rule', 'Proposed Rule', 'Notice', 'Presidential Document']);
  assert.ok(about.calendar_kinds['comments close']);
  assert.match(about.sources, /Federal Register/);
  assert.match(about.licence, /CC.BY/);
  assert.equal(about.downloads, 'https://clinx.org/data/');
});

test('a mistake in what was asked is said back plainly, as the tool\'s answer', async () => {
  const cases = [
    ['find_bills', { state: 'Rhode Island' }, /two-letter/],
    ['find_bills', { state: 'ZZ' }, /two-letter/],
    ['find_bills', { stage: 'Dead' }, /stage must be one of/],
    ['find_bills', { limit: 1000 }, /limit/],
    ['find_bills', { colour: 'red' }, /does not take colour/],
    ['get_bill', {}, /bill_id is required/],
    ['get_bill', { bill_id: 'ri-1999-nothing' }, /no bill with the id/],
    ['get_law', { law_id: 'xx' }, /no law with the id/],
    ['calendar', { from: 'next week' }, /year-month-day/],
    ['calendar', { from: '2027-02-01', to: '2027-01-01' }, /must not be after/],
    ['state_overview', {}, /state is required/],
    ['find_bills', { state: 'FED' }, /find_notices/],
    ['find_laws', { state: 'fed' }, /find_notices/],
    ['calendar', { state: 'ZZ' }, /FED for federal agencies/],
    ['find_notices', { type: 'Final rule' }, /type must be one of/],
    ['find_notices', { open_for_comment: 'yes' }, /true or false/],
    ['find_notices', { from: '2026-12-01', to: '2026-01-01' }, /must not be after/],
    ['find_notices', { state: 'FED' }, /does not take state/],
    ['get_notice', {}, /notice_id is required/],
    ['get_notice', { notice_id: 'fr-1999-00001' }, /no rule or notice with the id/],
    ['about_the_data', { x: 1 }, /does not take x/],
  ];
  for (const [name, args, saying] of cases) {
    const result = await run(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, saying);
    assert.equal(result.structuredContent, undefined);
  }
});

test('a date that cannot exist is refused in words by every tool that takes a date', async () => {
  // Every input whose description says it is a date, so a tool added later is held to the same rule.
  const dated = TOOLS.flatMap((tool) => Object.entries(tool.inputSchema.properties ?? {}).filter(([, input]) => /year-month-day/.test(input.description ?? '')).map(([name]) => [tool.name, name]));
  assert.deepEqual(dated, [['find_notices', 'from'], ['find_notices', 'to'], ['calendar', 'from'], ['calendar', 'to'], ['find_funding_opportunities', 'open_on'], ['health_center_calendar', 'from'], ['health_center_calendar', 'to']]);
  for (const [tool, input] of dated) {
    for (const day of ['2026-13-45', '2026-02-30', '2025-02-29', '2026-04-31', '2026-00-10', '2026-11-00', '2026-12-32']) {
      const result = await run(tool, { [input]: day });
      assert.equal(result.isError, true, `${tool} ${input} ${day}`);
      assert.equal(result.content[0].text, `${input} must be a day that exists: there is no ${day} on the calendar. Write a date year-month-day, such as 2027-01-15`);
      assert.equal(result.structuredContent, undefined);
    }
    // A day that exists is taken as before, the 29th of February in a leap year among them.
    for (const day of ['2024-02-29', '2026-12-31', '2027-01-01']) assert.equal((await run(tool, { [input]: day })).isError, false, `${tool} ${input} ${day}`);
  }
  // A date in the wrong shape keeps its own sentence.
  assert.equal((await run('calendar', { from: '2026-1-5' })).content[0].text, 'from must be a date written year-month-day, such as 2027-01-15');
  assert.equal((await run('find_funding_opportunities', { open_on: 20270115 })).content[0].text, 'open_on must be a date written year-month-day, such as 2027-01-15');
});

test('calendar: a bill_id or notice_id that is not text is refused in words, not passed over', async () => {
  const everything = read(await run('calendar', { from: '2000-01-01', limit: 100 })).matched;
  for (const [name, finder] of [['bill_id', 'find_bills'], ['notice_id', 'find_notices']]) {
    for (const value of [123, -1, 1.5, true, false, [], ['il-104th-hb2371'], {}, null]) {
      const result = await run('calendar', { [name]: value, from: '2000-01-01' });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(value)}`);
      assert.match(result.content[0].text, new RegExp(`^${name} must be text, such as \\S+; ${finder} returns it$`));
      assert.equal(result.structuredContent, undefined, 'the whole calendar is not given instead');
    }
    // Left empty it is the same as not given.
    assert.equal(read(await run('calendar', { [name]: '', from: '2000-01-01', limit: 100 })).matched, everything);
  }
  // Text is taken as before, in any case and with spaces around it.
  const oneBill = read(await run('calendar', { bill_id: ' IL-104th-HB2371 ', limit: 100 }));
  assert.ok(oneBill.matched > 0 && oneBill.matched < everything && oneBill.events.every((e) => e.bill_id === 'il-104th-hb2371'));
  const oneNotice = read(await run('calendar', { notice_id: 'FR-2026-15633' }));
  assert.ok(oneNotice.matched > 0 && oneNotice.events.every((e) => e.notice_id === 'fr-2026-15633'));
});

test('a wrong value is said back cut to 80 characters with an ellipsis, so a refusal stays a sentence', async () => {
  const long = 'x'.repeat(5000);
  const cut = `${'x'.repeat(80)}…`;
  assert.equal(echo(long), cut);
  assert.equal(echo('y'.repeat(80)), 'y'.repeat(80), 'exactly 80 characters are said back whole');
  assert.equal(echo('y'.repeat(81)), `${'y'.repeat(80)}…`);
  assert.equal(echo('ri-2025-h5634'), 'ri-2025-h5634');
  assert.equal(echo(12), '12');
  assert.equal(echo('é'.repeat(81)), `${'é'.repeat(80)}…`);
  assert.equal(echo('\u{1F600}'.repeat(81)), `${'\u{1F600}'.repeat(80)}…`, 'a character is never cut in half');

  const cases = [
    ['get_bill', { bill_id: long }, `no bill with the id ${cut}; use find_bills to look one up`],
    ['get_law', { law_id: long }, `no law with the id ${cut}; use find_laws to look one up`],
    ['get_notice', { notice_id: long }, `no rule or notice with the id ${cut}; use find_notices to look one up`],
    ['get_filing', { filing_id: long }, `no filed report with the id ${cut}; use find_filings to look one up`],
    ['get_filing', { filing_id: 'id-2025-statewide', schedule: long }, `this report has no lines in the schedule ${cut}; its schedules are: `],
    ['get_health_center_report', { health_center: long }, `no health center with the key or grant number ${cut}; use find_health_centers to look one up`],
    ['get_health_center_report', { health_center: '010120', table: long }, `report has no table ${cut}; its tables are: `],
    ['get_health_center_report', { health_center: '010120', table: 'Table 3A', line: long }, `Table 3A has no line ${cut}; its lines are: `],
    ['find_funding_opportunities', { opportunity: long }, `no funding opportunity with the number or id ${cut}; use find_funding_opportunities without it to look one up`],
    ['find_bills', { [long]: 1 }, `find_bills does not take ${cut}. It takes: state, text, stage, role, kind, limit.`],
  ];
  for (const [name, args, saying] of cases) {
    const result = await run(name, args);
    assert.equal(result.isError, true, `${name} ${Object.keys(args).join(' ')}`);
    assert.ok(result.content[0].text.includes(saying), `${name}: ${result.content[0].text.slice(0, 200)}`);
    assert.ok(!result.content[0].text.includes('x'.repeat(81)), `${name} repeats no more than 80 characters of it`);
  }
  // A wrong id of 80 characters or fewer is said back whole, as before.
  assert.equal((await run('get_bill', { bill_id: 'y'.repeat(80) })).content[0].text, `no bill with the id ${'y'.repeat(80)}; use find_bills to look one up`);
  assert.equal((await run('get_bill', { bill_id: 'RI-1999-Nothing' })).content[0].text, 'no bill with the id RI-1999-Nothing; use find_bills to look one up');
  // The same in a note on an answer, and in the protocol's own error for a tool that does not exist.
  const none = read(await run('find_filings', { form: long }));
  assert.equal(none.matched, 0);
  assert.ok(none.note.startsWith(`No report has a form of ${cut}. The form values held are: `));
  const unknown = await ask('tools/call', { name: long });
  assert.equal(unknown.error.code, CODE.params);
  assert.equal(unknown.error.message, `Unknown tool: ${cut}`);
  assert.equal((await ask('tools/call', { name: 'no_such_tool' })).error.message, 'Unknown tool: no_such_tool');
});

test('every tool sends its answer once, as text, and no whole reply passes the size one answer may have', async () => {
  // One call of each tool, at the largest settings it takes.
  const calls = {
    find_bills: { limit: 100 },
    get_bill: { bill_id: 'ri-2025-hb5634' },
    find_laws: { limit: 100 },
    get_law: { law_id: 'ri-2025-s114' },
    find_notices: { limit: 100 },
    get_notice: { notice_id: 'fr-2026-19535' },
    calendar: { from: '2000-01-01', limit: 100 },
    reporting_states: {},
    find_filings: { limit: 100 },
    get_filing: { filing_id: 'ri-2025-rhode-island-hospital', limit: 150 },
    state_overview: { state: 'RI' },
    find_health_centers: { limit: 100 },
    get_health_center_report: { health_center: '010120', table: '3A', limit: 200 },
    find_funding_opportunities: { limit: 100 },
    health_center_calendar: { from: '2000-01-01', limit: 100 },
    shortage_area_changes: { state: 'RI', show: 'recent', limit: 100 },
    about_the_data: {},
  };
  assert.deepEqual(Object.keys(calls).sort(), TOOLS.map((t) => t.name).sort(), 'every tool is called here');
  for (const tool of TOOLS) assert.equal(tool.outputSchema, undefined, `${tool.name} promises no second copy of its answer`);
  for (const [name, args] of Object.entries(calls)) {
    for (const reply of [await ask('tools/call', { name, arguments: args }), await modern('tools/call', { name, arguments: args })]) {
      const { result } = reply;
      assert.equal(result.isError, false, `${name}: ${result.content[0].text}`);
      assert.equal(result.structuredContent, undefined, name);
      assert.equal(result.content.length, 1, name);
      assert.equal(result.content[0].type, 'text', name);
      const answerRead = read(result);
      assert.ok(answerRead !== null && typeof answerRead === 'object' && !Array.isArray(answerRead), name);
      assert.ok(sizeOf(answerRead) <= ANSWER_MOST, `${name}: the answer is ${sizeOf(answerRead)} characters`);
      // The wrapping around the answer: about 90 characters, and about 650 more in the newer protocol.
      const whole = JSON.stringify(reply).length;
      assert.ok(whole <= ANSWER_MOST + 1000, `${name}: the whole reply is ${whole} characters`);
    }
  }
  const legacy = (await ask('tools/call', { name: 'get_bill', arguments: calls.get_bill })).result;
  assert.deepEqual(Object.keys(legacy), ['content', 'isError']);
});

test('the size of one answer: whole rows only, as many as fit, and the first row always', () => {
  const write = (rows) => ({ shown: rows.length, rows });
  const short = Array.from({ length: 100 }, (_, i) => ({ n: i, words: 'a few words' }));
  assert.equal(fitRows(short, write).rows.length, 100, 'rows that fit are all kept');
  assert.equal(fitRows([], write).shown, 0);

  // The size is counted as the answer sits inside its reply: the answer is written as JSON, and
  // that text is then a value in the reply, where each quotation mark and backslash takes one
  // character more. So the two marks around a word take two characters each, and a mark inside it four.
  assert.equal(sizeOf('hello'), 5 + 2 * 2);
  assert.equal(sizeOf('say "hello"'), 9 + 2 * 2 + 2 * 4);
  const sample = { a: 'x', b: ['say "hello"'] };
  const inReply = JSON.stringify({ text: JSON.stringify(sample) });
  assert.equal(sizeOf(sample), inReply.length - '{"text":""}'.length);

  const long = Array.from({ length: 100 }, (_, i) => ({ n: i, words: `"${'word '.repeat(400)}"` }));
  const cut = fitRows(long, write);
  assert.ok(cut.rows.length > 1 && cut.rows.length < 100);
  assert.equal(cut.shown, cut.rows.length, 'the answer is written from the rows that are kept');
  assert.deepEqual(cut.rows, long.slice(0, cut.rows.length), 'the rows kept are the first ones, each whole');
  assert.ok(sizeOf(cut) <= ANSWER_MOST);
  assert.ok(sizeOf(write(long.slice(0, cut.rows.length + 1))) > ANSWER_MOST, 'one row more would not fit');

  const huge = [{ words: 'word '.repeat(20000) }, { words: 'next' }];
  assert.deepEqual(fitRows(huge, write).rows, [huge[0]], 'a row is never cut, so the first is given whole even alone');

  assert.equal(leftOutForSize(short, short, 250, 'state or text'), '', 'nothing is said when every row asked for is there');
  assert.equal(leftOutForSize(cut.rows, long, 250, 'state or text'), `Showing ${cut.rows.length} of 250, as many whole rows as fit in one answer: narrow it with state or text to see the rest.`);
});

test('find_bills: where the rows are long, the list holds as many whole rows as fit and says how many of how many', async () => {
  const { readFile } = await import('node:fs/promises');
  const LONG = ` A "longer" summary. ${'More words about the bill. '.repeat(400)}`;
  const fetcher = async (url) => {
    const name = String(url).split('/').pop();
    try {
      const file = JSON.parse(await readFile(`${DATA}/${name}`, 'utf8'));
      if (name === '340b-bills.json') file.bills = file.bills.map((b) => ({ ...b, summary: `${b.summary ?? ''}${LONG}` }));
      return { ok: true, status: 200, json: async () => file };
    } catch {
      return { ok: false, status: 404 };
    }
  };
  const long = makeTables({ source: 'https://clinx.org/data/', fetcher, now: () => Date.parse(`${TODAY}T12:00:00Z`) });
  const call = async (args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_bills', arguments: args } }, long);
  const plain = read(await run('find_bills', { limit: 100 }));
  assert.equal(plain.bills.length, 14);
  assert.doesNotMatch(plain.note, /whole rows/);

  const reply = await call({ limit: 100 });
  const cut = read(reply.result);
  const kept = cut.bills.length;
  assert.ok(kept > 1 && kept < 14, `${kept} rows`);
  assert.equal(cut.matched, 14, 'how many matched is not changed');
  assert.ok(cut.note.startsWith(`Showing ${kept} of 14, as many whole rows as fit in one answer: narrow it with state, stage, role, kind or text to see the rest. `), cut.note);
  assert.ok(cut.note.endsWith(plain.note), 'the usual note follows');
  for (const [i, row] of cut.bills.entries()) {
    assert.ok(row.summary.endsWith(LONG), `row ${i} is whole`);
    assert.deepEqual({ ...row, summary: plain.bills[i].summary }, plain.bills[i]);
  }
  assert.ok(sizeOf(cut) <= ANSWER_MOST);
  assert.ok(JSON.stringify(reply).length <= ANSWER_MOST + 500);
  const one = read((await call({ state: 'RI' })).result);
  assert.equal(one.bills.length, one.matched, 'narrowed, every row is there');
  assert.doesNotMatch(one.note, /whole rows/);
});

test('the version is the same wherever it is stated', async () => {
  const { readFile } = await import('node:fs/promises');
  const stated = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(stated, '0.3.3');
  assert.equal(SERVER.version, stated);
  assert.equal((await ask('initialize', { protocolVersion: LEGACY[0], capabilities: {}, clientInfo: { name: 't', version: '0' } })).result.serverInfo.version, stated);
});

test('when the tables cannot be reached, the tool says so instead of failing', async () => {
  const broken = makeTables({ source: 'https://example.invalid/', fetcher: async () => { throw new Error('offline'); } });
  const reply = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'about_the_data' } }, broken);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /could not be reached/);
});

test('the tables are fetched once an hour, and a failed refetch keeps the copy already held', async () => {
  const { readFile } = await import('node:fs/promises');
  let calls = 0;
  let down = false;
  let clock = 0;
  const fetcher = async (url) => {
    calls += 1;
    if (down) return { ok: false, status: 503 };
    const text = await readFile(`${DATA}/${String(url).split('/').pop()}`, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const held = makeTables({ source: 'https://clinx.org/data/', fetcher, now: () => clock });
  assert.equal((await held()).bills.length, 14);
  await held();
  assert.equal(calls, 7, 'six files and the index that is not there (the whole file is read instead), fetched once');
  clock = 2 * 60 * 60 * 1000;
  down = true;
  assert.equal((await held()).bills.length, 14, 'the held copy is still served');
  assert.equal(calls, 14);
});
