// A check against the real, published tables at clinx.org/data. It needs the network, so it
// runs only when asked for:
//
//   npm run test:live

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/core.js';
import { makeTables } from '../src/tables.js';

const live = process.env.CLINX_LIVE === '1';
const tables = makeTables();
const run = async (name, args = {}) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tables)).result;

test('the published tables answer every tool', { skip: !live && 'set CLINX_LIVE=1 to run' }, async () => {
  const about = (await run('about_the_data')).structuredContent;
  assert.ok(about.counts.laws > 50 && about.counts.bills > 200 && about.counts.notices > 30 && about.counts.calendar_dates > 1000, JSON.stringify(about.counts));

  const bills = (await run('find_bills', { state: 'US', role: 'main', limit: 100 })).structuredContent;
  assert.ok(bills.matched > 5);
  const one = (await run('get_bill', { bill_id: bills.bills[0].bill_id })).structuredContent;
  assert.equal(one.bill.jurisdiction, 'US');

  const laws = (await run('find_laws', { kind: 'contract-pharmacy', limit: 100 })).structuredContent;
  assert.ok(laws.matched > 10);
  const law = (await run('get_law', { law_id: laws.laws[0].law_id })).structuredContent;
  assert.ok(law.law.source_url.startsWith('http'));

  const coming = (await run('calendar', { limit: 100 })).structuredContent;
  assert.ok(coming.events.every((e) => e.day >= coming.from));

  const notices = (await run('find_notices', { role: 'main', limit: 100 })).structuredContent;
  assert.ok(notices.matched > 5);
  const pilot = (await run('get_notice', { notice_id: 'fr-2026-15633' })).structuredContent;
  assert.equal(pilot.notice.effective, '2027-01-01');
  assert.ok(pilot.dated_days.length >= 3);
  const federal = (await run('calendar', { state: 'FED', from: '2025-01-01', limit: 100 })).structuredContent;
  assert.ok(federal.matched > 30 && federal.events.every((e) => e.place === 'FED' && e.notice_id));

  for (const state of ['RI', 'TX', 'US', 'WY', 'FED']) {
    const overview = await run('state_overview', { state });
    assert.equal(overview.isError, false, state);
  }
});
