#!/usr/bin/env node
// 로컬 전용 꼼꼼 웹 UI. 127.0.0.1에만 바인딩한다.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/cli.js');
const PORT = Number(process.env.PORT || 4321);
const MAX_BODY = 8 * 1024;
const SCAN_TIMEOUT_MS = 300_000;

const MODES = {
  fast: ['--fast', '--json', '--lang', 'ko'],
  full: ['--json', '--lang', 'ko'],
  artifacts: ['--artifacts', '--json', '--lang', 'ko'],
  protect: ['--protect-sourcemaps', '--json', '--lang', 'ko'],
};

// 한 번에 한 검사만 돌린다. 같은 프로젝트에 dev 서버·빌드가 겹치면 포트가 충돌한다.
let current = null;

function runCli(cwd, args) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd, timeout: SCAN_TIMEOUT_MS });
    const state = { child, cancelled: false };
    current = state;
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const finish = (code, extra = {}) => {
      if (current === state) current = null;
      done({ code, out, err, ms: Date.now() - started, cancelled: state.cancelled, ...extra });
    };
    child.on('error', (e) => finish(null, { err: String(e) }));
    child.on('close', (code) => finish(code));
  });
}

function cancelCurrent() {
  if (!current) return false;
  current.cancelled = true;
  current.child.kill('SIGINT');
  return true;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const CONFIG_RE = /^next\.config\.(js|mjs|cjs|ts)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.cache', '.local', '.npm', '.nvm', '.vscode-server']);
let projectCache = { at: 0, list: [] };

async function findProjects(root, maxDepth = 4) {
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
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
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

async function resolveTarget(input) {
  const home = await realpath(homedir());
  const raw = input.trim();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? home + raw.slice(1) : raw;
  let real;
  try {
    real = await realpath(resolve(expanded));
  } catch {
    return { error: `경로가 없습니다: ${resolve(expanded)}` };
  }
  if (real !== home && !real.startsWith(home + '/')) {
    return { error: '홈 디렉터리 아래 경로만 검사할 수 있습니다.' };
  }
  return { dir: real };
}

// 검사가 시작되지 못한 이유를 초급자용 문장으로 바꾼다.
function failureReason(result) {
  if (result.cancelled) return { title: '검사를 취소했습니다.', hint: '다시 실행할 수 있습니다.' };
  const err = result.err || '';
  if (/Next\.js가 설치되어 있지 않습니다/.test(err)) {
    return {
      title: '이 폴더에 Next.js가 설치되어 있지 않습니다.',
      hint: '프로젝트 폴더에서 npm install을 먼저 실행한 뒤 다시 검사하세요.',
    };
  }
  if (/포트|port/i.test(err) && /사용/.test(err)) {
    return {
      title: '검사에 필요한 포트가 이미 사용 중입니다.',
      hint: '다른 프로그램을 끄거나, 잠시 뒤 다시 실행하세요.',
    };
  }
  if (/Next\.js 프로젝트|next 프로젝트|찾을 수 없/i.test(err)) {
    return {
      title: '이 폴더에서 Next.js 프로젝트를 찾지 못했습니다.',
      hint: 'package.json에 next가 들어 있는 폴더를 선택하세요.',
    };
  }
  return {
    title: '검사를 시작하지 못했습니다.',
    hint: '프로젝트 폴더가 맞는지, npm install을 했는지 확인하세요.',
  };
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

// 로컬 서버로 오는 요청의 Host를 확인한다. DNS 리바인딩으로 외부 페이지가 접근하는 것을 막는다.
function hostOk(req) {
  const host = String(req.headers.host || '');
  const name = host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

const server = createServer(async (req, res) => {
  if (!hostOk(req)) return send(res, 403, JSON.stringify({ error: '허용되지 않은 호스트입니다.' }));

  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await readFile(resolve(ROOT, 'web/index.html'));
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, node: process.version, busy: Boolean(current) }));
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return send(res, 200, JSON.stringify({ projects: await listProjects() }));
  }

  if (req.method === 'POST' && url.pathname === '/api/cancel') {
    const cancelled = cancelCurrent();
    return send(res, 200, JSON.stringify({ cancelled }));
  }

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    if (current) {
      return send(res, 409, JSON.stringify({ error: '이미 검사가 실행 중입니다. 끝나거나 취소한 뒤 다시 시도하세요.' }));
    }

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

    const target = await resolveTarget(dir.trim());
    if (target.error) return send(res, 400, JSON.stringify({ error: target.error }));

    const result = await runCli(target.dir, args);
    let json = null;
    try {
      json = JSON.parse(result.out);
    } catch {
      json = null;
    }
    return send(res, 200, JSON.stringify({
      dir: target.dir,
      mode,
      exitCode: result.code,
      ms: result.ms,
      json,
      ui: json ? analyze(json, { dir: target.dir, mode, ms: result.ms }) : null,
      failure: json ? null : failureReason(result),
      stderr: result.err.slice(0, 4000),
      stdout: json ? undefined : result.out.slice(0, 4000),
    }));
  }

  send(res, 404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`꼼꼼 웹 UI  http://127.0.0.1:${PORT}`);
});
