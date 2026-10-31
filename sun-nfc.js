/* NTAG 424 DNA secure cards (SUN). Reads the card's one-time link and describes what to write on a card.
   Verification happens only on the server; nothing here can tell a real link from a forged one. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FestivalSun = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PICC = 'picc_data', CMAC = 'cmac';
  const TOKEN_PATTERN = /^sun1\.[0-9A-F]{32}\.[0-9A-F]{16}(\.[A-Za-z0-9_-]{1,300})?$/;
  const PICC_FIND = /[?#&]picc_data=([0-9A-Fa-f]{32})(?=$|[&#])/;
  const CMAC_FIND = /[?#&]cmac=([0-9A-Fa-f]{16})(?=$|[&#])/;

  const encode = text => (typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'latin1').toString('base64'))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decode = value => {
    const base = value.replace(/-/g, '+').replace(/_/g, '/');
    return typeof atob === 'function' ? atob(base) : Buffer.from(base, 'base64').toString('latin1');
  };

  // The card writes picc_data and cmac into the link text. The MAC input, when the card is set to MAC
  // the text from picc_data onwards, is everything between the two values exactly as the card wrote it.
  function parse(href) {
    const text = String(href || '');
    if (text.length > 2048) return null;
    const picc = PICC_FIND.exec(text), cmac = CMAC_FIND.exec(text);
    if (!picc || !cmac) return null;
    const piccStart = picc.index + picc[0].length - 32, cmacStart = cmac.index + cmac[0].length - 16;
    const input = cmacStart > piccStart ? text.slice(piccStart, cmacStart) : '';
    return { picc: picc[1].toUpperCase(), cmac: cmac[1].toUpperCase(),
      macInput: /^[!-~]{1,200}$/.test(input) ? input : null };
  }

  function toToken(read) {
    return `sun1.${read.picc}.${read.cmac}${read.macInput ? `.${encode(read.macInput)}` : ''}`;
  }

  function fromToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const [, picc, cmac, input] = token.split('.');
    let macInput = null;
    if (input) {
      try { macInput = decode(input); } catch { return null; }
      if (!/^[!-~]{1,200}$/.test(macInput)) return null;
    }
    return { picc, cmac, macInput };
  }

  // The request body for festival_sun_claim and the admin inspect/register actions.
  function payload(read) {
    return read.macInput ? { picc: read.picc, cmac: read.cmac, macInput: read.macInput } : { picc: read.picc, cmac: read.cmac };
  }

  function strip(href) {
    const url = new URL(href);
    url.searchParams.delete(PICC); url.searchParams.delete(CMAC);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    hash.delete(PICC); hash.delete(CMAC);
    url.hash = hash.toString() ? `#${hash}` : '';
    return url.href;
  }

  const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  // Offsets are 3-byte little-endian values in ChangeFileSettings.
  const le3 = n => hex([n & 255, (n >> 8) & 255, (n >> 16) & 255]);

  // What a card for this site holds in its NDEF file (file 02): one URI record whose placeholders the
  // card overwrites on every read. Offsets count from the start of the file, including the 2-byte NLEN.
  function layout(origin) {
    const base = new URL(origin);
    if (base.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
    const prefix = base.host.startsWith('www.') ? ['https://www.', 0x02] : ['https://', 0x04];
    const rest = `${base.host.slice(prefix[0] === 'https://www.' ? 4 : 0)}/#${PICC}=${'0'.repeat(32)}&${CMAC}=${'0'.repeat(16)}`;
    const ascii = Array.from(rest, c => c.charCodeAt(0));
    const record = [0xD1, 0x01, ascii.length + 1, 0x55, prefix[1], ...ascii];
    const file = [record.length >> 8, record.length & 255, ...record];
    const at = marker => 2 + 5 + rest.indexOf(marker) + marker.length;
    const piccOffset = at(`#${PICC}=`), macOffset = at(`&${CMAC}=`);
    return {
      url: prefix[0] + rest,
      piccOffset, macOffset, macInputOffset: macOffset,
      piccOffsetHex: le3(piccOffset), macOffsetHex: le3(macOffset),
      fileLength: file.length, fileHex: hex(file),
    };
  }

  return { TOKEN_PATTERN, parse, toToken, fromToken, payload, strip, layout };
});
