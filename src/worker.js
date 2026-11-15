// The web door, shaped for an edge host (a Cloudflare Worker).
//
// Not deployed anywhere yet. This file exists so that hosting the server is a small step when
// that is decided: the host calls `fetch` below for each request to /mcp. It is public and
// read-only, holds no key, sets no cookie and stores nothing about who asked.

import { respond } from './http.js';
import { makeTables } from './tables.js';

const tables = makeTables();

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('The server is at /mcp\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return respond(request, { tables, origins: 'any' });
  },
};
