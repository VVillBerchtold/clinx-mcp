// The tables for a program run on a person's own computer.
//
// In plain words: by default the helper program and the local web door read the open files from
// clinx.org. Set CLINX_DATA_DIR to a folder that holds the table files and they are read
// from that folder instead, with no network. The tests run that way.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTables } from './tables.js';

/** A way to read one table file from a folder. */
export const fromFolder = (folder) => async (name) => JSON.parse(await readFile(join(folder, name), 'utf8'));

/** The tables: from `folder` when one is given (or named in CLINX_DATA_DIR), else from clinx.org. */
export function localTables({ folder = process.env.CLINX_DATA_DIR, ...rest } = {}) {
  return makeTables(folder ? { ...rest, reader: fromFolder(folder) } : rest);
}
