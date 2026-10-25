// Serves dist/ for the browser tests as GitHub Pages does: a folder without its
// slash redirects to it, and a missing path gets 404.html with a 404 status.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number(process.argv[2] ?? 4322);
const ROOT = resolve(import.meta.dirname, '../dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

const kind = (path: string) => {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
};

function decoded(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathname = decoded(url.pathname);
  const path = normalize(join(ROOT, pathname ?? '/404.html'));
  const send = (status: number, file: string) => {
    response.writeHead(status, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  };
  const inside = pathname !== undefined && (path === ROOT || path.startsWith(ROOT + sep));
  if (inside && kind(path) === 'dir') {
    if (!url.pathname.endsWith('/')) {
      response.writeHead(301, { location: `${url.pathname}/${url.search}` });
      response.end();
      return;
    }
    if (kind(join(path, 'index.html')) === 'file') return send(200, join(path, 'index.html'));
  }
  if (inside && kind(path) === 'file') return send(200, path);
  send(404, join(ROOT, '404.html'));
}).listen(PORT, '127.0.0.1');
