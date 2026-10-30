// Converts the 2026 final club workbook (grade sheets: 학번, 이름, 동아리) into the document accepted by
// festival_ops.import_review_roster. Never prints student records; output goes only to the ignored
// nfc-server/private-output folder. Usage:
//   node tools/import-review-roster.cjs <workbook.xlsx> <output-name>
// Requires the local xlsx package (npm install --prefix . --no-save xlsx@0.18.5).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const root = path.resolve(__dirname, '..');
const GRADE_SHEETS = ['1학년(반번호순)', '2학년(반번호순)'];
const text = value => String(value ?? '').normalize('NFKC').trim();
const clubKey = value => text(value).replace(/\([^)]*\)/g, '').replace(/\s+/g, '');

function analyze(workbook, catalog, mapping) {
  const aliases = mapping.aliases || {}, approved = mapping.clubs || {};
  const canonical = value => aliases[clubKey(value)] ? clubKey(aliases[clubKey(value)]) : clubKey(value);
  const byClub = new Map(catalog.map(key => [clubKey(key), key]));
  const rows = new Map(), invalid = [];
  for (const name of GRADE_SHEETS) {
    const sheet = workbook.Sheets[name];
    if (!sheet) throw Error('UNRECOGNIZED_FINAL_WORKBOOK');
    const values = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (text(values[0]?.[0]) !== '학번' || text(values[0]?.[1]) !== '이름' || text(values[0]?.[2]) !== '동아리') throw Error('UNRECOGNIZED_FINAL_WORKBOOK');
    values.slice(1).forEach((row, index) => {
      const sid = text(row[0]), realName = text(row[1]), club = text(row[2]), cell = `${name}!A${index + 2}`;
      if (!sid && !realName && !club) return;
      if (!/^[12][0-9]{4}$/.test(sid) || !realName || realName.length > 60 || !club) { invalid.push(cell); return; }
      if (!rows.has(sid)) rows.set(sid, []);
      rows.get(sid).push({ realName, club: canonical(club), cell });
    });
  }
  const records = [...rows.keys()].sort().map(sid => {
    const entries = rows.get(sid), issues = new Set(), keys = new Set();
    const names = new Set(entries.map(e => e.realName)), clubs = [...new Set(entries.map(e => e.club))].sort();
    if (names.size !== 1) issues.add('NAME_CONFLICT');
    for (const club of clubs) {
      // An approved [] is a club without a booth; an unknown club stays blocked for review.
      const mapped = Object.hasOwn(approved, club) ? approved[club] : byClub.has(club) ? [byClub.get(club)] : null;
      if (mapped === null) issues.add('UNMAPPED_CLUB');
      else if (!Array.isArray(mapped) || mapped.some(key => !catalog.includes(key))) throw Error('INVALID_APPROVED_MAPPING');
      else mapped.forEach(key => keys.add(key));
    }
    const reasons = [...issues].sort();
    return { studentNumber: sid, realName: names.size === 1 ? [...names][0] : null, clubs, boothKeys: [...keys].sort(),
      status: reasons.length ? 'review_required' : 'ready', issues: reasons, sourceCells: entries.map(e => e.cell).sort() };
  });
  const summary = { students: records.length, ready: records.filter(r => r.status === 'ready').length,
    pending: records.filter(r => r.status !== 'ready').length, withBooth: records.filter(r => r.boothKeys.length).length,
    grades: records.reduce((n, r) => ({ ...n, [r.studentNumber[0]]: (n[r.studentNumber[0]] || 0) + 1 }), {}),
    clubs: [...new Set(records.flatMap(r => r.clubs))].sort(),
    unmappedClubs: [...new Set(records.filter(r => r.issues.includes('UNMAPPED_CLUB')).flatMap(r => r.clubs))].sort(),
    boothsWithoutMembers: catalog.filter(key => !records.some(r => r.boothKeys.includes(key))), invalidRows: invalid.length };
  return { records, summary };
}

function main() {
  const [workbookPath, outputName] = process.argv.slice(2);
  if (!workbookPath || !/^[a-z0-9-]{1,60}$/.test(outputName || '')) throw Error('USAGE: <workbook.xlsx> <output-name>');
  const output = path.join(root, 'nfc-server', 'private-output', outputName);
  if (fs.existsSync(output)) throw Error('OUTPUT_ALREADY_EXISTS');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'operations-server', 'roster-catalog.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(root, 'operations-server', 'roster-mapping.json'), 'utf8'));
  const bytes = fs.readFileSync(workbookPath);
  const { records, summary } = analyze(XLSX.read(bytes, { type: 'buffer' }), catalog, mapping);
  if (summary.invalidRows) throw Error('MALFORMED_ROWS_REQUIRE_REVIEW');
  const document = { format: 1, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    catalogKeys: [...catalog].sort(), records };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'roster.json'), JSON.stringify(document));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message.startsWith('USAGE') || /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_FILE_ERROR'); process.exitCode = 1; }
}
module.exports = { analyze, clubKey };
