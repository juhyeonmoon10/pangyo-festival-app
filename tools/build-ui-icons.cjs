const fs = require('node:fs');
const path = require('node:path');
const lucide = require(process.env.LUCIDE_PATH || 'lucide');
const names = {
  home: 'House', map: 'Map', scan: 'Nfc', stamp: 'Stamp', star: 'Star', back: 'ChevronLeft',
  admin: 'Settings', user: 'UserRound', heart: 'Heart', external: 'ArrowUpRight', search: 'Search',
  close: 'X', plus: 'Plus', minus: 'Minus', check: 'Check', arrow: 'ArrowRight', ticket: 'Ticket',
  notice: 'Megaphone', refresh: 'RotateCcw', list: 'List', lock: 'LockKeyhole', message: 'MessageSquare',
  save: 'Save', copy: 'Copy', logout: 'LogOut',
};
const icons = Object.fromEntries(Object.entries(names).map(([name, key]) => {
  if (!lucide[key]) throw Error(`Missing icon ${key}`);
  const children = lucide[key].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k,v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  return [name, `<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`];
}));
fs.writeFileSync(path.join(__dirname, '../assets/vendor/ui-icons.js'), `// Generated from Lucide 1.8.0 (ISC).\nwindow.FestivalIcons = ${JSON.stringify(icons)};\n`);
