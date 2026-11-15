#!/usr/bin/env node
// Run the web door on your own computer, to try it out.
//
//   node src/serve.js            listens on http://127.0.0.1:8340/mcp
//   PORT=9000 node src/serve.js  another port
//
// It listens on this computer only (127.0.0.1), so nothing outside it can reach it, and it
// refuses calls from web pages that are not on this computer.

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { respond } from './http.js';
import { localTables } from './disk.js';

const PATH = '/mcp';
const port = Number(process.env.PORT ?? 8340);
const tables = localTables();

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== PATH) {
      outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`The server is at ${PATH}\n`);
      return;
    }
    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
    const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: hasBody ? Readable.toWeb(incoming) : undefined, duplex: 'half' });
    const reply = await respond(request, { tables, origins: 'local' });
    outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
    outgoing.end(reply.body ? Buffer.from(await reply.arrayBuffer()) : undefined);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.error(`ClinX 340B server listening on http://127.0.0.1:${port}${PATH}`);
});
