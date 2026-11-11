// 로컬 전용 꼼꼼 웹 UI. 127.0.0.1에만 바인딩한다.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/cli.js');
const PORT = Number(process.env.PORT || 4321);
const MAX_BODY = 8 * 1024;

const MODES = {
  fast: ['--fast', '--json', '--lang', 'ko'],
  full: ['--json', '--lang', 'ko'],
  artifacts: ['--artifacts', '--json', '--lang', 'ko'],
  protect: ['--protect-sourcemaps', '--json', '--lang', 'ko'],
};

function runCli(cwd, args) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd, timeout: 300_000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => done({ code: null, out, err: String(e), ms: Date.now() - started }));
    child.on('close', (code) => done({ code, out, err, ms: Date.now() - started }));
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const CONFIG_RE = /^next\.config\.(js|mjs|cjs|ts)$/;
let projectCache = { at: 0, list: [] };

async function findProjects(root, maxDepth = 3) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && CONFIG_RE.test(e.name))) found.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      await walk(resolve(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

async function listProjects() {
  if (Date.now() - projectCache.at < 60_000) return projectCache.list;
  const list = await findProjects(homedir());
  projectCache = { at: Date.now(), list };
  return list;
}

function readBody(req) {
  return new Promise((done, fail) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => done(raw));
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await readFile(resolve(ROOT, 'web/index.html'));
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, node: process.version, cwd: ROOT }));
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return send(res, 200, JSON.stringify({ projects: await listProjects() }));
  }

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, JSON.stringify({ error: '요청 본문이 올바른 JSON이 아닙니다.' }));
    }

    const { dir, mode } = payload ?? {};
    const args = MODES[mode];
    if (!args) return send(res, 400, JSON.stringify({ error: '알 수 없는 검사 모드입니다.' }));
    if (typeof dir !== 'string' || !dir.trim()) {
      return send(res, 400, JSON.stringify({ error: '프로젝트 경로를 입력하세요.' }));
    }

    const target = resolve(dir.trim());
    if (!target.startsWith(homedir() + '/')) {
      return send(res, 400, JSON.stringify({ error: '홈 디렉터리 아래 경로만 검사할 수 있습니다.' }));
    }
    if (!existsSync(target)) {
      return send(res, 400, JSON.stringify({ error: `경로가 없습니다: ${target}` }));
    }

    const result = await runCli(target, args);
    let json = null;
    try {
      json = JSON.parse(result.out);
    } catch {
      json = null;
    }
    return send(res, 200, JSON.stringify({
      dir: target,
      mode,
      exitCode: result.code,
      ms: result.ms,
      json,
      ui: json ? analyze(json, { dir: target, mode, ms: result.ms }) : null,
      stderr: result.err.slice(0, 4000),
      stdout: json ? undefined : result.out.slice(0, 4000),
    }));
  }

  send(res, 404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`꼼꼼 웹 UI  http://127.0.0.1:${PORT}`);
});
