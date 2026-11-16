// The tools about filed reports and the states with a reporting law, checked against the small
// copies in test/data. Some tests change a copy in memory (a form the code has never seen, a file
// that cannot be read, a new bill stage) to show what the server does then. No network is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handle, INSTRUCTIONS } from '../src/core.js';
import { makeTables } from '../src/tables.js';
import { localTables } from '../src/disk.js';
import { TOOLS, FILINGS_UNREAD, REPORTING_UNREAD, FILING_LINES } from '../src/tools.js';

const DATA = fileURLToPath(new URL('./data', import.meta.url));
const TODAY = '2026-11-15';
const now = () => Date.parse(`${TODAY}T12:00:00Z`);

/** Tables read from test/data, each file passed through `change(name, content)` first; `change` may throw to make a file unreadable. */
function changed(change) {
  const fetcher = async (url) => {
    const name = String(url).split('/').pop();
    try {
      const file = change(name, JSON.parse(await readFile(`${DATA}/${name}`, 'utf8')));
      return { ok: true, status: 200, json: async () => file };
    } catch {
      return { ok: false, status: 404 };
    }
  };
  return makeTables({ source: 'https://clinx.org/data/', fetcher, now });
}
const callOn = (tables) => async (name, args = {}) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tables)).result;
const run = callOn(localTables({ folder: DATA, now }));
const out = async (name, args) => (await run(name, args)).structuredContent;

/**
 * Every line of one report, read the way an assistant has to read a long one: the largest part one
 * answer may hold, then the next part at the offset the answer names, until no more is offered.
 * `ask` gives a tool's answer; the first part's other fields are returned with all the lines.
 */
async function wholeReport(ask, filingId, more = {}) {
  const first = await ask('get_filing', { filing_id: filingId, ...more, limit: FILING_LINES.most });
  const lines = [...first.lines];
  for (let part = first; part.more !== undefined;) {
    const next = Number(/ask again with offset (\d+)/.exec(part.more)[1]);
    assert.equal(next, lines.length, 'the offset the answer names is the next line');
    part = await ask('get_filing', { filing_id: filingId, ...more, limit: FILING_LINES.most, offset: next });
    lines.push(...part.lines);
  }
  return { ...first, lines };
}

test('the three new tools are listed, described plainly, and read only', () => {
  const names = TOOLS.map((t) => t.name);
  for (const name of ['reporting_states', 'find_filings', 'get_filing']) assert.ok(names.includes(name), name);
  for (const tool of TOOLS.filter((t) => ['reporting_states', 'find_filings', 'get_filing'].includes(t.name))) {
    assert.equal(tool.annotations.readOnlyHint, true);
    const said = `${tool.title} ${tool.description} ${JSON.stringify(tool.inputSchema)}`;
    assert.doesNotMatch(said, /\b(best|highest|lowest|worst)\b|top |anonymi|de-identified|HIPAA|—|!/i, tool.name);
  }
  assert.match(INSTRUCTIONS, /find_filings/);
  assert.match(INSTRUCTIONS, /ranks no filer/);
});

test('reporting_states: all eleven states in the four groups, with what is public and where it stands', async () => {
  const all = await out('reporting_states');
  assert.equal(all.matched, 11);
  assert.deepEqual(all.groups.map((g) => [g.id, g.states.map((s) => s.state)]), [
    ['own-reports', ['OH', 'RI', 'VT']],
    ['named-in-state-report', ['MN']],
    ['state-totals', ['HI', 'ID', 'IN', 'ME']],
    ['not-posted-yet', ['CO', 'IL', 'WA']],
  ]);
  const ri = all.groups[0].states.find((s) => s.state === 'RI');
  assert.equal(ri.on_clinx, true);
  assert.equal(ri.filings_held, 14);
  assert.match(ri.what_is_public, /report/);
  assert.ok(ri.where_it_stands && ri.sources[0].url.startsWith('https://'));
  const maine = all.groups[2].states.find((s) => s.state === 'ME');
  assert.equal(maine.on_clinx, false);
  assert.equal(maine.scorecard_url, null, 'a state without figures says so with null');
  assert.equal(all.groups[0].states.find((s) => s.state === 'OH').filings_held, 0, 'a state the table lists but the dataset does not yet hold');
  assert.match(all.note, /Not legal advice/);
});

test('reporting_states: by state and by group, and what is not listed', async () => {
  const one = await out('reporting_states', { state: 'mn' });
  assert.equal(one.matched, 1);
  assert.equal(one.groups[0].id, 'named-in-state-report');
  const group = await out('reporting_states', { group: 'not-posted-yet' });
  assert.deepEqual(group.groups.map((g) => g.id), ['not-posted-yet']);
  assert.equal(group.matched, 3);
  const none = await out('reporting_states', { state: 'TX' });
  assert.equal(none.matched, 0);
  assert.match(none.not_listed, /not on ClinX's list/);
  assert.match((await run('reporting_states', { group: 'secret' })).content[0].text, /group must be one of: own-reports/);
  assert.match((await run('reporting_states', { state: 'FED' })).content[0].text, /filed with a state/);
});

test('find_filings: by state, year, entity name, 340B ID, entity type, kind of record and form', async () => {
  const ri = await out('find_filings', { state: 'RI', limit: 100 });
  assert.equal(ri.matched, 14);
  assert.ok(ri.filings.every((f) => f.state === 'RI' && f.year === '2025' && f.form === 'ri-oag-340b' && f.record_kind === 'filing' && f.official_source.startsWith('https://') && f.clinx_page.startsWith('https://clinx.org/scorecard/ri/')));
  const names = ri.filings.map((f) => f.entity);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'A to Z by name, which ranks no one');

  const blackstone = await out('find_filings', { entity: 'blackstone' });
  assert.deepEqual(blackstone.filings.map((f) => f.filing_id), ['ri-2025-blackstone-valley']);
  assert.equal(blackstone.filings[0].clinx_page, 'https://clinx.org/scorecard/ri/blackstone-valley/');
  assert.equal(blackstone.filings[0].form_revision, 'Form RIOAG-340B (Revised January 2026)');
  const byId = await out('find_filings', { entity: 'ch01199a' });
  assert.deepEqual(byId.filings.map((f) => f.filing_id), ['ri-2025-blackstone-valley'], 'a 340B ID inside a list of them is found');

  const mn = await out('find_filings', { state: 'MN', year: 2024, record_kind: 'state_report_row', entity_type: 'hospital', limit: 100 });
  assert.equal(mn.matched, 25, '26 rows were printed by the state; one is not a hospital');
  assert.ok(mn.filings.every((f) => f.entity_type === 'hospital' && f.clinx_page === 'https://clinx.org/scorecard/mn/'), 'a row a state printed is shown on the state\'s page');
  assert.equal((await out('find_filings', { state: 'MN', year: '2025' })).matched, 0);
  const id = await out('find_filings', { state: 'ID' });
  assert.equal(id.matched, 1);
  assert.equal(id.filings[0].record_kind, 'state_report_totals');
  assert.equal(id.filings[0].entity, undefined, 'a state total has no entity name, and none is made up');
  assert.equal((await out('find_filings', { form: 'vt-gmcb-340b-financial' })).matched, 13);
  assert.equal((await out('find_filings', { entity_type: 'health_center', state: 'RI' })).matched, 7);
});

test('find_filings: a list cut short says so, with the count', async () => {
  const cut = await out('find_filings', { limit: 5 });
  assert.equal(cut.matched, 55);
  assert.equal(cut.shown, 5);
  assert.equal(cut.filings.length, 5);
  assert.match(cut.note, /Showing 5 of 55\. The list is cut short/);
  const whole = await out('find_filings', { state: 'ID' });
  assert.doesNotMatch(whole.note, /cut short/);
  assert.match(cut.note, /does not rank|ranks or judges|rank/);
});

test('find_filings: a value the table does not hold gives no rows and says which values it does hold', async () => {
  const none = await out('find_filings', { record_kind: 'surprise' });
  assert.equal(none.matched, 0);
  assert.match(none.note, /No report has a record_kind of surprise\. The record_kind values held are: filing, state_report_row, state_report_totals/);
  assert.match((await out('find_filings', { entity_type: 'clinic' })).note, /entity_type values held are: health_center, hospital, other, state_total/);
});

test('find_filings: mistakes in what was asked are said back plainly', async () => {
  for (const [args, saying] of [[{ state: 'Rhode Island' }, /two-letter/], [{ state: 'US' }, /filed with a state/], [{ year: 'last year' }, /four-digit year/], [{ limit: 500 }, /limit/], [{ entity: 4 }, /words to look for/], [{ colour: 'red' }, /does not take colour/]]) {
    const result = await run('find_filings', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, saying);
  }
});

test('get_filing: one report with every line as filed, the official file and the ClinX page', async () => {
  const { filing, official_file: file, lines, lines_total: total, clinx_page: page, schedules } = await wholeReport(out, 'RI-2025-East-Bay-CAP');
  assert.equal(filing.filing_id, 'ri-2025-east-bay-cap');
  assert.equal(filing.entity.name_as_filed.length > 3, true);
  assert.equal(page, 'https://clinx.org/scorecard/ri/east-bay-cap/');
  assert.deepEqual(Object.keys(file), ['url', 'file_name', 'bytes', 'sha256', 'pages', 'read_on']);
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof file.bytes, 'number');
  assert.equal(lines.length, total);
  assert.equal(Object.values(schedules).reduce((a, b) => a + b, 0), total);
  assert.ok(lines.every((l) => l.schedule && l.line && l.unit && l.page), 'every line has its schedule, number, unit and page');
  assert.ok(lines.some((l) => l.label_as_filed && l.amount_as_filed !== undefined));
  assert.equal(filing.clinx_page, page);
  assert.equal(filing.source_url, undefined, 'the official file is given once, under official_file');
});

test('get_filing: every figure is exactly the file\'s, not changed or rounded', async () => {
  const raw = JSON.parse(await readFile(`${DATA}/340b-state-filings.json`, 'utf8'));
  const id = 'ri-2025-wellone';
  const wanted = raw.line_items.filter((l) => l.filing_id === id);
  const { lines } = await wholeReport(out, id);
  assert.equal(lines.length, wanted.length);
  wanted.forEach((row, i) => {
    for (const key of ['amount', 'amount_as_filed', 'label_as_filed', 'name_as_filed', 'ndc_as_filed', 'unit', 'page', 'schedule', 'line']) {
      assert.equal(lines[i][key], row[key] === '' ? undefined : row[key], `${key} on line ${i}`);
    }
  });
});

test('get_filing: withheld small counts are never given, and the reason is explained', async () => {
  const { lines, withheld, lines_total: total } = await wholeReport(out, 'ri-2025-blackstone-valley', { schedule: 'G' });
  assert.ok(total > 50);
  const small = lines.filter((l) => l.claims_withheld);
  assert.ok(small.length > 0);
  assert.ok(small.every((l) => l.claims === undefined && l.claims_as_filed === undefined && l.amount_as_filed && l.name_as_filed), 'the count goes, the rest of the row stays as filed');
  assert.ok(withheld.rows >= small.length);
  assert.equal(withheld.by_reason.fewer_than_6 >= small.length, true);
  assert.match(withheld.why.fewer_than_6, /1 to 5/);
  assert.match(withheld.rule, /never published/);
  // Nothing in the whole answer for any report shows a one-to-five count in a claims cell.
  const all = JSON.parse(await readFile(`${DATA}/340b-state-filings.json`, 'utf8')).filings.map((f) => f.filing_id);
  for (const id of all) {
    const answer = JSON.stringify(await wholeReport(out, id));
    assert.doesNotMatch(answer, /"claims(_as_filed)?":"[1-5]"/, id);
  }
});

test('get_filing: a small count the file forgot to mark is still not given', async () => {
  const tables = changed((name, file) => {
    if (name === '340b-state-filings.json') {
      const row = file.line_items.find((l) => l.filing_id === 'ri-2025-wellone' && l.claims !== '' && l.schedule === 'C');
      row.claims = '3';
      row.claims_as_filed = '3';
      row.claims_withheld = '';
    }
    return file;
  });
  const changedOut = async (name, args) => (await callOn(tables)(name, args)).structuredContent;
  const { lines, withheld } = await wholeReport(changedOut, 'ri-2025-wellone');
  assert.doesNotMatch(JSON.stringify(lines), /"claims(_as_filed)?":"3"/);
  assert.ok(withheld.by_reason.fewer_than_6 >= 1);
});

test('get_filing: how the figures were checked, discrepancies as filed, measures, and attached documents', async () => {
  const idaho = await out('get_filing', { filing_id: 'id-2025-statewide' });
  assert.equal(idaho.discrepancies.count, 3);
  const d = idaho.discrepancies.rows.find((row) => row.filed === '1916995');
  assert.deepEqual([d.filed, d.expected, d.difference, d.unit], ['1916995', '1916602', '393', 'count']);
  assert.match(d.basis_means, /form itself says/);
  assert.match(idaho.discrepancies.meaning, /corrects neither/);
  assert.equal(idaho.checked.by_verification.text_and_image, idaho.checked.lines);
  assert.match(idaho.checked.meaning.text_and_image, /separate read of the page image/);
  assert.equal(idaho.measures, undefined);

  const eastBay = await out('get_filing', { filing_id: 'ri-2025-east-bay-cap', limit: 1 });
  assert.equal(eastBay.measures.rows.find((m) => m.measure === 'gross_margin').value, '2618945.76');
  assert.match(eastBay.measures.meaning, /not a comparison with any other filer/);
  assert.equal(eastBay.attached_documents[0].kind, 'cover_letter');

  const none = await out('get_filing', { filing_id: 'vt-2025-gifford', limit: 1 });
  assert.match(none.discrepancies.meaning, /^No discrepancy is recorded|corrects neither/);
});

test('get_filing: a long report is given in parts, and a part can be asked for', async () => {
  const id = 'ri-2025-rhode-island-hospital';
  const first = await out('get_filing', { filing_id: id });
  assert.equal(first.lines_total, 1030);
  assert.equal(first.lines.length, 100, 'one answer holds 100 lines unless more are asked for');
  assert.equal(first.lines_returned, 100);
  assert.equal(first.offset, 0);
  assert.equal(first.more, '930 more lines: ask again with offset 100 for the next part, or with schedule to take one schedule at a time. One answer holds up to 150 lines.');
  const keys = Object.keys(first);
  assert.ok(keys.indexOf('more') < keys.indexOf('lines') && keys.indexOf('lines_total') < keys.indexOf('lines'), 'how much is left is said before the lines, not after them');
  const next = await out('get_filing', { filing_id: id, offset: 100, limit: 150 });
  assert.equal(next.lines.length, 150);
  assert.match(next.more, /^780 more lines: ask again with offset 250 /);
  const all = (await wholeReport(out, id)).lines;
  assert.equal(all.length, 1030, 'reading part after part gives every line once');
  assert.deepEqual(next.lines, all.slice(100, 250));
  assert.deepEqual(first.lines, all.slice(0, 100));
  const g = await out('get_filing', { filing_id: id, schedule: 'G', limit: 150 });
  assert.equal(g.lines_total, 975);
  assert.equal(g.lines.length, 150);
  assert.ok(g.lines.every((l) => l.schedule === 'G'));
  assert.match(g.more, /^825 more lines: ask again with offset 150 /);
  assert.equal(g.schedules.A, 6, 'the answer lists every schedule even when one is asked for');
  const last = await out('get_filing', { filing_id: id, offset: 1000, limit: 150 });
  assert.equal(last.lines.length, 30);
  assert.equal(last.more, undefined, 'the last part offers nothing more');
  const past = await out('get_filing', { filing_id: id, offset: 5000 });
  assert.equal(past.lines.length, 0);
  assert.equal(past.more, undefined);
});

test('get_filing: the tool says how many lines one answer holds, and takes no more than that', async () => {
  const tool = TOOLS.find((t) => t.name === 'get_filing');
  assert.deepEqual(FILING_LINES, { usual: 100, most: 150 });
  assert.equal(tool.inputSchema.properties.limit.maximum, 150);
  assert.equal(tool.inputSchema.properties.limit.minimum, 1);
  assert.match(tool.inputSchema.properties.limit.description, /default 100, at most 150/);
  assert.match(tool.description, /One answer holds 100 lines, or up to 150 with limit/);
  assert.match(tool.description, /how to ask for the next part with offset/);
  assert.match(tool.inputSchema.properties.offset.description, /next part/);
  for (const limit of [151, 250, 500]) {
    const result = await run('get_filing', { filing_id: 'id-2025-statewide', limit });
    assert.equal(result.isError, true, `limit ${limit}`);
    assert.equal(result.content[0].text, 'limit must be a whole number from 1 to 150');
  }
  assert.equal((await out('get_filing', { filing_id: 'ri-2025-rhode-island-hospital', limit: 150 })).lines.length, 150);
});

test('get_filing: no answer is too long for an assistant to take in, at the usual or at the largest number of lines', async () => {
  // The text of an answer, in characters. Directories of servers turn away an answer near 100,000;
  // the largest report line in these samples is under 600 characters, so 150 of them stay far below.
  const MOST_CHARACTERS = 80000;
  const sizeOf = async (args) => {
    const result = await run('get_filing', args);
    assert.equal(result.isError, false, JSON.stringify(args));
    return result.content[0].text.length;
  };
  const ids = JSON.parse(await readFile(`${DATA}/340b-state-filings.json`, 'utf8')).filings.map((f) => f.filing_id);
  assert.equal(ids.length, 55);
  let largest = 0;
  for (const id of ids) {
    const total = (await out('get_filing', { filing_id: id, limit: 1 })).lines_total;
    for (const limit of [undefined, FILING_LINES.most]) {
      const step = limit ?? FILING_LINES.usual;
      for (let offset = 0; offset < Math.max(total, 1); offset += step) {
        const size = await sizeOf({ filing_id: id, ...(limit ? { limit } : {}), ...(offset ? { offset } : {}) });
        assert.ok(size < MOST_CHARACTERS, `${id} at offset ${offset} with ${step} lines is ${size} characters`);
        largest = Math.max(largest, size);
      }
    }
  }
  assert.ok(largest > 20000, 'the samples do hold a long report, so the check above means something');
});

test('get_filing: mistakes in what was asked are said back plainly', async () => {
  for (const [args, saying] of [[{}, /filing_id is required/], [{ filing_id: 'xx-1999-nobody' }, /no filed report with the id/], [{ filing_id: 'id-2025-statewide', schedule: 'Z' }, /no lines in the schedule Z; its schedules are: key_highlights/], [{ filing_id: 'id-2025-statewide', limit: 9000 }, /limit must be a whole number from 1 to 150/], [{ filing_id: 'id-2025-statewide', limit: 0 }, /limit must be a whole number from 1 to 150/], [{ filing_id: 'id-2025-statewide', offset: -1 }, /offset must be a whole number/]]) {
    const result = await run('get_filing', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, saying);
  }
});

test('get_filing: a schedule that is not text is refused in words, and never printed as an object', async () => {
  for (const schedule of [{}, { name: 'G' }, [], ['G'], 7, 1.5, true, null]) {
    const result = await run('get_filing', { filing_id: 'id-2025-statewide', schedule });
    assert.equal(result.isError, true, JSON.stringify(schedule));
    assert.equal(result.content[0].text, 'schedule must be text, such as G; the answer without a schedule lists the schedules the report has');
    assert.doesNotMatch(result.content[0].text, /\[object/);
  }
  // Text is still taken as before: a schedule the report has, none at all, and one it does not have.
  assert.equal((await out('get_filing', { filing_id: 'ri-2025-rhode-island-hospital', schedule: 'A' })).lines_total, 6);
  assert.equal((await out('get_filing', { filing_id: 'id-2025-statewide', schedule: '' })).lines_total, (await out('get_filing', { filing_id: 'id-2025-statewide' })).lines_total);
  assert.match((await run('get_filing', { filing_id: 'id-2025-statewide', schedule: 'Z' })).content[0].text, /no lines in the schedule Z; its schedules are: key_highlights/);
  // A word every object answers to is not a schedule.
  for (const word of ['constructor', 'toString', '__proto__']) {
    const result = await run('get_filing', { filing_id: 'id-2025-statewide', schedule: word });
    assert.equal(result.isError, true, word);
    assert.match(result.content[0].text, new RegExp(`no lines in the schedule ${word};`));
  }
});

test('a form, record kind, entity type and check the code has never seen is returned sensibly', async () => {
  const tables = changed((name, file) => {
    if (name !== '340b-state-filings.json') return file;
    file.entities.push({ entity_id: 'oh-example-clinic', entity_type: 'clinic_network', entity_type_as_filed: 'Clinic Network', name_as_filed: 'Example Clinic Network', city_as_filed: 'Dayton', opais_ids_as_filed: 'CH099999', state: 'OH' });
    file.filings.push({ filing_id: 'oh-2025-example-clinic', entity_id: 'oh-example-clinic', state: 'OH', reporting_year: '2025', form: 'oh-future-form', form_revision: 'Future form, revised 2027', record_kind: 'annual_statement', source_url: 'https://example.org/oh/example.pdf', source_file: 'example.pdf', pdf_bytes: '1234', pdf_sha256: 'a'.repeat(64), page_count: '3', retrieved_at: '2026-11-16T08:00:00Z', scanned: 'false', period_as_filed: 'July 1 to June 30', brand_new_column: 'kept' });
    file.line_items.push(
      { filing_id: 'oh-2025-example-clinic', schedule: 'Q', line: 'q1', row_kind: 'subtotal', label_as_filed: 'Something new', amount_as_filed: '$12.5M', amount: '12500000', unit: 'dollars', claims_withheld: 'because_of_a_new_rule', page: '2', verification: 'peer_review', extra_cell: 'x' },
      { filing_id: 'oh-2025-example-clinic', schedule: 'Q', line: 'q2', label_as_filed: 'Another', amount_as_filed: '7', amount: '7', unit: 'count', claims: '4', claims_as_filed: '4', page: '2', verification: 'text_and_image' },
    );
    file.discrepancies.push({ filing_id: 'oh-2025-example-clinic', basis: 'invented', description: 'Two figures differ', filed: '10', expected: '12', difference: '2', unit: 'usd', rule: 'x', note: '' });
    return file;
  });
  const call = callOn(tables);
  const found = (await call('find_filings', { state: 'OH' })).structuredContent;
  assert.equal(found.matched, 1);
  assert.deepEqual(found.filings[0], {
    filing_id: 'oh-2025-example-clinic', entity: 'Example Clinic Network', entity_id: 'oh-example-clinic', entity_type: 'clinic_network', state: 'OH', year: '2025',
    form: 'oh-future-form', form_revision: 'Future form, revised 2027', record_kind: 'annual_statement', clinx_page: 'https://clinx.org/scorecard/oh/', official_source: 'https://example.org/oh/example.pdf',
  });
  assert.equal((await call('find_filings', { record_kind: 'annual_statement' })).structuredContent.matched, 1);
  assert.equal((await call('get_filing', { filing_id: 'oh-2025-example-clinic' })).structuredContent.clinx_page, 'https://clinx.org/scorecard/oh/', 'only an entity\'s own filing has a page of its own; any other kind points to the state\'s page');
  assert.equal((await call('find_filings', { form: 'oh-future-form' })).structuredContent.matched, 1);
  assert.equal((await call('find_filings', { entity: 'ch099999' })).structuredContent.matched, 1);
  const one = (await call('get_filing', { filing_id: 'oh-2025-example-clinic' })).structuredContent;
  assert.equal(one.filing.brand_new_column, 'kept', 'a column the code has not seen is not dropped');
  assert.equal(one.lines[0].extra_cell, 'x');
  assert.equal(one.lines[0].unit, 'dollars', 'an unseen unit is passed on as it is');
  assert.equal(one.lines[0].claims_withheld, 'because_of_a_new_rule');
  assert.match(one.withheld.why.because_of_a_new_rule, /withheld \(because_of_a_new_rule\)\. Counts of 1 to 5 are never published/);
  assert.match(one.checked.meaning.peer_review, /Recorded as peer_review/);
  assert.equal(one.lines[1].claims, undefined, 'a 4 is withheld even on a form the code has never seen');
  assert.equal(one.lines[1].claims_withheld, 'fewer_than_6');
  assert.match(one.discrepancies.rows[0].filed, /^10$/);
  assert.equal(one.discrepancies.rows[0].basis_means, undefined);
  const overview = (await call('state_overview', { state: 'OH' })).structuredContent;
  assert.equal(overview.filings.count, 1);
  assert.deepEqual(overview.filings.by_record_kind, { annual_statement: 1 });
  const about = (await call('about_the_data')).structuredContent;
  assert.ok(about.filings.forms.includes('oh-future-form') && about.filings.record_kinds.includes('annual_statement') && about.filings.entity_types.includes('clinic_network'));
});

test('state_overview: which group of reporting states, and how many filings are held', async () => {
  const ri = await out('state_overview', { state: 'RI' });
  assert.equal(ri.reporting.group, 'own-reports');
  assert.equal(ri.reporting.group_label, 'Each filer\'s own report is posted');
  assert.equal(ri.reporting.on_clinx, true);
  assert.equal(ri.filings.count, 14);
  assert.deepEqual(ri.filings.by_year, { 2025: 14 });
  assert.deepEqual(ri.filings.by_record_kind, { filing: 14 });
  assert.equal(ri.pages.scorecard, 'https://clinx.org/scorecard/ri/');

  const mn = await out('state_overview', { state: 'MN' });
  assert.equal(mn.reporting.group, 'named-in-state-report');
  assert.equal(mn.filings.count, 27);
  assert.deepEqual(mn.filings.by_record_kind, { state_report_row: 26, state_report_totals: 1 });

  const il = await out('state_overview', { state: 'IL' });
  assert.equal(il.reporting.group, 'not-posted-yet');
  assert.equal(il.reporting.scorecard_url, null);
  assert.equal(il.filings.count, 0);
  assert.equal(il.pages.scorecard, undefined, 'no page of figures is offered where there are none');

  const tx = await out('state_overview', { state: 'TX' });
  assert.equal(tx.reporting.listed, false);
  assert.equal((await out('state_overview', { state: 'US' })).reporting, undefined);
  assert.equal((await out('state_overview', { state: 'FED' })).reporting, undefined);
});

test('about_the_data: describes the filings table, the grouping, the small-count rule and that every figure is as filed', async () => {
  const about = await out('about_the_data');
  assert.deepEqual(about.counts, { laws: 5, bills: 14, notices: 5, calendar_dates: 84 }, 'the counts of the first four tables are unchanged');
  assert.equal(about.filings.records, 55);
  assert.equal(about.filings.lines, 3321);
  assert.deepEqual(about.filings.states, ['ID', 'MN', 'RI', 'VT']);
  assert.deepEqual(about.filings.years, ['2024', '2025']);
  assert.deepEqual(about.filings.record_kinds, ['filing', 'state_report_row', 'state_report_totals']);
  assert.match(about.filings.as_filed, /exactly as the official file prints it/);
  assert.match(about.filings.small_counts, /1 to 5 claims is never published/);
  assert.equal(about.reporting_states.states, 11);
  assert.deepEqual(about.reporting_states.groups.map((g) => [g.id, g.states]), [['own-reports', 3], ['named-in-state-report', 1], ['state-totals', 4], ['not-posted-yet', 3]]);
  assert.match(about.up_to_date_as_of.filings, /^read 2026-11-1\d, dataset version 0\.6\.0$/);
  assert.equal(about.up_to_date_as_of.reporting_states, '2026-11-16');
  assert.match(about.sources, /SHA-256/);
});

test('when either new file cannot be read, the nine older tools keep answering and the new ones say so', async () => {
  for (const [broken, reasons] of [[['340b-state-filings.json'], { filings: true, reporting: false }], [['340b-reporting-states.json'], { filings: false, reporting: true }], [['340b-state-filings.json', '340b-reporting-states.json'], { filings: true, reporting: true }]]) {
    const call = callOn(changed((name, file) => { if (broken.includes(name)) throw new Error('gone'); return file; }));
    const older = [['find_bills', {}], ['get_bill', { bill_id: 'ri-2025-hb5634' }], ['find_laws', {}], ['get_law', { law_id: 'ri-2025-s114' }], ['find_notices', {}], ['get_notice', { notice_id: 'fr-2026-15633' }], ['calendar', {}], ['state_overview', { state: 'RI' }], ['about_the_data', {}]];
    for (const [name, args] of older) {
      const result = await call(name, args);
      assert.equal(result.isError, false, `${name} with ${broken.join(', ')} unreadable`);
    }
    const filingsSaid = (await call('find_filings')).content[0].text;
    const getSaid = (await call('get_filing', { filing_id: 'id-2025-statewide' })).content[0].text;
    const statesSaid = (await call('reporting_states')).content[0].text;
    assert.equal(filingsSaid === FILINGS_UNREAD, reasons.filings);
    assert.equal(getSaid === FILINGS_UNREAD, reasons.filings);
    assert.equal(statesSaid === REPORTING_UNREAD, reasons.reporting);
    const overview = (await call('state_overview', { state: 'RI' })).structuredContent;
    assert.equal(overview.laws.count > 0, true);
    assert.equal(overview.filings.unavailable === FILINGS_UNREAD, reasons.filings);
    assert.equal(overview.reporting.unavailable === REPORTING_UNREAD, reasons.reporting);
    const about = (await call('about_the_data')).structuredContent;
    assert.equal(about.counts.laws, 5);
    assert.equal(about.filings.unavailable === FILINGS_UNREAD, reasons.filings);
  }
  assert.match(FILINGS_UNREAD, /could not be read just now/);
  assert.match(REPORTING_UNREAD, /could not be read just now/);
});

test('a file that is not the filed reports at all counts as unreadable, and a file that comes back later is picked up', async () => {
  let up = false;
  let clock = Date.parse(`${TODAY}T12:00:00Z`);
  const fetcher = async (url) => {
    const name = String(url).split('/').pop();
    if (name === '340b-state-filings.json' && !up) return { ok: true, status: 200, json: async () => ({ hello: 'world' }) };
    const file = JSON.parse(await readFile(`${DATA}/${name}`, 'utf8'));
    return { ok: true, status: 200, json: async () => file };
  };
  const call = callOn(makeTables({ source: 'https://clinx.org/data/', fetcher, now: () => clock }));
  assert.equal((await call('find_filings')).content[0].text, FILINGS_UNREAD);
  up = true;
  assert.equal((await call('find_filings')).content[0].text, FILINGS_UNREAD, 'not asked again at once');
  clock += 2 * 60 * 1000;
  assert.equal((await call('find_filings', { state: 'ID' })).structuredContent.matched, 1, 'asked again after a minute');
});

test('the new stage Did not pass is accepted, and a bill that did not pass is finished, not pending', async () => {
  const tables = changed((name, file) => {
    if (name === '340b-bills.json') file.bills = file.bills.map((b) => (b.bill_id === 'il-104th-hb3794' ? { ...b, stage: 'Did not pass', latest_action: 'Session ended', latest_action_date: '2026-01-10' } : b));
    if (name === '340b-events.json') {
      file.kinds['report due'] = 'The day a state\'s 340B report is due.';
      file.events.push({ day: '2027-03-01', jurisdiction: 'RI', kind: 'report due', what: 'Annual 340B reports are due', body: '', where: '', link: 'https://example.org/due' });
    }
    return file;
  });
  const call = callOn(tables);
  const found = (await call('find_bills', { stage: 'Did not pass' })).structuredContent;
  assert.deepEqual(found.bills.map((b) => [b.bill_id, b.stage]), [['il-104th-hb3794', 'Did not pass']]);
  const others = (await call('find_bills', { stage: 'Introduced' })).structuredContent;
  assert.ok(!others.bills.some((b) => b.bill_id === 'il-104th-hb3794'), 'it is not shown as pending or in progress');
  assert.ok(!(await call('find_bills', { stage: 'Reported by committee' })).structuredContent.bills.some((b) => b.bill_id === 'il-104th-hb3794'));
  const il = (await call('state_overview', { state: 'IL' })).structuredContent;
  assert.equal(il.bills.by_stage['Did not pass'], 1);
  assert.deepEqual(il.bills.did_not_pass.map((b) => b.bill_id), ['il-104th-hb3794']);
  assert.equal(il.bills.count, 6);
  assert.match(TOOLS.find((t) => t.name === 'find_bills').inputSchema.properties.stage.description, /finished/);
  // Without any such bill the answer carries no list of them.
  assert.equal((await out('state_overview', { state: 'IL' })).bills.did_not_pass, undefined);

  const due = (await call('calendar', { kind: 'report due', from: '2027-01-01' })).structuredContent;
  assert.deepEqual(due.events.map((e) => [e.day, e.place, e.kind]), [['2027-03-01', 'RI', 'report due']]);
  assert.ok((await call('about_the_data')).structuredContent.calendar_kinds['report due']);
  assert.match((await run('find_bills', { stage: 'Dead' })).content[0].text, /Did not pass/);
  assert.match((await run('calendar', { kind: 'nonsense' })).content[0].text, /report due/);
});

test('a host that counts requests sees an unreadable filings file as the tables being unreachable', async () => {
  const { describeRequest } = await import('../src/usage.js');
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_filings', arguments: { entity: 'private words' } } };
  const tables = changed((name, file) => { if (name === '340b-state-filings.json') throw new Error('gone'); return file; });
  const described = describeRequest(message, await handle(message, tables));
  assert.equal(described.outcome, 'tables unreachable');
  assert.equal(described.filters, 'entity');
});
