#!/usr/bin/env node
// The door for a program on your own computer.
//
// In plain words: an assistant app starts this file as a small helper program and talks to it
// over the program's standard input and output, one JSON message per line. Nothing is listened
// for on the network. The helper stops when the app closes its end.
//
//   node src/stdio.js
//
// Set CLINX_DATA_DIR to a folder holding the four table files to read them from disk instead
// of from clinx.org.

import { createInterface } from 'node:readline';
import { answer } from './core.js';
import { localTables } from './disk.js';

const tables = localTables();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const waiting = new Set();

lines.on('line', (line) => {
  if (!line.trim()) return;
  const work = answer(line, tables).then((reply) => {
    // Only protocol messages go to standard output; anything for a person goes to standard error.
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
  waiting.add(work);
  work.finally(() => waiting.delete(work));
});

lines.on('close', async () => {
  await Promise.allSettled([...waiting]);
  process.exit(0);
});
