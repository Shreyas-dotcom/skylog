// A tiny stand-in for the parts of the GitHub REST API Skylog uses, for testing the hosted
// (encrypted) mode locally. Serves the test build at http://127.0.0.1:5199/app/.
//   node tools/build.mjs --test && node tools/mock-github.mjs
// Accepts the token "good-token". Test hooks: GET /_state, /_bump (simulate another device's save), /_offline?on=1|0
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let file = null, sha = null, commits = [], offline = false;
const newSha = () => crypto.randomBytes(20).toString('hex');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, '');
  if (url.pathname === '/app/' || url.pathname === '/app/index.html') return send(200, fs.readFileSync(path.join(ROOT, 'test/index.html'), 'utf8'), 'text/html');
  if (url.pathname === '/_state') return send(200, { sha, commits: commits.map(c => c.message), file });
  if (url.pathname === '/_bump') { sha = newSha(); commits.push({ message: 'other device' }); return send(200, { sha }); }
  if (url.pathname === '/_offline') { offline = url.searchParams.get('on') === '1'; return send(200, { offline }); }
  if (offline) { req.destroy(); return; }

  const auth = req.headers.authorization;
  if (auth && auth !== 'Bearer good-token') return send(401, { message: 'Bad credentials' });
  if (url.pathname === '/repos/tester/skylog') return send(200, { full_name: 'tester/skylog', permissions: { push: !!auth } });
  if (url.pathname === '/repos/tester/skylog/contents/vault.json') {
    if (req.method === 'GET') return file ? send(200, { sha, content: Buffer.from(file).toString('base64') }) : send(404, { message: 'Not Found' });
    if (req.method === 'PUT') {
      if (!auth) return send(401, { message: 'Requires authentication' });
      let body = ''; for await (const c of req) body += c;
      const j = JSON.parse(body);
      if (file && j.sha !== sha) return send(409, { message: 'sha does not match' });
      if (!file && j.sha) return send(422, { message: 'sha given for new file' });
      file = Buffer.from(j.content, 'base64').toString('utf8'); sha = newSha(); commits.push({ message: j.message });
      return send(200, { content: { sha } });
    }
  }
  send(404, { message: 'Not Found' });
}).listen(5199, '127.0.0.1', () => console.log('mock GitHub on http://127.0.0.1:5199  (app: /app/)'));
