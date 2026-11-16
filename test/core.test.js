// The server's answers, checked message by message against small real slices of the tables
// (test/data). No network is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { handle, answer, SERVER, MODERN, LEGACY, CODE } from '../src/core.js';
import { makeTables } from '../src/tables.js';
import { localTables } from '../src/disk.js';
import { TOOLS } from '../src/tools.js';

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

test('find_bills: by state, role, stage, kind and words', async () => {
  const ri = (await run('find_bills', { state: 'ri' })).structuredContent;
  assert.equal(ri.matched, 3);
  assert.ok(ri.bills.every((b) => b.place === 'RI' && b.official_page.startsWith('http') && b.clinx_page === 'https://clinx.org/bills/ri/'));
  assert.match(ri.retrieved, /^\d{4}-\d{2}-\d{2}$/);

  const law = (await run('find_bills', { state: 'RI', stage: 'Became law' })).structuredContent;
  assert.deepEqual(law.bills.map((b) => b.bill_id).sort(), ['ri-2025-hb5634', 'ri-2025-sb114']);

  const congress = (await run('find_bills', { state: 'US', role: 'main' })).structuredContent;
  assert.equal(congress.matched, 4);
  assert.ok(congress.bills.every((b) => b.clinx_page === 'https://clinx.org/bills/congress/'));

  const mention = (await run('find_bills', { role: 'mention' })).structuredContent;
  assert.deepEqual(mention.bills.map((b) => b.bill_id), ['il-104th-hb3794']);

  const byNumber = (await run('find_bills', { text: 'hb2371' })).structuredContent;
  assert.ok(byNumber.bills.some((b) => b.bill_id === 'il-104th-hb2371'));

  const limited = (await run('find_bills', { limit: 2 })).structuredContent;
  assert.equal(limited.bills.length, 2);
  assert.equal(limited.matched, 14);
  const dates = limited.bills.map((b) => b.latest_step_date);
  assert.ok(dates[0] >= dates[1], 'newest activity first');

  const none = (await run('find_bills', { text: 'zzzznotthere' })).structuredContent;
  assert.equal(none.matched, 0);
});

test('find_bills: a stage that names a chamber is found under the looser stage', async () => {
  const all = (await run('find_bills', { limit: 100 })).structuredContent.bills;
  const reported = (await run('find_bills', { stage: 'Reported by committee' })).structuredContent;
  assert.equal(reported.matched, all.filter((b) => b.stage === 'Reported by committee').length);
});

test('get_bill: the whole row and its dated steps', async () => {
  const { structuredContent: out, content, isError } = await run('get_bill', { bill_id: 'RI-2025-HB5634' });
  assert.equal(isError, false);
  assert.equal(out.bill.bill_id, 'ri-2025-hb5634');
  assert.equal(out.bill.stage, 'Became law');
  assert.ok(out.bill.bill_url.startsWith('http'));
  assert.ok(out.dated_steps.length > 2);
  assert.ok(out.dated_steps.every((e) => e.bill_id === 'ri-2025-hb5634'));
  assert.deepEqual(JSON.parse(content[0].text), out, 'the text block carries the same answer');
});

test('find_laws and get_law', async () => {
  const il = (await run('find_laws', { state: 'IL' })).structuredContent;
  assert.equal(il.matched, 3);
  assert.equal(il.dataset_version, '0.6.0');
  assert.ok(il.laws.every((l) => l.clinx_page === 'https://clinx.org/laws/il/' && l.official_page.startsWith('http')));

  const contract = (await run('find_laws', { kind: 'contract-pharmacy' })).structuredContent;
  assert.deepEqual(contract.laws.map((l) => l.law_id).sort(), ['ar-2021-hb1881', 'il-2026-hb2371', 'ri-2025-s114']);

  const one = (await run('get_law', { law_id: 'ri-2025-s114' })).structuredContent;
  assert.equal(one.law.state, 'RI');
  assert.ok(one.law.citation && one.law.summary && one.law.source_url);
  assert.equal(one.law.source_sha256, undefined, 'bookkeeping fields are left out');
});

test('calendar: what is coming up by default, a past stretch when asked', async () => {
  const coming = (await run('calendar')).structuredContent;
  assert.ok(coming.matched >= 2);
  assert.equal(coming.from, TODAY, 'what is coming up starts today');
  assert.ok(coming.events.every((e) => e.day >= TODAY));
  const days = coming.events.map((e) => e.day);
  assert.deepEqual(days, [...days].sort());

  const past = (await run('calendar', { state: 'RI', from: '2025-01-01', to: '2025-12-31', kind: 'signed' })).structuredContent;
  assert.equal(past.matched, 2);
  assert.ok(past.events.every((e) => e.place === 'RI' && e.kind === 'signed' && e.day === '2025-06-27' && e.official_page.startsWith('http')));

  const oneBill = (await run('calendar', { bill_id: 'il-104th-hb2371', limit: 100 })).structuredContent;
  assert.ok(oneBill.matched > 3, 'a bill\'s dates are given from the start, not only what is coming');
});

test('calendar: coming up goes by today, not by the day the tables were last brought up to date', async () => {
  const later = localTables({ folder: DATA, now: () => Date.parse('2026-12-01T09:00:00Z') });
  const { structuredContent: out } = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'calendar', arguments: { state: 'FED' } } }, later)).result;
  assert.equal(out.from, '2026-12-01');
  assert.equal(out.retrieved, '2026-11-15');
  assert.deepEqual(out.events.map((e) => e.day), ['2027-01-01', '2027-01-01', '2027-09-30', '2028-04-30'], 'the comment deadline of 23 November has passed');
});

test('calendar: federal agencies are a place of their own, with their own kinds of date', async () => {
  const fed = (await run('calendar', { state: 'fed' })).structuredContent;
  assert.equal(fed.matched, 5);
  assert.ok(fed.events.every((e) => e.place === 'FED' && e.notice_id.startsWith('fr-') && e.bill_id === undefined && e.official_page.startsWith('https://www.federalregister.gov/')));
  assert.deepEqual(fed.events[0], { ...fed.events[0], day: '2026-11-23', kind: 'comments close', notice_id: 'fr-2026-19535' });

  const effective = (await run('calendar', { kind: 'takes effect' })).structuredContent;
  assert.deepEqual(effective.events.map((e) => e.notice_id).sort(), ['fr-2026-15633', 'fr-2026-22743']);
  assert.ok(effective.events.every((e) => e.day === '2027-01-01'));

  const pilot = (await run('calendar', { notice_id: 'FR-2026-15633' })).structuredContent;
  assert.deepEqual(pilot.events.map((e) => [e.day, e.kind]), [
    ['2026-08-03', 'notice published'],
    ['2026-08-24', 'date set by a notice'],
    ['2026-09-24', 'date set by a notice'],
    ['2027-01-01', 'takes effect'],
    ['2028-04-30', 'date set by a notice'],
  ], 'a notice\'s dates are given from the start, not only what is coming');
  assert.equal(pilot.from, undefined);

  const congress = (await run('calendar', { state: 'US', from: '2025-01-01', limit: 100 })).structuredContent;
  assert.ok(congress.events.every((e) => e.place === 'US' && e.notice_id === undefined), 'Congress and the agencies are kept apart');
});

test('find_notices: by type, role, words, day of publication and open for comment', async () => {
  const all = (await run('find_notices')).structuredContent;
  assert.equal(all.matched, 5);
  assert.deepEqual(all.notices.map((n) => n.published), [...all.notices.map((n) => n.published)].sort().reverse(), 'newest first');
  assert.ok(all.notices.every((n) => n.official_page.startsWith('https://www.federalregister.gov/') && n.clinx_page === `https://clinx.org/notices/#${n.notice_id}` && n.agency && n.citation));
  assert.equal(all.retrieved, '2026-11-15');
  assert.match(all.note, /Federal Register governs/);

  const open = (await run('find_notices', { open_for_comment: true })).structuredContent;
  assert.deepEqual(open.notices.map((n) => [n.notice_id, n.comments_close, n.open_for_comment]), [['fr-2026-19535', '2026-11-23', true]]);
  const closed = (await run('find_notices', { open_for_comment: false })).structuredContent;
  assert.equal(closed.matched, 4);
  assert.ok(closed.notices.every((n) => n.open_for_comment === undefined));

  const rules = (await run('find_notices', { type: 'Rule' })).structuredContent;
  assert.deepEqual(rules.notices.map((n) => n.notice_id), ['fr-2026-22792', 'fr-2026-22743']);
  const main = (await run('find_notices', { role: 'main' })).structuredContent;
  assert.deepEqual(main.notices.map((n) => n.notice_id), ['fr-2026-15633', 'fr-2025-14619']);

  const byWords = (await run('find_notices', { text: 'rebate pilot' })).structuredContent;
  assert.ok(byWords.notices.some((n) => n.notice_id === 'fr-2026-15633'));
  const byCitation = (await run('find_notices', { text: '91 FR 60568' })).structuredContent;
  assert.deepEqual(byCitation.notices.map((n) => n.notice_id), ['fr-2026-19535']);

  const in2025 = (await run('find_notices', { to: '2025-12-31' })).structuredContent;
  assert.deepEqual(in2025.notices.map((n) => n.notice_id), ['fr-2025-14619']);
  const none = (await run('find_notices', { text: 'zzzznotthere' })).structuredContent;
  assert.equal(none.matched, 0);
});

test('get_notice: the whole row, the agency that wrote it and its dated days', async () => {
  const { structuredContent: out, content, isError } = await run('get_notice', { notice_id: 'FR-2026-15633' });
  assert.equal(isError, false);
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
  assert.deepEqual(JSON.parse(content[0].text), out, 'the text block carries the same answer');

  const byCitation = (await run('get_notice', { notice_id: '91 fr 60568' })).structuredContent;
  assert.equal(byCitation.notice.notice_id, 'fr-2026-19535');
  assert.equal(byCitation.notice.open_for_comment, true);
  assert.equal(byCitation.notice.explained_at, undefined);
  const byNumber = (await run('get_notice', { notice_id: '2025-14619' })).structuredContent;
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
  const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, unread)).result.structuredContent;
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
  const fed = (await run('state_overview', { state: 'FED' })).structuredContent;
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
  const il = (await run('state_overview', { state: 'il' })).structuredContent;
  assert.equal(il.laws.count, 3);
  assert.equal(il.bills.count, 6);
  assert.equal(il.bills.by_stage['Became law'], 2);
  assert.deepEqual(il.pages, { laws: 'https://clinx.org/laws/il/', bills: 'https://clinx.org/bills/il/', calendar: 'https://clinx.org/calendar/il/' });

  const us = (await run('state_overview', { state: 'US' })).structuredContent;
  assert.equal(us.pages.laws, undefined);
  assert.equal(us.pages.bills, 'https://clinx.org/bills/congress/');
  assert.equal(us.pages.federal_notices, 'https://clinx.org/notices/', 'Congress points on to the agencies');
  assert.equal(il.pages.federal_notices, undefined);

  const empty = (await run('state_overview', { state: 'WY' })).structuredContent;
  assert.equal(empty.laws.count, 0);
  assert.deepEqual(Object.keys(empty.pages), ['calendar']);
});

test('about_the_data: counts, dates, licence and where to download', async () => {
  const about = (await run('about_the_data')).structuredContent;
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
