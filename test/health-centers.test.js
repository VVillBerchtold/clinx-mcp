// The health center tools, checked against the small copies in test/data/health-centers. The
// copies are real files from clinx.org/data cut down to a few rows: three health centers, a few
// tables of their reports, five funding opportunities with their dated lines, and the shortage
// areas of a few states. Every value in them is as published. Some tests make a file unreadable
// to show what the server does then. No network is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handle, INSTRUCTIONS, SERVER } from '../src/core.js';
import { makeTables } from '../src/tables.js';
import { localTables } from '../src/disk.js';
import { TOOLS } from '../src/tools.js';
import { HC_FILES, centerFile, areaFile } from '../src/health-centers.js';
import { HC_UNREAD, HEALTH_CENTER_TOOLS } from '../src/health-center-tools.js';
import { describeRequest } from '../src/usage.js';
import { ANSWER_MOST, sizeOf } from '../src/inputs.js';

const DATA = fileURLToPath(new URL('./data', import.meta.url));
const TODAY = '2026-11-16';
const now = () => Date.parse(`${TODAY}T12:00:00Z`);
const SOURCE = 'https://clinx.org/data/';
const NAMES = ['find_health_centers', 'get_health_center_report', 'find_funding_opportunities', 'health_center_calendar', 'shortage_area_changes'];
const NEVER = /\b(best|highest|lowest|worst)\b|top |anonymi|de-identified|HIPAA|—|!/i;

/** Tables read from test/data. `unreadable` names the files that answer 404; `asked` collects the name of every file read. */
function tablesWith({ unreadable = [], asked = [], change } = {}) {
  const fetcher = async (url) => {
    const name = String(url).slice(SOURCE.length);
    asked.push(name);
    if (unreadable.includes(name)) return { ok: false, status: 404 };
    try {
      const file = JSON.parse(await readFile(`${DATA}/${name}`, 'utf8'));
      return { ok: true, status: 200, json: async () => (change ? change(name, file) : file) };
    } catch {
      return { ok: false, status: 404 };
    }
  };
  return makeTables({ source: SOURCE, fetcher, now });
}
const callOn = (tables) => async (name, args = {}) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tables)).result;
const run = callOn(localTables({ folder: DATA, now }));
/** A tool's answer as an object. The reply carries it once, as JSON in one block of text. */
const read = (result) => JSON.parse(result.content[0].text);
const out = async (name, args) => {
  const result = await run(name, args);
  assert.equal(result.isError, false, result.content[0].text);
  return read(result);
};
const refused = async (name, args) => {
  const result = await run(name, args);
  assert.equal(result.isError, true, name);
  return result.content[0].text;
};

test('the five health center tools are listed after the 340B tools, described plainly, and read only', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(HEALTH_CENTER_TOOLS.map((t) => t.name), NAMES);
  assert.deepEqual(names.slice(-6), [...NAMES, 'about_the_data']);
  for (const tool of TOOLS.filter((t) => NAMES.includes(t.name))) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.doesNotMatch(`${tool.title} ${tool.description} ${JSON.stringify(tool.inputSchema)}`, NEVER, tool.name);
  }
  for (const name of NAMES) assert.match(INSTRUCTIONS, new RegExp(name));
  assert.match(INSTRUCTIONS, /ranks no health center/);
  assert.doesNotMatch(INSTRUCTIONS, NEVER);
  assert.equal(SERVER.version, '0.3.2');
  assert.match(SERVER.description, /340B/);
  assert.match(SERVER.description, /[Hh]ealth centers/);
});

test('find_health_centers: by state, words and year, in the order of the names, with the day read', async () => {
  const all = await out('find_health_centers');
  assert.equal(all.matched, 3);
  assert.deepEqual(all.health_centers.map((c) => c.name), ['CITY OF SPRINGFIELD, MASSACHUSETTS', 'NORTHWEST COMMUNITY HEALTH CARE', 'TRI-COUNTY COMMUNITY ACTION AGENCY']);
  assert.deepEqual(all.held, { health_centers: 3, states: ['MA', 'RI'], years: [2021, 2022, 2023, 2024, 2025], latest_year: 2025 });
  assert.equal(all.read_on, '2026-11-16');
  assert.equal(all.hrsa_last_refreshed, '05/07/2026 12:00 AM EST');
  assert.match(all.note, /does not rank or judge/);

  const ri = await out('find_health_centers', { state: 'ri' });
  assert.deepEqual(ri.health_centers.map((c) => c.key), ['010480', '01E00040']);
  const pascoag = ri.health_centers[0];
  assert.deepEqual(pascoag, {
    key: '010480',
    grant_number: 'H80CS00308',
    name: 'NORTHWEST COMMUNITY HEALTH CARE',
    city: 'Pascoag',
    state: 'RI',
    years: [2021, 2022, 2023, 2024, 2025],
    funding_types: ['Community Health Center'],
    urban_rural: 'Rural',
    sites_listed: 7,
    clinx_page: 'https://clinx.org/health-centers/records/010480/',
  });

  // An earlier name finds the health center, and the answer gives both names.
  const earlier = await out('find_health_centers', { text: 'tri-town' });
  assert.equal(earlier.matched, 1);
  assert.equal(earlier.health_centers[0].name, 'TRI-COUNTY COMMUNITY ACTION AGENCY');
  assert.deepEqual(earlier.health_centers[0].earlier_names, [{ year: 2021, name: 'TRI-TOWN ECONOMIC OPPORTUNITY COMMITTEE' }]);
  assert.equal(earlier.health_centers[0].clinx_page, 'https://clinx.org/health-centers/records/01e00040/');
  assert.equal((await out('find_health_centers', { text: 'H80CS00001' })).health_centers[0].key, '010120');
  assert.equal((await out('find_health_centers', { text: 'springfield', year: 2025 })).matched, 1);

  // A state or a year that is not held is said, and is not an error.
  const texas = await out('find_health_centers', { state: 'TX' });
  assert.equal(texas.matched, 0);
  assert.match(texas.note, /holds no health center records for TX yet\. The states held are: MA, RI\./);
  assert.match((await out('find_health_centers', { year: 2019 })).note, /No report for 2019 is held/);
  assert.match(await refused('find_health_centers', { state: 'Rhode Island' }), /two-letter code/);
  assert.match(await refused('find_health_centers', { limit: 1000 }), /limit must be a whole number from 1 to 100/);
  assert.equal((await out('find_health_centers', { limit: 1 })).shown, 1);
  assert.match((await out('find_health_centers', { limit: 1 })).note, /Showing 1 of 3/);
});

test('get_health_center_report: with no table, the header, the tables with their counts, and where the page is', async () => {
  const report = await out('get_health_center_report', { health_center: '010120' });
  assert.deepEqual(report.health_center, {
    key: '010120',
    grant_number: 'H80CS00001',
    name: 'CITY OF SPRINGFIELD, MASSACHUSETTS',
    city: 'Springfield',
    state: 'MA',
    urban_rural: 'Urban',
    funding_types: ['Homeless Population'],
    years_held: [2021, 2022, 2023, 2024, 2025],
  });
  assert.equal(report.year, 2025);
  assert.deepEqual(report.tables.map((t) => [t.table, t.label, t.status, t.lines, t.cells]), [
    ['Table 3A', 'Patients by age and sex assigned at birth', 'present', 39, 78],
    ['Table 9E', 'Other revenue', 'present', 21, 28],
  ]);
  // Every cell is counted once: a value, a mark, typed text that is not kept, or an empty cell.
  for (const t of report.tables) {
    const marks = Object.values(t.cells_with_a_mark ?? {}).reduce((a, b) => a + b, 0);
    assert.equal(t.cells_with_a_value + marks + (t.cells_withheld_by_clinx ?? 0) + (t.cells_of_typed_text_not_kept ?? 0) + (t.cells_empty ?? 0), t.cells, t.table);
  }
  assert.equal(report.tables[1].cells_of_typed_text_not_kept, 1);
  assert.deepEqual(report.tables[0].cells_with_a_mark, { '-': 36, '--': 21 });
  assert.equal(report.sites_listed, 7);
  assert.equal(report.clinx_page, 'https://clinx.org/health-centers/records/010120/');
  assert.equal(report.whole_file, 'https://clinx.org/data/health-centers/records/centers/010120.json');
  assert.equal(report.source.workbook, 'H80-2025.xlsx');
  assert.equal(report.source.read_on, '2026-11-16');
  assert.equal(report.source.hrsa_last_refreshed, '05/07/2026 12:00 AM EST');
  assert.match(report.source.how_read, /Two separate programs read every cell/);
  assert.match(report.marks['--'], /suppressed patient counts between 1-15/);
  assert.doesNotMatch(JSON.stringify(report), NEVER);

  // The grant number finds the same health center; an earlier year has a page of its own.
  const byGrant = await out('get_health_center_report', { health_center: 'h80cs00001', year: 2022 });
  assert.equal(byGrant.health_center.key, '010120');
  assert.equal(byGrant.clinx_page, 'https://clinx.org/health-centers/records/010120/2022/');
  assert.equal(byGrant.source.workbook, 'H80-2022.xlsx');
});

test('get_health_center_report: one table, every value as published, and a mark as the mark with its meaning', async () => {
  const file = JSON.parse(await readFile(`${DATA}/${centerFile('010120')}`, 'utf8'));
  const values = file.years['2025'].values;
  const table = await out('get_health_center_report', { health_center: '010120', table: 'table 3a' });
  assert.equal(table.table, 'Table 3A');
  assert.equal(table.status, 'present');
  assert.equal(table.lines_total, 39);
  assert.equal(table.lines_returned, 39);
  assert.equal(Object.keys(table.columns).length, 2);
  let cells = 0;
  for (const line of table.lines) {
    assert.ok(line.line && line.title, JSON.stringify(line));
    for (const cell of line.cells) {
      cells += 1;
      const uiid = `T3a_${line.line}_${cell.column}`;
      const published = values[uiid];
      assert.equal(typeof published, 'string', uiid);
      if (['-', '--', '---'].includes(published)) {
        assert.equal(cell.mark, published, uiid);
        assert.ok(cell.means && cell.value === undefined, uiid);
      } else {
        assert.equal(cell.value, published, uiid);
        assert.equal(cell.mark, undefined, uiid);
      }
    }
  }
  assert.equal(cells, 78);
  const marksSeen = new Set(table.lines.flatMap((l) => l.cells.map((c) => c.mark).filter(Boolean)));
  assert.deepEqual(Object.keys(table.what_the_marks_mean).sort(), [...marksSeen].sort());
  assert.match(table.how_to_read, /character for character/);
  assert.doesNotMatch(JSON.stringify(table), NEVER);

  // A long table in parts, one line, and words in a title.
  const part = await out('get_health_center_report', { health_center: '010120', table: '3A', offset: 30, limit: 5 });
  assert.equal(part.lines_returned, 5);
  assert.match(part.more, /4 more lines: ask again with offset 35/);
  const one = await out('get_health_center_report', { health_center: '010120', table: 'Table 3A', line: '10' });
  assert.deepEqual(one.lines.map((l) => l.line), ['L10']);
  assert.equal(one.lines[0].cells.length, 2);
  const total = await out('get_health_center_report', { health_center: '010120', table: 'Table 3A', text: 'total' });
  assert.ok(total.lines_total >= 1 && total.lines.every((l) => /total/i.test(l.title)));
});

test('get_health_center_report: a value ClinX withholds, typed text, an exponent, and a sheet that does not name the health center', async () => {
  // 2022, Table 5, line 21a: HRSA printed a count of patients from 1 to 15 here. ClinX's file holds no figure for it.
  const five = await out('get_health_center_report', { health_center: '010120', year: 2022, table: 'Table 5' });
  const cells = Object.fromEntries(five.lines[0].cells.map((c) => [c.column, c]));
  assert.deepEqual(cells.Cc, { column: 'Cc', no_value: 'withheld by ClinX' });
  assert.deepEqual(cells.Cb, { column: 'Cb', value: '15' });
  assert.match(five.what_the_marks_mean['withheld by ClinX'], /a whole number from 1 to 15 is not repeated/);
  assert.doesNotMatch(JSON.stringify(five.lines), /"value":"(?:[1-9]|1[0-5])"[^}]*\}\]\}$/);

  // The rule holds whatever the file says: a small count of patients put back into the file is still not given.
  const tampered = tablesWith({ change: (name, file) => {
    if (name === centerFile('010120')) file.years['2022'].values.T5_L21a_Cc = '7';
    return file;
  } });
  const again = read(await callOn(tampered)('get_health_center_report', { health_center: '010120', year: 2022, table: 'Table 5' }));
  assert.deepEqual(again.lines[0].cells.find((c) => c.column === 'Cc'), { column: 'Cc', no_value: 'withheld by ClinX' });

  // Typed text is not kept, and a number HRSA published with an exponent is given as published.
  const nine = await out('get_health_center_report', { health_center: '010120', year: 2022, table: 'Table 9E', limit: 200 });
  const all = nine.lines.flatMap((l) => l.cells.map((c) => ({ line: l.line, ...c })));
  assert.equal(all.filter((c) => c.no_value === 'typed text, not kept').length, 1);
  assert.deepEqual(all.find((c) => c.line === 'L1o' && c.column === 'Ca'), { line: 'L1o', column: 'Ca', value: '2e+05', exponent: true });
  assert.match(nine.what_the_marks_mean['typed text, not kept'], /does not keep typed text/);

  // 2021: HRSA's workbook does not name this health center in the sheet of Table 5. No value is given.
  const unnamed = await out('get_health_center_report', { health_center: '010120', year: 2021, table: 'Table 5' });
  assert.equal(unnamed.status, 'unnamed');
  assert.match(unnamed.status_means, /does not name the health center/);
  assert.ok(unnamed.lines.length > 0 && unnamed.lines.every((l) => l.cells === undefined));
  const listed = await out('get_health_center_report', { health_center: '010120', year: 2021 });
  const row = listed.tables.find((t) => t.table === 'Table 5');
  assert.equal(row.status, 'unnamed');
  assert.equal(row.cells_with_a_value, undefined);
});

test('get_health_center_report: where the lines are long, one answer holds fewer whole lines, says so, and names the next part truly', async () => {
  // The titles of the report lines are made long in memory, with quotation marks in them, so that
  // the 39 lines of Table 3A no longer fit in one answer. No value of the report is changed.
  const LONG = ` ${'a "quoted" word and more words to fill the line. '.repeat(60)}`;
  const tables = tablesWith({
    change: (name, file) => {
      if (name !== HC_FILES.lines) return file;
      const at = Object.fromEntries(file.columns.map((column, i) => [column, i]));
      const rows = Object.values(file.years).flat();
      const titles = new Set(rows.map((row) => row[at.line_title]));
      for (const column of file.text_columns) if (column !== 'line_title') for (const row of rows) titles.delete(row[at[column]]);
      return { ...file, texts: file.texts.map((words, i) => (titles.has(i) ? words + LONG : words)) };
    },
  });
  const ask = async (args) => {
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_health_center_report', arguments: { health_center: '010120', table: '3A', ...args } } }, tables);
    assert.equal(reply.result.isError, false, reply.result.content[0].text);
    assert.ok(JSON.stringify(reply).length <= ANSWER_MOST + 500, `the whole reply at offset ${args.offset ?? 0}`);
    return read(reply.result);
  };
  const plain = await out('get_health_center_report', { health_center: '010120', table: '3A', limit: 200 });
  assert.equal(plain.lines.length, 39);
  assert.equal(plain.more, undefined);

  const first = await ask({ limit: 200 });
  const held = first.lines.length;
  assert.ok(held > 1 && held < 39, `${held} lines`);
  assert.equal(first.lines_total, 39, 'the count of the whole table is not changed');
  assert.equal(first.lines_returned, held, 'the count is of the lines that are in the answer');
  assert.equal(first.more, `${39 - held} more lines: ask again with offset ${held}, or narrow with line or text. This answer holds ${held} lines: that is as many whole lines as fit in one answer.`);
  assert.ok(sizeOf(first) <= ANSWER_MOST);
  assert.ok(sizeOf(first) + 2 * sizeOf(first.lines[0]) > ANSWER_MOST, 'no fewer lines than fit');

  // Part after part, every line comes once and whole, with every cell as the short titles give it.
  const all = [...first.lines];
  for (let part = first; part.more !== undefined;) {
    const next = Number(/ask again with offset (\d+)/.exec(part.more)[1]);
    assert.equal(next, all.length, 'the offset the answer names is the next line');
    part = await ask({ limit: 200, offset: next });
    all.push(...part.lines);
  }
  assert.equal(all.length, 39);
  for (const [i, line] of all.entries()) {
    assert.equal(line.title, plain.lines[i].title + LONG, `line ${i} is whole`);
    assert.deepEqual({ ...line, title: plain.lines[i].title }, plain.lines[i]);
  }
  // A part cut at the limit and not for size keeps the sentence it always had.
  assert.equal((await ask({ limit: 3 })).more, '36 more lines: ask again with offset 3, or narrow with line or text.');
  // One line left is said as one line.
  assert.equal((await ask({ limit: 3, offset: 35 })).more, '1 more line: ask again with offset 38, or narrow with line or text.');
});

test('shortage_area_changes: where the rows are long, the list holds as many whole rows as fit and says how many of how many', async () => {
  const LONG = ` ${'More words in the "name" of the area. '.repeat(200)}`;
  const tables = tablesWith({ change: (name, file) => (name === areaFile('RI') ? { ...file, recent: file.recent.map((r) => ({ ...r, name: r.name + LONG })) } : file) });
  const plain = await out('shortage_area_changes', { state: 'RI', show: 'recent', limit: 100 });
  const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shortage_area_changes', arguments: { state: 'RI', show: 'recent', limit: 100 } } }, tables);
  const cut = read(reply.result);
  const kept = cut.designations.length;
  assert.ok(kept > 1 && kept < plain.designations.length, `${kept} rows`);
  assert.equal(cut.matched, plain.matched, 'how many matched is not changed');
  assert.equal(cut.shown, kept, 'the count is of the rows that are in the answer');
  assert.ok(cut.note.startsWith(`Showing ${kept} of ${plain.matched}, as many whole rows as fit in one answer: narrow it with kind, event or text to see the rest. `), cut.note);
  assert.ok(cut.note.endsWith(plain.note), 'the usual note follows');
  for (const [i, row] of cut.designations.entries()) {
    assert.equal(row.name, plain.designations[i].name + LONG, `row ${i} is whole`);
    assert.deepEqual({ ...row, name: plain.designations[i].name }, plain.designations[i]);
  }
  assert.ok(sizeOf(cut) <= ANSWER_MOST);
  assert.ok(JSON.stringify(reply).length <= ANSWER_MOST + 500);
});

test('get_health_center_report: what was asked wrongly is said back plainly', async () => {
  assert.match(await refused('get_health_center_report', {}), /health_center is required/);
  assert.match(await refused('get_health_center_report', { health_center: '999999' }), /no health center with the key or grant number 999999; use find_health_centers/);
  assert.match(await refused('get_health_center_report', { health_center: '010120', year: 2019 }), /no 2019 report is held for this health center; its years are: 2021, 2022, 2023, 2024, 2025/);
  assert.match(await refused('get_health_center_report', { health_center: '010120', table: 'Table 99' }), /has no table Table 99; its tables are: Table 3A, Table 9E/);
  assert.match(await refused('get_health_center_report', { health_center: '010120', table: 'Table 3A', line: '999' }), /Table 3A has no line 999; its lines are: L1, /);
  assert.match(await refused('get_health_center_report', { health_center: '010120', line: '10' }), /go with table/);
  assert.match(await refused('get_health_center_report', { health_center: '010120', table: 'Table 3A', limit: 500 }), /limit must be a whole number from 1 to 200/);
  assert.match(await refused('get_health_center_report', { health_center: '010120', sort: 'patients' }), /does not take sort/);
});

test('find_funding_opportunities: words, the Health Center Program only, open on a day, and one in full', async () => {
  const all = await out('find_funding_opportunities');
  assert.equal(all.matched, 5);
  assert.equal(all.read_on, '2026-11-16');
  const days = all.opportunities.map((o) => o.application_due);
  assert.deepEqual(days, [...days].sort());
  assert.ok(all.opportunities.every((o) => o.grants_gov_page === `https://www.grants.gov/search-results-detail/${o.id}` && o.clinx_page === `https://clinx.org/health-centers/funding/${o.id}/`));

  const program = await out('find_funding_opportunities', { health_center_program: true });
  assert.deepEqual(program.opportunities.map((o) => o.number), ['HRSA-27-006', 'HRSA-27-008']);
  assert.deepEqual(program.opportunities[0], {
    id: '363419',
    number: 'HRSA-27-006',
    title: 'Fiscal Year (FY) 2027 Service Area Competition (SAC)',
    status: 'forecasted',
    health_center_program: true,
    names_health_centers: true,
    application_due: '2026-12-30',
    application_due_as_published: 'Dec 30, 2026 12:00:00 AM EST',
    application_due_is_estimate: true,
    notice_expected: '2026-11-30',
    estimated_funding_as_published: '460992400',
    award_ceiling_as_published: '19182000',
    award_floor_as_published: '1215700',
    number_of_awards_as_published: '83',
    grants_gov_page: 'https://www.grants.gov/search-results-detail/363419',
    clinx_page: 'https://clinx.org/health-centers/funding/363419/',
  });

  // Open on a day: posted on or before it and due on or after it. A forecast is not open.
  const open = await out('find_funding_opportunities', { open_on: '2026-11-16' });
  assert.deepEqual(open.opportunities.map((o) => [o.number, o.status, o.application_due, o.application_due_is_estimate]), [['HRSA-27-017', 'posted', '2026-12-11', false], ['HRSA-27-072', 'posted', '2027-01-08', false]]);
  assert.match(open.open_means, /A forecast is not open/);
  assert.equal((await out('find_funding_opportunities', { open_on: '2026-10-30' })).matched, 1);
  assert.equal((await out('find_funding_opportunities', { open_on: '2027-02-01' })).matched, 0);
  assert.equal((await out('find_funding_opportunities', { status: 'posted' })).matched, 2);
  assert.equal((await out('find_funding_opportunities', { text: 'teaching health center' })).matched, 2);

  // One in full, by number or id. The agency's contact line is never read into memory.
  const one = await out('find_funding_opportunities', { opportunity: 'hrsa-27-006' });
  assert.equal(one.opportunity.id, '363419');
  assert.equal(one.opportunity.dates.est_application_due.as_published, 'Dec 30, 2026 12:00:00 AM EST');
  assert.equal(one.opportunity.estimated_funding.as_published, '460992400');
  assert.ok(one.opportunity.description.length > 100 && one.opportunity.listings[0].number === '93.224');
  for (const name of ['more_information_text', 'more_information_text_as_published', 'more_information_url', 'description_as_published', 'attachment_file_names']) assert.equal(one.opportunity[name], undefined, name);
  assert.match(one.status_means, /forecast/i);
  assert.equal((await out('find_funding_opportunities', { opportunity: '363111' })).opportunity.number, 'HRSA-27-017');
  assert.match(await refused('find_funding_opportunities', { opportunity: 'HRSA-00-000' }), /no funding opportunity with the number or id HRSA-00-000/);
  assert.match(await refused('find_funding_opportunities', { open_on: 'today' }), /open_on must be a date written year-month-day/);
  assert.match(await refused('find_funding_opportunities', { health_center_program: 'yes' }), /must be true or false/);
  assert.doesNotMatch(JSON.stringify([all, one.status_means, one.dates_mean, one.note]), NEVER);
});

test('health_center_calendar: what is coming up from today, a stretch between two days, by kind and by source', async () => {
  const file = JSON.parse(await readFile(`${DATA}/${HC_FILES.deadlines}`, 'utf8'));
  const coming = await out('health_center_calendar', { limit: 100 });
  assert.equal(coming.from, TODAY);
  assert.equal(coming.matched, file.filter((d) => d.date >= TODAY).length);
  assert.ok(coming.dates.every((d) => d.day >= TODAY && d.official_page.startsWith('https://')));
  assert.deepEqual(coming.dates.map((d) => d.day), coming.dates.map((d) => d.day).sort());
  assert.equal(coming.read_on, '2026-11-16');

  const due = await out('health_center_calendar', { from: '2026-11-01', to: '2027-01-31', kind: 'application due' });
  assert.deepEqual(due.dates.map((d) => [d.day, d.estimated, d.status]), [['2026-11-16', true, 'forecasted'], ['2026-12-11', false, 'posted'], ['2026-12-30', true, 'forecasted'], ['2027-01-08', true, 'forecasted'], ['2027-01-08', false, 'posted']]);
  assert.equal(due.dates[1].clinx_page, 'https://clinx.org/health-centers/funding/363111/');
  assert.deepEqual(Object.keys(due.kinds_mean), ['application due']);

  const register = await out('health_center_calendar', { from: '2026-01-01', source: 'federal register', limit: 100 });
  assert.equal(register.matched, file.filter((d) => d.source === 'federal register').length);
  assert.ok(register.dates.every((d) => d.source === 'federal register' && d.official_page.startsWith('https://www.federalregister.gov/') && d.clinx_page === 'https://clinx.org/health-centers/funding/'));
  assert.equal((await out('health_center_calendar', { from: '2026-01-01', text: 'service area competition', kind: 'award expected' })).matched, 2);
  assert.match(await refused('health_center_calendar', { from: '2027-02-01', to: '2027-01-01' }), /from must not be after to/);
  assert.match(await refused('health_center_calendar', { kind: 'hearing' }), /kind must be one of: notice expected, application due/);
  assert.doesNotMatch(JSON.stringify([coming.note, coming.sources, due.kinds_mean]), NEVER);
});

test('shortage_area_changes: the national counts, one state\'s counts, and the three lists', async () => {
  const sets = JSON.parse(await readFile(`${DATA}/${HC_FILES.sets}`, 'utf8'));
  const states = JSON.parse(await readFile(`${DATA}/${HC_FILES.areas}`, 'utf8'));
  const ri = JSON.parse(await readFile(`${DATA}/${areaFile('RI')}`, 'utf8'));

  const nation = await out('shortage_area_changes');
  assert.deepEqual(nation.national_counts, sets.areas.national_counts);
  assert.equal(nation.national_counts.designations['hpsa-pc'].Designated.designations, 7890);
  assert.deepEqual(nation.states_and_territories, ['MA', 'PR', 'RI', 'XX']);
  assert.equal(nation.read_on, '2026-11-16');
  assert.equal(nation.window_start, '2025-11-16');
  assert.match(nation.national_counts_are, /not the states' counts added together/);

  const counts = await out('shortage_area_changes', { state: 'ri' });
  assert.deepEqual(counts.counts, states.states.RI);
  assert.equal(counts.counts.designations['hpsa-pc']['Proposed For Withdrawal'].designations, 3);
  assert.equal(counts.counts.sites_added_to_scope_in_window, 8);
  assert.equal(counts.clinx_page, 'https://clinx.org/health-centers/shortage-areas/ri/');
  assert.equal(counts.whole_file, 'https://clinx.org/data/health-centers/areas/states/ri.json');
  assert.match(counts.updated_means, /does not say what was updated/);

  const recent = await out('shortage_area_changes', { state: 'RI', show: 'recent', limit: 100 });
  assert.equal(recent.matched, ri.recent.length);
  assert.deepEqual(recent.designations.map((r) => r.event_date_iso), ri.recent.map((r) => r.event_date_iso).sort().reverse());
  const first = ri.recent.find((r) => r.id === recent.designations[0].id && r.event === recent.designations[0].event);
  assert.equal(recent.designations[0].score, first.score);
  assert.equal(recent.designations[0].name, first.name);
  const designated = await out('shortage_area_changes', { state: 'RI', show: 'recent', event: 'designated', kind: 'hpsa-dh' });
  assert.equal(designated.matched, states.states.RI.recent_events['hpsa-dh'].designated);
  assert.ok(designated.designations.every((r) => r.kind === 'hpsa-dh' && r.event === 'designated'));

  const proposed = await out('shortage_area_changes', { state: 'RI', show: 'proposed' });
  assert.equal(proposed.matched, 5);
  assert.ok(proposed.designations.every((r) => r.status === 'Proposed For Withdrawal'));
  assert.equal((await out('shortage_area_changes', { state: 'RI', show: 'proposed', kind: 'hpsa-pc' })).matched, 3);
  assert.equal((await out('shortage_area_changes', { state: 'RI', show: 'proposed', text: 'woonsocket' })).matched, ri.proposed.filter((r) => /woonsocket/i.test(`${r.name} ${r.counties}`)).length);

  const sites = await out('shortage_area_changes', { state: 'RI', show: 'sites' });
  assert.equal(sites.matched, 8);
  assert.ok(sites.sites.every((s) => s.reason === 'added to scope in the last 365 days' && s.site_name));
  const warwick = await out('shortage_area_changes', { state: 'RI', show: 'sites', text: 'warwick' });
  assert.equal(warwick.matched, 4);
  assert.ok(warwick.sites.every((s) => s.city === 'Warwick'));
  assert.equal((await out('shortage_area_changes', { state: 'RI', show: 'sites', text: 'comprehensive warwick' })).matched, 1);

  assert.match((await out('shortage_area_changes', { state: 'XX' })).note, /XX is the code HRSA writes where a row names no state/);
  assert.match(await refused('shortage_area_changes', { state: 'TX' }), /no shortage area counts for TX; the codes held are: MA, PR, RI, XX/);
  assert.match(await refused('shortage_area_changes', { show: 'recent' }), /state is required for a list/);
  assert.match(await refused('shortage_area_changes', { state: 'RI', event: 'designated' }), /go with a list/);
  assert.match(await refused('shortage_area_changes', { state: 'RI', show: 'sites', kind: 'mua' }), /a site has no kind of designation/);
  assert.match(await refused('shortage_area_changes', { state: 'RI', show: 'proposed', event: 'updated' }), /event goes with show recent/);
  assert.doesNotMatch(JSON.stringify([nation, counts, recent, proposed, sites]), NEVER);
});

test('about_the_data describes the health center sets, and state_overview points at their tools', async () => {
  const about = await out('about_the_data');
  const hc = about.health_centers;
  assert.equal(hc.records.health_centers, 45);
  assert.deepEqual(hc.records.states, ['MA', 'RI']);
  assert.equal(hc.records.read_on, '2026-11-16');
  assert.match(hc.records.source, /HRSA/);
  assert.deepEqual(Object.keys(hc.records.marks), ['-', '--', '---']);
  assert.match(hc.records.other_cells_without_a_value['withheld by ClinX'], /1 to 15/);
  assert.equal(hc.funding.opportunities, 49);
  assert.equal(hc.funding.read_on, '2026-11-16');
  assert.match(hc.funding.source, /Grants\.gov/);
  assert.equal(hc.shortage_areas.states_and_territories, 60);
  assert.equal(hc.shortage_areas.read_on, '2026-11-16');
  assert.match(hc.what_clinx_does_not_do, /does not rank or judge a health center/);
  assert.match(about.what, /health center/);
  assert.equal(about.counts.laws > 0, true);
  assert.doesNotMatch(JSON.stringify(hc), NEVER);

  const ri = await out('state_overview', { state: 'RI' });
  assert.match(ri.health_centers, /find_health_centers and shortage_area_changes with state RI/);
  assert.equal((await out('state_overview', { state: 'US' })).health_centers, undefined);
  assert.equal((await out('state_overview', { state: 'FED' })).health_centers, undefined);
});

test('a health center file is read only when a health center tool asks for it', async () => {
  const asked = [];
  const call = callOn(tablesWith({ asked }));
  await call('find_bills', { state: 'RI' });
  await call('state_overview', { state: 'RI' });
  assert.deepEqual(asked.filter((name) => name.startsWith('health-centers/')), []);
  await call('find_health_centers');
  assert.deepEqual(asked.filter((name) => name.startsWith('health-centers/')), [HC_FILES.records]);
  await call('get_health_center_report', { health_center: '01E00040', table: 'Table 3A' });
  await call('get_health_center_report', { health_center: '01E00040' });
  assert.deepEqual(asked.filter((name) => name.startsWith('health-centers/')), [HC_FILES.records, HC_FILES.lines, 'health-centers/records/centers/01e00040.json']);
  await call('shortage_area_changes', { state: 'RI', show: 'proposed' });
  await call('shortage_area_changes', { state: 'RI', show: 'sites' });
  assert.deepEqual(asked.filter((name) => name.startsWith('health-centers/areas/')), [HC_FILES.areas, 'health-centers/areas/states/ri.json']);
  await call('about_the_data');
  assert.equal(asked.filter((name) => name === HC_FILES.sets).length, 1);
});

test('a health center file that cannot be read: its tool says so plainly and every other tool goes on answering', async () => {
  const every = [...Object.values(HC_FILES), centerFile('010120'), areaFile('RI')];
  const call = callOn(tablesWith({ unreadable: every }));
  const said = async (name, args) => {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    return result.content[0].text;
  };
  assert.equal(await said('find_health_centers'), HC_UNREAD.records);
  assert.equal(await said('get_health_center_report', { health_center: '010120' }), HC_UNREAD.records);
  assert.equal(await said('find_funding_opportunities'), HC_UNREAD.funding);
  assert.equal(await said('health_center_calendar'), HC_UNREAD.calendar);
  assert.equal(await said('shortage_area_changes'), HC_UNREAD.areas);
  assert.equal(await said('shortage_area_changes', { state: 'RI' }), HC_UNREAD.areas);
  for (const message of Object.values(HC_UNREAD)) {
    assert.match(message, /could not be read just now.*The other tools still work\. Try again in a minute\.$/);
    assert.doesNotMatch(message, NEVER);
  }
  // The 340B tools are not touched, and about_the_data says which part is missing.
  assert.equal((await call('find_bills', { state: 'RI' })).isError, false);
  assert.equal((await call('find_filings', { state: 'RI' })).isError, false);
  const about = read(await call('about_the_data'));
  assert.deepEqual(about.health_centers, { unavailable: HC_UNREAD.sets });
  assert.ok(about.counts.bills > 0);

  // One piece at a time: the dictionary of lines, one health center's file, one state's file, the file of days.
  assert.equal((await callOn(tablesWith({ unreadable: [HC_FILES.lines] }))('get_health_center_report', { health_center: '010120' })).content[0].text, HC_UNREAD.lines);
  const noCenter = callOn(tablesWith({ unreadable: [centerFile('010120')] }));
  assert.equal((await noCenter('get_health_center_report', { health_center: '010120' })).content[0].text, HC_UNREAD.center);
  assert.equal((await noCenter('get_health_center_report', { health_center: '010480' })).isError, false);
  const noState = callOn(tablesWith({ unreadable: [areaFile('RI')] }));
  assert.equal((await noState('shortage_area_changes', { state: 'RI', show: 'recent' })).content[0].text, HC_UNREAD.area);
  assert.equal((await noState('shortage_area_changes', { state: 'RI' })).isError, false);
  const noDays = callOn(tablesWith({ unreadable: [HC_FILES.sets] }));
  const funding = read(await noDays('find_funding_opportunities'));
  assert.equal(funding.matched, 5);
  assert.equal(funding.read_on, undefined);
  assert.match(funding.read_on_unknown, /could not be read just now/);
  const nation = read(await noDays('shortage_area_changes'));
  assert.deepEqual(nation.national_counts, { unavailable: HC_UNREAD.sets });
  assert.equal(nation.read_on, '2026-11-16');

  // A file that is not the file expected counts as unreadable.
  const wrong = callOn(tablesWith({ change: (name, file) => (name === HC_FILES.records ? { health_centers: 'none' } : file) }));
  assert.equal((await wrong('find_health_centers')).content[0].text, HC_UNREAD.records);
});

test('a file that could not be read is tried again after a minute, and a file held is kept for an hour', async () => {
  let clock = Date.parse(`${TODAY}T12:00:00Z`);
  let broken = true;
  const asked = [];
  const fetcher = async (url) => {
    const name = String(url).slice(SOURCE.length);
    asked.push(name);
    if (broken && name === HC_FILES.records) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => JSON.parse(await readFile(`${DATA}/${name}`, 'utf8')) };
  };
  const call = callOn(makeTables({ source: SOURCE, fetcher, now: () => clock }));
  const reads = () => asked.filter((name) => name === HC_FILES.records).length;
  assert.equal((await call('find_health_centers')).isError, true);
  assert.equal((await call('find_health_centers')).isError, true);
  assert.equal(reads(), 1);
  broken = false;
  clock += 61 * 1000;
  assert.equal((await call('find_health_centers')).isError, false);
  assert.equal(reads(), 2);
  clock += 30 * 60 * 1000;
  await call('find_health_centers');
  assert.equal(reads(), 2);
  clock += 31 * 60 * 1000;
  await call('find_health_centers');
  assert.equal(reads(), 3);
});

test('health center questions are counted by kind only: no typed word, no key, and an unreadable file as unreachable', async () => {
  const ask = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tables = localTables({ folder: DATA, now });
  const message = ask('get_health_center_report', { health_center: '010120', table: 'Table 3A', text: 'total' });
  const counted = describeRequest(message, await handle(message, tables));
  assert.deepEqual(counted, { method: 'tools/call', tool: 'get_health_center_report', outcome: 'answered', place: '', filters: 'health_center table text', looked_up: '', client: '', version: '' });
  const areas = ask('shortage_area_changes', { state: 'RI', show: 'recent', kind: 'mua', text: 'providence' });
  assert.deepEqual(describeRequest(areas, await handle(areas, tables)), { method: 'tools/call', tool: 'shortage_area_changes', outcome: 'answered', place: 'RI', filters: 'kind=mua show=recent text', looked_up: '', client: '', version: '' });
  const down = tablesWith({ unreadable: [HC_FILES.opportunities] });
  const funding = ask('find_funding_opportunities', { health_center_program: true });
  assert.equal(describeRequest(funding, await handle(funding, down)).outcome, 'tables unreachable');
  assert.equal(describeRequest(funding, await handle(funding, down)).filters, 'health_center_program=true');
});

test('no answer of a health center tool holds a web address of an agency contact, an email address or a phone number', async () => {
  const answers = [
    await out('find_health_centers', { limit: 100 }),
    await out('get_health_center_report', { health_center: '010480' }),
    await out('get_health_center_report', { health_center: '010480', table: 'Table 9E' }),
    await out('find_funding_opportunities', { limit: 100 }),
    ...(await Promise.all(['363111', '363419', '363421', '363546', '363324'].map((id) => out('find_funding_opportunities', { opportunity: id })))),
    await out('health_center_calendar', { from: '2026-01-01', limit: 100 }),
    await out('shortage_area_changes', { state: 'RI', show: 'sites' }),
  ];
  const said = JSON.stringify(answers);
  assert.doesNotMatch(said, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(said, /\(?\b\d{3}\)?[ .-]\d{3}[.-]\d{4}\b/);
});
