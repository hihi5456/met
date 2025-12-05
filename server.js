// Minimal static file server for local testing only (not required when hosting on GitHub Pages).
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 3000;
const rootDir = __dirname;

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(req.url.split('?')[0]);

  if (pathname === '/now') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ now: performance.now() }));
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(rootDir, path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, ''));

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType(filePath) });
    res.end(data);
  });
});

function mimeType(file) {
  const ext = path.extname(file);
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

server.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Static server running at http://localhost:${PORT}`);
});
