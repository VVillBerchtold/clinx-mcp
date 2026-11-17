// A check against the real, published tables at clinx.org/data. It needs the network, so it
// runs only when asked for:
//
//   npm run test:live

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/core.js';
import { makeTables, FILES } from '../src/tables.js';

const live = process.env.CLINX_LIVE === '1';
const tables = makeTables();
const run = async (name, args = {}) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tables)).result;
/** A tool's answer as an object. The reply carries it once, as JSON in one block of text. */
const read = (result) => JSON.parse(result.content[0].text);

test('the published tables answer every tool', { skip: !live && 'set CLINX_LIVE=1 to run' }, async () => {
  const about = read(await run('about_the_data'));
  assert.ok(about.counts.laws > 50 && about.counts.bills > 200 && about.counts.notices > 30 && about.counts.calendar_dates > 1000, JSON.stringify(about.counts));

  const bills = read(await run('find_bills', { state: 'US', role: 'main', limit: 100 }));
  assert.ok(bills.matched > 5);
  const one = read(await run('get_bill', { bill_id: bills.bills[0].bill_id }));
  assert.equal(one.bill.jurisdiction, 'US');

  const laws = read(await run('find_laws', { kind: 'contract-pharmacy', limit: 100 }));
  assert.ok(laws.matched > 10);
  const law = read(await run('get_law', { law_id: laws.laws[0].law_id }));
  assert.ok(law.law.source_url.startsWith('http'));

  const coming = read(await run('calendar', { limit: 100 }));
  assert.ok(coming.events.every((e) => e.day >= coming.from));

  const notices = read(await run('find_notices', { role: 'main', limit: 100 }));
  assert.ok(notices.matched > 5);
  const pilot = read(await run('get_notice', { notice_id: 'fr-2026-15633' }));
  assert.equal(pilot.notice.effective, '2027-01-01');
  assert.ok(pilot.dated_days.length >= 3);
  const federal = read(await run('calendar', { state: 'FED', from: '2025-01-01', limit: 100 }));
  assert.ok(federal.matched > 30 && federal.events.every((e) => e.place === 'FED' && e.notice_id));

  for (const state of ['RI', 'TX', 'US', 'WY', 'FED']) {
    const overview = await run('state_overview', { state });
    assert.equal(overview.isError, false, state);
  }
});

// The two newest files reach clinx.org only when the site is next published. Until then this test
// says so and skips, rather than failing the check of everything else.
test('the published filed reports and reporting states answer the newer tools', { skip: !live && 'set CLINX_LIVE=1 to run' }, async (t) => {
  const held = await tables();
  if (!held.filings || !held.reporting) {
    t.skip(`clinx.org does not publish ${[held.filings ? '' : FILES.filings, held.reporting ? '' : FILES.reporting].filter(Boolean).join(' and ')} yet; run this again after the site is published with them`);
    return;
  }
  const states = read(await run('reporting_states'));
  assert.ok(states.matched >= 11 && states.groups.length >= 4);
  const filings = read(await run('find_filings', { state: 'RI', limit: 100 }));
  assert.ok(filings.matched >= 14);
  const one = read(await run('get_filing', { filing_id: filings.filings[0].filing_id }));
  assert.match(one.official_file.sha256, /^[0-9a-f]{64}$/);
  assert.ok(one.lines_total > 0);
});

test('the published health center files answer every health center tool', { skip: !live && 'set CLINX_LIVE=1 to run' }, async () => {
  const about = read(await run('about_the_data'));
  assert.ok(about.health_centers.records.health_centers > 10 && /^\d{4}-\d{2}-\d{2}$/.test(about.health_centers.funding.read_on), JSON.stringify(about.health_centers).slice(0, 300));

  const centers = read(await run('find_health_centers', { limit: 100 }));
  assert.ok(centers.matched > 10 && centers.health_centers.every((c) => c.clinx_page.startsWith('https://clinx.org/health-centers/records/')));
  const one = centers.health_centers[0];
  const report = read(await run('get_health_center_report', { health_center: one.key }));
  assert.ok(report.tables.length >= 10 && report.tables.some((t) => t.table === 'Table 3A'));
  const table = read(await run('get_health_center_report', { health_center: one.key, table: 'Table 3A' }));
  assert.ok(table.lines.length > 10 && table.lines.every((l) => Array.isArray(l.cells)));

  const funding = read(await run('find_funding_opportunities', { limit: 100 }));
  assert.ok(funding.matched > 5 && funding.opportunities.every((o) => o.grants_gov_page.startsWith('https://www.grants.gov/')));
  const dates = read(await run('health_center_calendar', { from: '2026-01-01', limit: 100 }));
  assert.ok(dates.matched > 20 && dates.dates.every((d) => d.official_page.startsWith('https://')));

  const nation = read(await run('shortage_area_changes'));
  assert.ok(nation.states_and_territories.length >= 50 && nation.national_counts.designations);
  const state = read(await run('shortage_area_changes', { state: 'RI' }));
  assert.ok(state.counts.designations['hpsa-pc']);
  const rows = read(await run('shortage_area_changes', { state: 'RI', show: 'recent' }));
  assert.ok(rows.designations.every((r) => r.state === 'RI'));
});
