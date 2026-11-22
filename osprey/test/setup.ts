// Every unit test gets the sample JLCPCB parts table, as a user directory with the samples
// added would have it (the app and the command line read it from the user directory's parts/).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLcscTable, setLcscParts } from '../src/model/lcsc';

setLcscParts(readLcscTable(readFileSync(join(__dirname, '..', 'samples', 'parts', 'lcsc-passives.json'), 'utf8')));
