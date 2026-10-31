const test = require('node:test');
const assert = require('node:assert/strict');
const FestivalSun = require('../sun-nfc.js');
const FestivalAccount = require('../festival-account.js');

const PICC = 'EF963FF7828658A599F3041510671E88', MAC = '94EED9EE65337086';

test('reads the one-time link from the fragment or the query', () => {
  for (const href of [`https://festival.example/#picc_data=${PICC}&cmac=${MAC}`,
    `https://festival.example/?picc_data=${PICC.toLowerCase()}&cmac=${MAC.toLowerCase()}`]) {
    const read = FestivalSun.parse(href);
    assert.equal(read.picc, PICC); assert.equal(read.cmac, MAC);
    assert.equal(read.macInput, `${href.includes('?') ? PICC.toLowerCase() : PICC}&cmac=`);
  }
  assert.equal(FestivalSun.parse(`https://festival.example/#picc_data=${PICC}`), null);
  assert.equal(FestivalSun.parse(`https://festival.example/#picc_data=${PICC}0&cmac=${MAC}`), null);
  assert.equal(FestivalSun.parse(`https://festival.example/#t=nf1.abc`), null);
});

test('a read survives the token round trip used for pending claims', () => {
  const read = FestivalSun.parse(`https://festival.example/#picc_data=${PICC}&cmac=${MAC}`);
  const token = FestivalSun.toToken(read);
  assert.match(token, FestivalSun.TOKEN_PATTERN);
  assert.match(token, FestivalAccount.SUN_TOKEN_PATTERN);
  assert.doesNotMatch(token, FestivalAccount.TOKEN_PATTERN);
  assert.deepEqual(FestivalSun.fromToken(token), read);
  assert.deepEqual(FestivalSun.payload(read), { picc: PICC, cmac: MAC, macInput: `${PICC}&cmac=` });
  assert.deepEqual(FestivalSun.payload({ picc: PICC, cmac: MAC, macInput: null }), { picc: PICC, cmac: MAC });
  assert.equal(FestivalSun.fromToken('sun1.bad'), null);
});

test('strip removes only the card values', () => {
  assert.equal(FestivalSun.strip(`https://festival.example/map?x=1#picc_data=${PICC}&cmac=${MAC}`), 'https://festival.example/map?x=1');
  assert.equal(FestivalSun.strip(`https://festival.example/?picc_data=${PICC}&cmac=${MAC}#tab=1`), 'https://festival.example/#tab=1');
});

test('the card layout for the festival site', () => {
  const layout = FestivalSun.layout('https://pangyo-festival-app.vercel.app');
  assert.equal(layout.url, `https://pangyo-festival-app.vercel.app/#picc_data=${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`);
  assert.equal(layout.piccOffset, 49); assert.equal(layout.piccOffsetHex, '310000');
  assert.equal(layout.macOffset, 87); assert.equal(layout.macOffsetHex, '570000');
  assert.equal(layout.macInputOffset, 87);
  assert.equal(layout.fileLength, 103);
  // NLEN, then a short well-known URI record with the https:// prefix code.
  assert.equal(layout.fileHex.slice(0, 14), '0065D101615504');
  const file = Buffer.from(layout.fileHex, 'hex');
  assert.equal(file.subarray(layout.piccOffset, layout.piccOffset + 32).toString(), '0'.repeat(32));
  assert.equal(file.subarray(layout.macOffset - 6, layout.macOffset).toString(), '&cmac=');
  assert.throws(() => FestivalSun.layout('http://example.test'), /HTTPS_REQUIRED/);
});
