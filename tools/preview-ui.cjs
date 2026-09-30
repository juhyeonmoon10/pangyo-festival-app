const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const entrypoints = new Set(['index.html', 'app.js', 'styles.css', 'ui-ver2.css', 'web-redesign.css', 'web-experience.js', 'programs.js', 'supabase-catalog.js', 'festival-account.js', 'nfc-manager.js']);
['festival-operations.js','operations-ui.js','operations.css'].forEach(file => entrypoints.add(file));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const port = Number(process.argv[2] || 5183);
http.createServer((req,res) => {
  let relative;
  try { relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'') || 'index.html'; }
  catch { res.writeHead(400).end(); return; }
  const target = path.resolve(root, relative);
  const publicAsset = relative.startsWith('assets/') && target.startsWith(path.join(root,'assets') + path.sep);
  if (!['GET','HEAD'].includes(req.method) || relative.includes('\\') || !target.startsWith(root + path.sep) || !(entrypoints.has(relative) || publicAsset)) { res.writeHead(404).end(); return; }
  fs.stat(target,(error,stat) => {
    if (error || !stat.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200,{'Content-Type':types[path.extname(target)] || 'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(target).pipe(res);
  });
}).listen(port,'127.0.0.1',() => console.log(`http://127.0.0.1:${port}/?demo=1`));
