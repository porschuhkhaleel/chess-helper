'use strict';

const DEFAULTS = {
  startTimeoutMs: 20000, 
  stopTimeoutMs: 1500, 
  options: { Hash: 16 }, 
};
const DEFAULT_DEPTH = 15;

function opposite(color) { return color === 'w' ? 'b' : 'w'; }
function linesOf(data) { return typeof data !== 'string' ? [] : data.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

function parseFen(raw) {
  if (typeof raw !== 'string') return { error: 'FEN must be a string.' };
  const parts = raw.trim().split(/\s+/);
  const [placement, side, castling, ep, half = '0', full = '1'] = parts;
  return { fen: [placement, side, castling, ep, half, full].join(' '), placement, stm: side, halfmove: Number(half) };
}

function normalizeColor(color) {
  if (color === undefined || color === null) return null;
  const c = String(color).toLowerCase();
  return (c === 'w' || c === 'white') ? 'w' : (c === 'b' || c === 'black') ? 'b' : undefined;
}

function buildGoCommand({ depth, movetime }) {
  const parts = ['go'];
  if (depth) parts.push('depth', depth);
  if (movetime) parts.push('movetime', movetime);
  if (parts.length === 1) parts.push('depth', DEFAULT_DEPTH);
  return { command: parts.join(' ') };
}

function parseRequest(msg) {
  const fen = parseFen(msg.fen);
  if (fen.error) return { code: 'BAD_FEN', message: fen.error };
  const go = buildGoCommand(msg);
  return { job: { id: msg.id, fen: fen.fen, stm: fen.stm, go: go.command, last: null } };
}

function parseInfo(line) {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const info = { depth: null, score: null, pv: [] };
  for (let i = 1; i < t.length; i++) {
    if (t[i] === 'pv') { info.pv = t.slice(i + 1); break; }
    if (t[i] === 'score') {
      const type = t[++i];
      const value = Number.parseInt(t[++i], 10);
      let bound = null;
      if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') bound = t[++i];
      info.score = { type, value, bound };
    }
  }
  return info.score ? info : null;
}

function parseBestmove(line) {
  const m = /^bestmove\s+(\S+)/.exec(line.trim());
  if (!m) return null;
  const none = m[1] === '(none)' || m[1] === '0000';
  return { move: none ? null : m[1] };
}

let config = { ...DEFAULTS };
let engine = null; 
let engineGen = 0; 
let state = 'uninitialized'; 
let current = null; 
let pending = null; 
let stopTimer = null;

function post(msg) { self.postMessage(msg); }
function send(cmd) { engine.postMessage(cmd); }

function startEngine(url) {
  return new Promise((resolve, reject) => {
    let w = new Worker(url);
    let stage = 'uci';
    w.onmessage = (ev) => {
      for (const line of linesOf(ev.data)) {
        if (stage === 'uci' && line === 'uciok') {
          stage = 'ready';
          w.postMessage('isready');
        } else if (stage === 'ready' && line === 'readyok') {
          resolve({ w }); return;
        }
      }
    };
    w.postMessage('uci');
  });
}

async function bootEngine() {
  const gen = ++engineGen;
  state = 'booting';
  try {
    const { w } = await startEngine(config.engine.wasm);
    engine = w;
    attachEngine(w, gen);
    state = 'idle';
    post({ type: 'ready' });
    drain();
  } catch (err) {
    state = 'failed';
    post({ type: 'error', code: 'ENGINE_LOAD_FAILED' });
  }
}

function boot() { bootEngine().catch(err => { state = 'failed'; }); }

function attachEngine(w, gen) {
  w.onmessage = (ev) => {
    if (gen !== engineGen) return;
    for (const line of linesOf(ev.data)) {
      if (line.startsWith('info ')) handleInfo(line);
      else if (line.startsWith('bestmove')) handleBestmove(line);
    }
  };
}

function cancelCurrent() {
  state = 'stopping';
  send('stop');
  stopTimer = setTimeout(() => { stopTimer = null; current = null; }, config.stopTimeoutMs);
}

function handleInfo(line) {
  const info = parseInfo(line);
  if (!info || state !== 'searching' || !current) return;
  if (info.score.bound === null || !current.last) current.last = info;
}

function handleBestmove(line) {
  const best = parseBestmove(line);
  if (!best) return;
  if (state === 'stopping') {
    clearTimeout(stopTimer); stopTimer = null; current = null; state = 'idle'; drain(); return;
  }
  const job = current;
  current = null;
  state = 'idle';
  post({ type: 'result', id: job.id, bestMove: best.move });
  drain();
}

function startSearch(job) {
  current = job; state = 'searching';
  send(`position fen ${job.fen}`); send(job.go);
}

function drain() {
  if (state !== 'idle' || !pending) return;
  const job = pending; pending = null; startSearch(job);
}

function submit(job) {
  pending = job;
  if (state === 'searching') cancelCurrent(); else drain();
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'init':
      if (state !== 'uninitialized') return;
      config = { ...DEFAULTS, ...(msg.config || {}) };
      boot();
      break;
    case 'analyze':
      const parsed = parseRequest(msg);
      if (!parsed.code) submit(parsed.job);
      break;
  }
};