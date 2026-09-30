// Rebuilds verify-run.sql from install.sql + database-rollback.sql so nobody has to hand-edit
// the COMMIT out of install.sql. Hand editing is what corrupted the $$ delimiters before.
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const install = fs.readFileSync(path.join(dir, 'install.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(dir, 'database-rollback.sql'), 'utf8');
const cut = install.lastIndexOf('commit;');
if (cut < 0) throw new Error('install.sql must end with commit;');
const header = `-- GENERATED, do not edit. Rebuild with: node nfc-server/build-verify-run.cjs\n`
  + `-- Dry run of install.sql: every change is checked and then rolled back.\n`
  + `-- Paste this whole file into the SQL editor and run it once. The last row must start with PASS\n`
  + `-- and nothing is left behind. Only after that, run install.sql itself.\n\n`;
fs.writeFileSync(path.join(dir, 'verify-run.sql'), header + install.slice(0, cut) + rollback);
console.log('verify-run.sql rebuilt');
