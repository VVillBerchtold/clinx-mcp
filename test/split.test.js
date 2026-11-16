// The filed reports read one report at a time: the index and a report's own file, and the whole
// file as the fallback. Both ways must give the same answers. The small copies in test/data are
// used (the older tables, plus a sample of dataset 0.8.0 in 340b-more-filings.json: five Ohio
// workbooks, Minnesota's earlier year and Maine). No network is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/core.js';
import { makeTables, FILES, reportFile } from '../src/tables.js';
import { split, readReport } from '../src/split.js';
import { filingPath, filingSlug, latestYears } from '../src/pages.js';
import { REPORT_UNREAD, FILING_LINES } from '../src/tools.js';

const DATA = fileURLToPath(new URL('./data', import.meta.url));
const TODAY = '2026-11-16';
let clock = Date.parse(`${TODAY}T12:00:00Z`);
const now = () => clock;
const json = async (name) => JSON.parse(await readFile(`${DATA}/${name}`, 'utf8'));

/** The older fixture and the 0.8.0 sample, as one filings file. */
async function whole() {
  const base = await json(FILES.filings);
  const more = await json('340b-more-filings.json');
  const merged = { ...base, dataset_version: more.dataset_version };
  for (const key of ['filings', 'entities', 'line_items', 'discrepancies', 'measures', 'attachments', 'vendors']) merged[key] = [...base[key], ...(more[key] ?? [])];
  return merged;
}

/**
 * Tables over the merged file. `mode` is 'split' (the index and one file for each report, the
 * way clinx.org serves them) or 'whole' (only the whole file). `log` collects every name read.
 */
async function tablesOf(mode, { log = [], change = (name, file) => file, file } = {}) {
  const merged = file ?? (await whole());
  const cut = split(merged);
  const reader = async (name) => {
    log.push(name);
    let answer;
    if (name === FILES.filings) answer = merged;
    else if (name === FILES.filingsIndex && mode === 'split') answer = cut.index;
    else if (name.startsWith('filings/') && mode === 'split') {
      const doc = cut.reports[name.slice('filings/'.length, -'.json'.length)];
      if (!doc) throw new Error(`${name} answered 404`);
      answer = doc;
    } else if (Object.values(FILES).includes(name) && name !== FILES.filingsIndex) answer = await json(name);
    else throw new Error(`${name} answered 404`);
    return structuredClone(change(name, answer));
  };
  return makeTables({ reader, now });
}
const ask = (tables) => async (name, args = {}) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tables)).result;
const out = (tables) => async (name, args) => (await ask(tables)(name, args)).structuredContent;

/** One report read part by part, the largest part each time, until the answer offers no more: every part, in order. */
async function partsOf(call, filingId) {
  const parts = [await call('get_filing', { filing_id: filingId, limit: FILING_LINES.most })];
  while (parts.at(-1).more !== undefined) {
    parts.push(await call('get_filing', { filing_id: filingId, limit: FILING_LINES.most, offset: parts.reduce((n, part) => n + part.lines.length, 0) }));
  }
  return parts;
}
/** The first part's answer with every line of the report in it. */
const wholeReport = async (call, filingId) => {
  const parts = await partsOf(call, filingId);
  return { ...parts[0], lines: parts.flatMap((part) => part.lines) };
};

test('split: an index with every record and none of the lines, and a file for each report', async () => {
  const merged = await whole();
  const { index, reports } = split(merged);
  assert.equal(index.filings.length, merged.filings.length);
  assert.equal(Object.keys(reports).length, merged.filings.length);
  assert.equal(index.dataset_version, '0.8.0');
  assert.doesNotMatch(JSON.stringify(index), /"lines"|"line_items"/);
  assert.ok(JSON.stringify(index).length < 400000, 'the index stays small');
  let lines = 0;
  for (const f of index.filings) {
    const report = reports[f.filing_id];
    assert.equal(f.line_count, report.lines.length, f.filing_id);
    assert.equal(f.discrepancy_count, report.discrepancies.length, f.filing_id);
    assert.equal(report.filing_id, f.filing_id);
    assert.ok(f.entity && f.entity.entity_id === f.entity_id, 'each record carries its entity');
    lines += report.lines.length;
  }
  assert.equal(lines, merged.line_items.length, 'every line is in exactly one report');
  // A line keeps its order and its figures as the file has them.
  const first = merged.line_items.filter((l) => l.filing_id === 'oh-2025-ch050990');
  const kept = reports['oh-2025-ch050990'].lines;
  assert.equal(kept.length, first.length);
  assert.equal(kept[0].source_cell, first[0].source_cell);
  assert.equal(kept[0].amount_as_filed, first[0].amount_as_filed);
});

test('split: a small claim count never passes, whatever the file says, in either path a line takes', async () => {
  const merged = await whole();
  const row = merged.line_items.find((l) => l.filing_id === 'ri-2025-wellone' && l.claims !== '' && l.schedule === 'C');
  row.claims = '4';
  row.claims_as_filed = '4';
  row.claims_withheld = '';
  const { reports } = split(merged);
  const line = reports['ri-2025-wellone'].lines[merged.line_items.filter((l) => l.filing_id === 'ri-2025-wellone').indexOf(row)];
  assert.equal(line.claims, undefined);
  assert.equal(line.claims_as_filed, undefined);
  assert.equal(line.claims_withheld, 'fewer_than_6');
  // A report's file written by someone else, with the count left in, is cut the same way when it is read.
  const read = readReport({ lines: [{ schedule: 'C', line: '1', claims: '2', claims_as_filed: '2', unit: 'usd', amount: '10', amount_as_filed: '10' }], discrepancies: [] });
  assert.deepEqual(read.lines[0], { schedule: 'C', line: '1', unit: 'usd', amount: '10', amount_as_filed: '10', claims_withheld: 'fewer_than_6' });
  // A withheld count on a workbook form (no claims column) leaves no figure in the amount either.
  const workbook = readReport({ lines: [{ schedule: 'x', line: 'y', unit: 'count', amount: '3', amount_as_filed: '3', claims_withheld: 'fewer_than_6' }], discrepancies: [] });
  assert.equal(workbook.lines[0].amount, undefined);
  assert.equal(workbook.lines[0].amount_as_filed, undefined);
  assert.throws(() => split({ hello: 'world' }), /not in the shape expected/);
  assert.throws(() => readReport({ hello: 'world' }), /not in the shape expected/);
});

test('both ways give the same answers: the index and one report at a time, or the whole file', async () => {
  const fast = await tablesOf('split');
  const slow = await tablesOf('whole');
  const a = ask(fast);
  const b = ask(slow);
  const ids = (await whole()).filings.map((f) => f.filing_id);
  assert.equal(ids.length, 64);
  let lines = 0;
  for (const id of ids) {
    assert.equal((await a('get_filing', { filing_id: id })).isError, false, id);
    const x = await partsOf(out(fast), id);
    const y = await partsOf(out(slow), id);
    assert.deepEqual(x, y, id);
    assert.equal(x.reduce((n, part) => n + part.lines.length, 0), x[0].lines_total, `${id}: every line is read once`);
    lines += x[0].lines_total;
  }
  assert.ok(lines > 3321, 'every line of every sample report was compared');
  for (const [name, args] of [['find_filings', { limit: 100 }], ['find_filings', { state: 'OH', limit: 100 }], ['state_overview', { state: 'OH' }], ['state_overview', { state: 'MN' }], ['about_the_data', {}], ['reporting_states', {}]]) {
    assert.deepEqual((await a(name, args)).structuredContent, (await b(name, args)).structuredContent, name);
  }
});

test('the index is read, a report only when it is asked for, and a few reports are kept for an hour', async () => {
  const log = [];
  const tables = await tablesOf('split', { log });
  const call = ask(tables);
  await call('find_filings', { state: 'OH' });
  await call('state_overview', { state: 'RI' });
  assert.ok(log.includes(FILES.filingsIndex));
  assert.ok(!log.includes(FILES.filings), 'the whole file is not read when the index can be');
  assert.equal(log.filter((n) => n.startsWith('filings/')).length, 0, 'no report is read to list reports');
  await call('get_filing', { filing_id: 'oh-2025-ch050990' });
  await call('get_filing', { filing_id: 'OH-2025-CH050990', offset: 100 });
  assert.deepEqual(log.filter((n) => n.startsWith('filings/')), [reportFile('oh-2025-ch050990')], 'one report, read once, then kept');
  // Nine different reports: the first is no longer kept.
  const ids = ['oh-2025-dsh360059', 'oh-2025-dsh361307', 'oh-2025-chc0823800', 'oh-2025-tb452022std452191', 'mn-2023-statewide', 'me-2024-statewide', 'id-2025-statewide', 'ri-2025-wellone'];
  for (const id of ids) await call('get_filing', { filing_id: id, limit: 1 });
  const before = log.length;
  await call('get_filing', { filing_id: 'oh-2025-ch050990', limit: 1 });
  assert.equal(log.length, before + 1, 'the least recent report was dropped and is read again');
  await call('get_filing', { filing_id: 'ri-2025-wellone', limit: 1 });
  assert.equal(log.length, before + 1, 'a recent one is still held');
  clock += 61 * 60 * 1000;
  await call('get_filing', { filing_id: 'ri-2025-wellone', limit: 1 });
  assert.ok(log.filter((n) => n === reportFile('ri-2025-wellone')).length >= 2, 'read again after an hour');
  assert.equal(log.filter((n) => n === FILES.filingsIndex).length, 2, 'the index is read again after an hour');
  clock = Date.parse(`${TODAY}T12:00:00Z`);
});

test('fallback: when the index cannot be read, the whole file is read and cut with the same function', async () => {
  const log = [];
  const tables = await tablesOf('whole', { log });
  const found = (await out(tables)('find_filings', { state: 'OH', limit: 100 }));
  assert.equal(found.matched, 6);
  assert.ok(log.includes(FILES.filingsIndex) && log.includes(FILES.filings));
  const one = await out(tables)('get_filing', { filing_id: 'oh-2025-ch050990', limit: 150 });
  assert.ok(one.lines.length > 100);
  assert.equal(log.filter((n) => n.startsWith('filings/')).length, 0, 'no report file is asked for');
  // A file at the index's name that is not an index counts as unreadable too.
  const odd = await tablesOf('split', { change: (name, file) => (name === FILES.filingsIndex ? { hello: 'world' } : file) });
  assert.equal((await out(odd)('find_filings', { state: 'OH', limit: 100 })).matched, 6);
});

test('a report whose own file cannot be read says so for that report only', async () => {
  const tables = await tablesOf('split', { change: (name, file) => { if (name === reportFile('oh-2025-ch050990')) throw new Error('gone'); return file; } });
  const call = ask(tables);
  const bad = await call('get_filing', { filing_id: 'oh-2025-ch050990' });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, REPORT_UNREAD);
  assert.equal((await call('get_filing', { filing_id: 'oh-2025-dsh360059', limit: 1 })).isError, false);
  assert.equal((await call('find_filings', { state: 'OH' })).isError, false);
  const broken = await tablesOf('split', { change: (name, file) => (name === reportFile('oh-2025-dsh360059') ? { hello: 'world' } : file) });
  assert.equal((await ask(broken)('get_filing', { filing_id: 'oh-2025-dsh360059' })).content[0].text, REPORT_UNREAD);
});

test('the file names are written once, and the site can write each report\'s file name', () => {
  assert.equal(FILES.filingsIndex, '340b-filings-index.json');
  assert.equal(FILES.filings, '340b-state-filings.json', 'the whole file stays, as a download and as the fallback');
  assert.equal(reportFile('OH-2025-CAH361302'), 'filings/oh-2025-cah361302.json');
});

test('the page of a report: one record of each kind, and no two filers on one address', async () => {
  const merged = await whole();
  const latest = latestYears(merged.filings);
  const page = (id) => filingPath(merged.filings.find((f) => f.filing_id === id), latest);
  assert.equal(page('ri-2025-east-bay-cap'), '/scorecard/ri/east-bay-cap/', 'a filer\'s own report');
  assert.equal(page('vt-2025-gifford'), '/scorecard/vt/gifford/');
  assert.equal(page('oh-2025-ch050990'), '/scorecard/oh/ch050990/', 'an Ohio workbook, by the ID in its file name');
  assert.equal(page('oh-2025-dsh360059-and-fqhcla415'), '/scorecard/oh/dsh360059-and-fqhcla415/', 'a workbook for more than one ID');
  assert.equal(page('oh-2025-dsh361307'), '/scorecard/oh/dsh361307/', 'the address follows the file name, which is not always the entity\'s ID');
  assert.equal(page('mn-2024-abbott-northwestern') ?? '', '/scorecard/mn/', 'a row a state printed, latest year');
  assert.equal(page('mn-2024-statewide'), '/scorecard/mn/');
  assert.equal(page('mn-2023-abbott-northwestern'), '/scorecard/mn/2023/', 'a state\'s earlier year has its own page');
  assert.equal(page('mn-2023-statewide'), '/scorecard/mn/2023/');
  assert.equal(page('me-2024-statewide'), '/scorecard/me/', 'a state with one year');
  assert.equal(page('id-2025-statewide'), '/scorecard/id/', 'a state\'s totals');
  const seen = new Map();
  for (const f of merged.filings) {
    const path = filingPath(f, latest);
    if (f.record_kind !== 'filing') continue;
    assert.ok(!seen.has(path), `${f.filing_id} and ${seen.get(path)} share ${path}`);
    seen.set(path, f.filing_id);
  }
  assert.equal(filingSlug({ filing_id: 'oh-2025-cah361302', state: 'OH', reporting_year: '2025' }), 'cah361302');
  // The same addresses come out of the tools.
  const call = out(await tablesOf('split'));
  const mn = await call('find_filings', { state: 'MN', year: 2023, limit: 100 });
  assert.ok(mn.filings.length === 2 && mn.filings.every((f) => f.clinx_page === 'https://clinx.org/scorecard/mn/2023/'));
  const oh = await call('get_filing', { filing_id: 'oh-2025-dsh360059-and-fqhcla415', limit: 1 });
  assert.equal(oh.clinx_page, 'https://clinx.org/scorecard/oh/dsh360059-and-fqhcla415/');
  assert.equal(oh.filing.clinx_page, oh.clinx_page);
});

test('Ohio: the name is HRSA\'s and says so, and a filer is found by that name and by its 340B ID', async () => {
  const call = out(await tablesOf('split'));
  const byName = await call('find_filings', { entity: 'metrohealth' });
  assert.deepEqual(byName.filings.map((f) => f.filing_id).sort(), ['oh-2025-dsh360059', 'oh-2025-dsh360059-and-fqhcla415']);
  const f = byName.filings.find((x) => x.filing_id === 'oh-2025-dsh360059');
  assert.equal(f.entity, undefined, 'the filer printed no name, and none is given as if it had');
  assert.equal(f.hrsa_name, 'METROHEALTH MEDICAL CENTER');
  assert.equal(f.hrsa_list_date, '2026-11-11');
  assert.match(f.name_source, /^The name is HRSA's, from its public list of covered entities read on 2026-11-11\. The official file prints the 340B ID and no name\.$/);
  assert.equal(f.entity_type, 'not_stated');
  const byId = await call('find_filings', { entity: 'std452191' });
  assert.deepEqual(byId.filings.map((x) => x.filing_id), ['oh-2025-tb452022std452191']);
  assert.equal(byId.filings[0].other_entity_ids, 'oh-std452191');
  const spelled = await call('find_filings', { entity: 'CH050990' });
  assert.deepEqual(spelled.filings.map((x) => x.filing_id), ['oh-2025-ch050990']);
  const noName = await call('find_filings', { entity: 'chc08238' });
  assert.deepEqual(noName.filings.map((x) => [x.filing_id, x.hrsa_name]), [['oh-2025-chc0823800', undefined]], 'an ID that is not in HRSA\'s list has no name');
  assert.equal((await call('find_filings', { state: 'OH', entity_type: 'not_stated', limit: 100 })).matched, 6);
});

test('Ohio: get_filing gives the workbook\'s cells, how they were read, and why a figure is withheld', async () => {
  const call = out(await tablesOf('split'));
  const one = await wholeReport(call, 'oh-2025-ch050990');
  assert.equal(one.lines.length, one.lines_total);
  assert.equal(one.official_file.pages, undefined, 'a workbook has no pages');
  assert.match(one.official_file.kind, /Excel workbook/);
  assert.match(one.official_file.kind, /State's own website/);
  assert.match(one.official_file.url, /^https:\/\//);
  assert.match(one.official_file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof one.official_file.bytes, 'number');
  assert.ok(one.lines.every((l) => /^[A-Z]+\d+$/.test(l.source_cell)), 'every line says which cell it was read from');
  assert.equal(one.filing.hrsa_name, 'HEALTHSOURCE OF OHIO INC (HEALTHSOURCE OF OHIO, INC.)');
  assert.equal(one.filing.entity.name_as_filed, undefined);
  assert.equal(one.filing.page_count, undefined);
  assert.equal(one.checked.by_verification.two_file_reads, one.checked.lines);
  assert.match(one.checked.meaning.two_file_reads, /Two separate programs read the cell and they agree/);
  assert.match(one.checked.meaning.two_file_reads, /no page image/);
  assert.match(one.checked.how, /Excel workbook/);
  assert.doesNotMatch(one.checked.how, /transcribed/);
  assert.deepEqual(Object.keys(one.withheld.by_reason).sort(), ['beside_small', 'fewer_than_6', 'reveals_small']);
  assert.match(one.withheld.why.reveals_small, /percentage/);
  assert.match(one.withheld.why.reveals_small, /1 to 5/);
  const withheld = one.lines.filter((l) => l.claims_withheld);
  assert.ok(withheld.length > 0);
  assert.ok(withheld.every((l) => l.amount === undefined && l.amount_as_filed === undefined && l.claims === undefined), 'a withheld cell carries no figure');
  assert.ok(one.discrepancies.count === 4 && one.discrepancies.rows.every((d) => d.note), 'the dataset\'s notes are given');
  assert.match(one.how_to_read_lines, /source_cell/);
  // A cell that holds words where a figure belongs keeps the words.
  const words = (await wholeReport(call, 'oh-2025-dsh360059-and-fqhcla415')).lines.find((l) => l.unit === 'usd' && l.amount === undefined && l.amount_as_filed);
  assert.ok(words, 'a words-only cell');
  assert.ok(Number.isNaN(Number(words.amount_as_filed)));
  const two = await call('get_filing', { filing_id: 'oh-2025-tb452022std452191', limit: 1 });
  assert.equal(two.filing.other_entity_ids, 'oh-std452191');
  assert.equal(two.filing.hrsa_name, 'HAMILTON COUNTY General Health District (TB CONTROL CLINIC)');
});

test('Ohio: no answer for any sample report shows a count of 1 to 5 where one is withheld', async () => {
  const call = out(await tablesOf('split'));
  for (const id of ['oh-2025-ch050990', 'oh-2025-chc0823800', 'oh-2025-dsh360059', 'oh-2025-tb452022std452191']) {
    const answer = await wholeReport(call, id);
    assert.equal(answer.lines.length, answer.lines_total, id);
    for (const l of answer.lines.filter((x) => x.claims_withheld)) assert.equal(l.amount ?? l.claims ?? null, null, `${id} ${l.source_cell}`);
    assert.doesNotMatch(JSON.stringify(answer), /"claims(_as_filed)?":"[1-5]"/);
  }
});

test('a folder on disk works both ways: with the index and report files, and with the whole file only', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { localTables } = await import('../src/disk.js');
  const merged = await whole();
  const cut = split(merged);
  const folder = await mkdtemp(join(tmpdir(), 'clinx-mcp-test-'));
  try {
    for (const name of Object.values(FILES)) if (name !== FILES.filings && name !== FILES.filingsIndex) await writeFile(join(folder, name), JSON.stringify(await json(name)));
    await writeFile(join(folder, FILES.filings), JSON.stringify(merged));
    const plain = await out(localTables({ folder, now }))('get_filing', { filing_id: 'oh-2025-ch050990', limit: 5 });
    assert.equal(plain.lines.length, 5);
    await mkdir(join(folder, 'filings'));
    await writeFile(join(folder, FILES.filingsIndex), JSON.stringify(cut.index));
    await writeFile(join(folder, reportFile('oh-2025-ch050990')), JSON.stringify(cut.reports['oh-2025-ch050990']));
    await rm(join(folder, FILES.filings));
    const indexed = await out(localTables({ folder, now }))('get_filing', { filing_id: 'oh-2025-ch050990', limit: 5 });
    assert.deepEqual(indexed.lines, plain.lines);
    const missing = await ask(localTables({ folder, now }))('get_filing', { filing_id: 'oh-2025-dsh360059' });
    assert.equal(missing.content[0].text, REPORT_UNREAD, 'a report with no file in the folder says so');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
