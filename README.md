# ClinX 340B server

A small program that lets an AI assistant look things up in ClinX's open tables about the federal
340B drug pricing program: the state laws on the books, the bills in Congress and the state
legislatures, the rules and notices federal agencies publish, the reports that hospitals, health
centers and states have filed about 340B, and a calendar of their dates.

**Status: running at `https://clinx.org/mcp` since 15 November 2026.** Give that address to an
assistant that accepts connectors (MCP servers); there is no key and no account. It is not
published as a package yet, so to run your own copy you start it yourself, as shown below.

## What it is, in plain words

Assistants such as Claude can be given "tools": small lookups they may call while answering a
question. The Model Context Protocol (MCP) is the common way to offer such tools. This is an MCP
server with twelve of them.

Ask an assistant "which states passed a contract pharmacy law this year?" and, with this server
connected, it does not have to guess or search the web. It asks the server, gets rows from the
same tables anyone can download from [clinx.org/data](https://clinx.org/data/), and answers with
the link to each official page.

The server holds no data of its own. It reads the six public files from clinx.org, keeps them
in memory for an hour, and answers from that copy. It only reads. It has no sign-in, no key, no
account, and it keeps nothing about who asked what.

## The twelve tools

| Tool | What it answers |
| --- | --- |
| `find_laws` | State laws on the books that name 340B, by state, kind or words. |
| `get_law` | One law in full: citation, who it binds, what it limits, how it is enforced, dates, the passage that names 340B. |
| `find_bills` | Bills that name 340B, by state (or `US` for Congress), stage, role, kind or words. |
| `get_bill` | One bill in full, with its sponsor, stage, latest step and every dated step. |
| `find_notices` | Federal rules, proposed rules and notices that name 340B, by kind of document, role, words, day of publication, or whether comments are still open. |
| `get_notice` | One rule or notice in full: the agency that wrote it, what it does about 340B, its comment deadline, the day it takes effect and every other day it sets. |
| `calendar` | Dated steps, hearings, session days and federal dates. With no dates given: what is coming up from today. |
| `reporting_states` | The states whose law requires 340B reports, grouped by what the public can see, with what is public, where it stands, whether ClinX holds the figures, and the official sources. Filter by state or group. |
| `find_filings` | Filed reports, by state, year, entity name or 340B ID, entity type, kind of record or form. Short rows with the ClinX page and the official source; says plainly when a list is cut short. |
| `get_filing` | One filed report in full: every line as filed with its label, unit and amount, which claim counts are withheld and why, how the figures were checked, recorded discrepancies, and the official file's address, size and SHA-256. A very long report comes in parts. |
| `state_overview` | One place at a glance: a state's laws, its bills by stage, which group of reporting states it is in, how many filed reports ClinX holds for it, and what is next. `FED` gives the federal agencies. |
| `about_the_data` | Where the tables come from, when each was last brought up to date, what the filed reports table holds, the licence. |

### The filed reports

The Scorecard at clinx.org holds the reports that covered entities and states file about 340B.
Three tools open it.

- Every figure is given exactly as the official file prints it. Columns ending `_as_filed` hold
  the printed text; `amount` and `claims` hold the same figure as a number, written as text just
  as the table has it. The server never rounds, estimates or fills in a figure.
- A claim count of 1 to 5 is never given, and neither is anything that would let a reader work
  one out. A row with a withheld count says `claims_withheld`, and the answer explains each
  reason. Every other figure on the row stays as filed. The server also holds back a small count
  that a file forgot to mark.
- The server ranks no one and calls no filer better or worse than another. It adds no sums.
  The three measures a report may carry (gross margin, external cost and the share) are the
  dataset's own, worked out from that one report's lines.
- A "filing" here is one record: a filer's own report, a row a state printed about one filer
  in its own report, or a state's totals. A filer's own report has a page on the site; a row a
  state printed, or a state's totals, points to the page of that state's reports.
- The tools are written for any form, kind of record and entity type the table holds. A value
  the code has not seen is returned as it is, with its own words.
- A report with many lines (the largest today has 1,030) comes in parts of 250 lines. The
  answer lists the report's schedules and says how to ask for the next part or for one schedule.

Questions to try: "Which states require 340B reports, and which of them publish a report for
each hospital?" (`reporting_states`); "Find the 2025 reports filed in Rhode Island by health
centers" (`find_filings`); "What did the Idaho 2025 report print for total claims, and were
there any differences between its figures?" (`get_filing`).

A bill at the stage `Did not pass` ended without becoming law; it is finished, and no tool shows
it as pending. The calendar has a kind `report due` for the day a state's report is due.

Every row in an answer carries the link to the official page it came from, and every answer says
the day its table was last brought up to date. The plain sentences about each law, bill and
notice were written by a person reading the official text. They are a reading aid, not legal
advice, and a bill's sentence can trail a newer version of its text. Dates on the calendar can
move.

Three codes name a place. A state has its two letters, such as `RI`. Congress is `US`. Federal
agencies, which write rules and notices and not bills, are `FED`.

"Coming up" and "open for comment" go by the day the question is asked, not by the day the
tables were last brought up to date. A federal notice nobody has read yet is still listed, with
the Federal Register's own facts and no sentence; the answer says so.

A mistake in what was asked (a state that is not a two-letter code, a date in the wrong shape, a
bill that is not in the table) is said back in plain words, so the assistant can correct itself.

## Try it

**The quick way.** Give an assistant the address `https://clinx.org/mcp` as a connector (an MCP
server) and ask it a question. Nothing to install.

**Your own copy.** You need [Node.js](https://nodejs.org) 20 or newer. Nothing else is
installed: the server uses no outside packages.

    git clone https://github.com/VVillBerchtold/clinx-mcp.git
    cd clinx-mcp
    npm test

**As a helper program for an assistant app.** Most apps take a small piece of configuration that
names the program to start. For Claude Desktop and similar apps:

```json
{
  "mcpServers": {
    "clinx-340b": {
      "command": "node",
      "args": ["/full/path/to/clinx-mcp/src/stdio.js"]
    }
  }
}
```

For Claude Code:

    claude mcp add clinx-340b -- node /full/path/to/clinx-mcp/src/stdio.js

**Over the web, on your own computer.**

    node src/serve.js

It listens at `http://127.0.0.1:8340/mcp`, on your computer only. Ask it something with `curl`:

    curl -s http://127.0.0.1:8340/mcp -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"state_overview","arguments":{"state":"RI"}}}'

**From files on disk instead of clinx.org.** Set `CLINX_DATA_DIR` to a folder that holds
`340b-state-laws.json`, `340b-bills.json`, `340b-notices.json` and `340b-events.json`, and
if you want the filed reports, `340b-state-filings.json` and `340b-reporting-states.json`. The
last two are read on their own: if either is missing or cannot be read, the other nine tools
answer as before and the three new ones say the file could not be read.

## What is in this folder

| File | What it does |
| --- | --- |
| `src/core.js` | The server itself: reads one message, writes one answer. |
| `src/tools.js` | The twelve tools: what each takes and how it answers from the tables. |
| `src/tables.js` | Fetches the six public files and keeps them for an hour. Holds a report's lines as text and reads them back only for the report asked for. |
| `src/disk.js` | Reads the table files from a folder instead, for a program on your own computer. |
| `src/usage.js` | Describes a request by kind, for a host that wants to count what is asked. See below. |
| `src/stdio.js` | The door for a helper program on your own computer. |
| `src/http.js` | The door for the web. One request in, one answer out, nothing remembered. |
| `src/serve.js` | Runs the web door on your own computer. |
| `src/worker.js` | The web door shaped for an edge host that runs it by itself. Not deployed: clinx.org serves the same door from the site's own program ([clinx-org](https://github.com/VVillBerchtold/clinx-org), `worker/assistants.ts`). |
| `src/*.d.ts` | The shapes of the pieces above, for a host written in TypeScript. |
| `test/` | The tests, and small real slices of the tables (`test/data/`) they run on. |

## Which versions of the protocol it speaks

MCP changed shape in its revision of 28 July 2026. Before it, a client opened with a handshake
(`initialize`) and the two sides agreed a version once. Since it, there is no handshake: every
request names its version, and a client can ask `server/discover` what a server speaks.

Both kinds of client are in use, so the server answers both: the 2026-07-28 revision, and the
older 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. A request that names the newer version
is answered the newer way. Everything else is answered the older way.

On 15 November 2026 Claude Code 2.1.306 was pointed at the server. It opened with
`server/discover`, was told 2026-07-28, and listed the tools (seven then, twelve now). Those exact messages are now
one of the tests. A whole question asked through an assistant, start to finish, has not been
tried yet; nor has any other client.

## Safety and privacy

- **Read-only.** No tool changes anything anywhere.
- **Nothing about the asker is kept.** No log of questions, no cookies, no sessions, no sign-in.
  Run on your own computer, the server counts nothing at all.
- **It cannot be turned on another site.** The only addresses it ever fetches are the six
  table files on clinx.org, at most once an hour, whatever it is asked.
- **Small requests only.** The web door takes `POST` with JSON, up to 64 KB, and nothing else.
- **On your own computer** it listens on `127.0.0.1` only and refuses calls from web pages that
  are not on that computer, so a page you visit cannot reach it.
- If clinx.org cannot be reached, a tool says so. If a refetch fails, the copy already held is
  still served.

## Counting what is asked, without knowing who asked

Whoever hosts the server for others will want to know which questions people bring to it, so
the work goes where it is used. The web door can hand a host a short description of each
request (`counted`, in `src/http.js`). The server keeps nothing itself; the host decides where
the descriptions go.

A description has eight fields and never more:

| Field | Example | What it is |
| --- | --- | --- |
| `method` | `tools/call` | The kind of request. |
| `tool` | `find_bills` | The tool called, if one was. |
| `outcome` | `answered` | Answered, a mistake in what was asked, refused, or the tables could not be reached. |
| `place` | `TX` | The state asked about, `US` or `FED`. |
| `filters` | `kind=contract-pharmacy text` | The filters used, by name. |
| `looked_up` | `ri-2025-hb5634` | The public row a "get" tool found. |
| `client` | `claude-code` | The name the assistant program gives itself. |
| `version` | `2026-07-28` | The protocol version it asked for. |

What is left out matters more than what is kept:

- **Never the words.** Search words, dates and anything else typed freely are not kept. A
  filter is kept by name only (`text`), and its value only when it is one of the tool's own
  listed choices (`kind=contract-pharmacy`).
- **Never the asker.** No internet address, no browser or device description, nothing that
  could tell one asker from another.
- **A looked-up id comes from the answer**, not from what was typed: it is a public row the
  server found and gave back.
- A client's name is cut down to plain letters and forty characters.

`test/usage.test.js` checks each of these with a made-up name, number and email address typed
into every field, and fails if any of it comes out the other side.

The copy at clinx.org/mcp is counted this way and no other. The site's
[Privacy page](https://clinx.org/privacy/#assistants) says the same to its readers.

## Tests

    npm test          # 67 tests and 2 live checks that are skipped, no network
    npm run test:live # two checks against the published tables at clinx.org

The tests cover both protocol eras, every tool, every kind of mistaken input, what a host is
told about a request and what it is not, the helper program
started and driven as an app would drive it, and the web door both as a function and as a real
server on a local port.

## What is not done

- It is not published as a package, so there is no one-line install.
- It answers from the state law, bills, federal notices, calendar, filed reports and reporting
  states tables. The registry tables are not offered yet, and the drug rows of a report are
  given as lines of that report, not as a separate search.
- Federal notices go back to January 2025. Court cases, and which drug makers an agency has
  approved for the rebate pilot, are not in the tables.
- Hearings appear once a legislature posts an agenda that names a listed bill. In November 2026,
  with most legislatures out of session, there are none.

## Licence

The code is under the [MIT licence](LICENSE). The tables it reads are under Creative Commons
Attribution 4.0; credit them as "ClinX, clinx.org, retrieved <date>, CC BY 4.0".
