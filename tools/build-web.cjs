const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pagePattern} = require('../festival-router.js');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.vercel', 'output');
const entries = [
  'index.html', 'app.js', 'festival-router.js', 'styles.css', 'ui-ver2.css', 'web-redesign.css', 'festival-bright.css',
  'web-experience.js', 'stamp-simulator.js', 'sun-nfc.js', 'sun-cards.js', 'festival-notices.js', 'booth-manager.js', 'programs.js', 'supabase-catalog.js',
  'festival-account.js', 'nfc-manager.js', 'festival-operations.js', 'operations-ui.js', 'operations.css',
  'assets/vendor/supabase-2.116.0.js', 'assets/vendor/SUPABASE-LICENSE.txt',
  'assets/vendor/ui-icons.js', 'assets/vendor/LUCIDE-LICENSE.txt',
  'assets/vendor/qrcode-1.4.4.js',
  'assets/festival-school-1.4.webp', 'assets/festival-map-1.4.webp',
];

function publicFiles() {
  const logos = fs.readdirSync(path.join(root, 'assets/clubs'))
    .filter(name => /^[a-f0-9-]{36}\.webp$/.test(name))
    .map(name => `assets/clubs/${name}`);
  return [...entries, ...logos].sort();
}

// Scripts and connections stay on this site and the festival Supabase project; the one inline
// script in index.html (the <base> tag) is allowed by its hash. Styles stay inline-capable
// because the map places rooms with style attributes.
function securityHeaders() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
  const supabase = new URL(require('../supabase-catalog.js').PROJECT_URL);
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inline.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabase.origin}`,
    `connect-src 'self' ${supabase.origin} wss://${supabase.host}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Camera is the operator QR scanner; everything else the page never asks for.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  };
}

function build() {
  // Build Output API deploys only these static files, never the legacy api/ or SQL.
  for (const dir of [path.dirname(output), output]) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw Error('Unsafe output directory');
  }
  if (!output.startsWith(root + path.sep) || path.relative(root, output) !== path.join('.vercel', 'output')) {
    throw Error('Output must stay inside the personal app');
  }
  fs.rmSync(output, { recursive: true, force: true });
  const hashes = {};
  for (const relative of publicFiles()) {
    const source = path.join(root, relative);
    if (!fs.lstatSync(source).isFile() || !fs.realpathSync(source).startsWith(fs.realpathSync(root) + path.sep)) {
      throw Error(`Unsafe public file: ${relative}`);
    }
    const target = path.join(output, 'static', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  }
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
  const release = {
    version: '1.31',
    commit: /^[a-f0-9]{40}$/.test(sha) ? sha : null,
    builtAt: new Date().toISOString(),
    files: hashes,
  };
  fs.writeFileSync(path.join(output, 'static/deployment-info.json'), JSON.stringify(release, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({
    version: 3,
    routes: [
      { src: '/(.*)', headers: securityHeaders(), continue: true },
      { src: pagePattern, headers: { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' }, continue: true },
      { src: '/deployment-info\\.json', headers: { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' }, continue: true },
      { src: '/nfc/?', dest: '/index.html' },
      { handle: 'filesystem' },
      { src: pagePattern, dest: '/index.html' },
    ],
  }, null, 2) + '\n');
  console.log(`Web ${release.version}: ${Object.keys(hashes).length} public files; no functions or database changes.`);
  return release;
}

if (require.main === module) build();
module.exports = { build, publicFiles, output };
