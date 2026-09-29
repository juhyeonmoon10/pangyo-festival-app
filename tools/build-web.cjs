const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.vercel', 'output');
const entries = [
  'index.html', 'app.js', 'styles.css', 'ui-ver2.css', 'web-redesign.css',
  'web-experience.js', 'programs.js', 'supabase-catalog.js',
  'festival-account.js', 'nfc-manager.js',
  'assets/vendor/supabase-2.116.0.js', 'assets/vendor/SUPABASE-LICENSE.txt',
  'assets/vendor/ui-icons.js', 'assets/vendor/LUCIDE-LICENSE.txt',
  'assets/vendor/qrcode-1.4.4.js',
];

function publicFiles() {
  const logos = fs.readdirSync(path.join(root, 'assets/clubs'))
    .filter(name => /^[a-f0-9-]{36}\.webp$/.test(name))
    .map(name => `assets/clubs/${name}`);
  return [...entries, ...logos].sort();
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
    version: '1.2',
    commit: /^[a-f0-9]{40}$/.test(sha) ? sha : null,
    builtAt: new Date().toISOString(),
    files: hashes,
  };
  fs.writeFileSync(path.join(output, 'static/deployment-info.json'), JSON.stringify(release, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({
    version: 3,
    routes: [
      { src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' }, continue: true },
      { src: '/(?:|index\\.html|nfc/?|deployment-info\\.json)', headers: { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' }, continue: true },
      { src: '/nfc/?', dest: '/index.html' },
      { handle: 'filesystem' },
    ],
  }, null, 2) + '\n');
  console.log(`Web ${release.version}: ${Object.keys(hashes).length} public files; no functions or database changes.`);
  return release;
}

if (require.main === module) build();
module.exports = { build, publicFiles, output };
