// 크리스마스 눈싸움 3D - 오픈월드 게임 서버 (의존성 없음, Node 18+)
// 하나의 서버 = 하나의 월드. 접속한 모든 플레이어가 같은 눈마을에서 함께 논다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const W = require('./shared/world.js');

const PORT = +process.env.PORT || 3000;
const SERVER_NAME = process.env.SERVER_NAME || '눈마을 1서버';
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 60;
const TICK = 30, SNAP_EVERY = 2;                   // 30Hz 시뮬레이션, 15Hz 상태 전송
const CAMP_RESPAWN = +process.env.CAMP_RESPAWN || 180;   // 해방된 캠프가 다시 점령되기까지(초)
// Cloudflare Realtime TURN (보이스 채팅 중계). 키는 환경변수에만 두고 브라우저에는 임시 자격 증명만 준다.
const TURN_KEY_ID = process.env.TURN_KEY_ID || '';
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN || '';
const TURN_API_BASE = process.env.TURN_API_BASE || 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TURN_TTL = 86400;
const { TYPES, TYPE_BY_ID, heightAt, pushOut, hitsCollider, inVillage, clamp, TAU } = W;
const rand = (a, b) => a + Math.random() * (b - a);
const angLerp = (a, b, t) => a + W.angDiff(a, b) * t;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ============================================================
//  정적 파일
// ============================================================
const ROOT = __dirname;
const STATIC = {
  '/': 'public/index.html', '/index.html': 'public/index.html',
  '/world.js': 'shared/world.js', '/lib/three.min.js': 'public/lib/three.min.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/turn') {
    getIceServers().then(ice => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(ice));
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, server: SERVER_NAME, players: players.size, max: MAX_PLAYERS }));
  }
  const rel = STATIC[url.pathname];
  if (!rel) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('찾을 수 없어요'); }
  fs.readFile(path.join(ROOT, rel), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream',
      'cache-control': rel.endsWith('three.min.js') ? 'public, max-age=604800' : 'no-cache' });
    res.end(buf);
  });
});

// ============================================================
//  TURN 임시 자격 증명 (모든 접속자가 함께 쓰고, 만료 1시간 전에 새로 받는다)
// ============================================================
const STUN_ONLY = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }], relay: false };
let iceCache = null, iceExpires = 0, icePending = null;
async function fetchCloudflareIce() {
  const headers = { Authorization: 'Bearer ' + TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ ttl: TURN_TTL });
  let r = await fetch(`${TURN_API_BASE}/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`, { method: 'POST', headers, body });
  if (r.status === 404) r = await fetch(`${TURN_API_BASE}/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate`, { method: 'POST', headers, body });
  if (!r.ok) throw new Error('TURN API ' + r.status);
  const j = await r.json();
  let list = Array.isArray(j.iceServers) ? j.iceServers : (j.iceServers ? [j.iceServers] : []);
  // 브라우저는 53번 포트 주소에서 시간이 오래 걸리므로 뺀다
  list = list.map(s => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);
  if (!list.some(s => s.urls.some(u => u.startsWith('turn')))) throw new Error('TURN 주소가 응답에 없어요');
  return { iceServers: list, relay: true };
}
function getIceServers() {
  if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) return Promise.resolve(STUN_ONLY);
  if (iceCache && Date.now() < iceExpires) return Promise.resolve(iceCache);
  if (!icePending) icePending = fetchCloudflareIce()
    .then(ice => { iceCache = ice; iceExpires = Date.now() + (TURN_TTL - 3600) * 1000; log('TURN 자격 증명 발급 완료'); return ice; })
    .catch(e => { log('TURN 발급 실패:', e.message); iceCache = null; iceExpires = 0; return STUN_ONLY; })
    .finally(() => { icePending = null; });
  return icePending;
}

// ============================================================
//  WebSocket (RFC 6455 최소 구현)
// ============================================================
class Conn {
  constructor(socket) {
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = []; this.closed = false; this.lastMsg = Date.now();
    this.onmessage = () => {}; this.onclose = () => {};
    socket.on('data', d => this.data(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > 256 * 1024) return this.close();
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (!(b1 & 0x80)) return this.close();          // 클라이언트 프레임은 반드시 마스킹
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; if (this.buf.readUInt32BE(2)) return this.close(); len = this.buf.readUInt32BE(6); off = 10; }
      if (len > 64 * 1024) return this.close();
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = this.buf[off + 4 + i] ^ mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.lastMsg = Date.now();
      if (op === 8) return this.close();
      if (op === 9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 1 || op === 0) {
        this.frag.push(payload);
        if (fin) { const text = Buffer.concat(this.frag).toString('utf8'); this.frag = []; try { this.onmessage(text); } catch (e) { log('message error', e.message); } }
      }
    }
  }
  frame(op, payload) {
    if (this.closed) return;
    const len = payload.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    this.s.write(Buffer.concat([h, payload]));
  }
  send(obj) { this.frame(1, Buffer.from(JSON.stringify(obj))); }
  get congested() { return this.s.writableLength > 512 * 1024; }
  close() { if (this.closed) return; try { this.frame(8, Buffer.alloc(0)); } catch (e) {} this.s.end(); this.finish(); }
  finish() { if (this.closed && this.done) return; this.closed = true; this.done = true; this.s.destroy(); this.onclose(); }
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  onConnect(new Conn(socket));
});

// ============================================================
//  월드 상태
// ============================================================
const players = new Map();      // id -> player
const enemies = new Map();      // id -> enemy
const balls = new Map();        // id -> ball
let nextId = 1, nextEnemy = 1, nextEBall = 1, patrolT = 10;
const camps = W.layout.camps.map(c => ({ idx: c.idx, def: c.def, R: c.R, alive: 0, liberated: false, respawnT: 0 }));
const gifts = [];
const heals = W.layout.heals.map(h => ({ x: h.x, z: h.z, on: true, respawn: 0 }));
const HEAL_RESPAWN = 25;

function broadcast(obj, except) { const s = JSON.stringify(obj), buf = Buffer.from(s); for (const p of players.values()) if (p !== except && p.ready) p.conn.frame(1, buf); }
function addEnemy(type, x, z, camp) {
  const T = TYPES[type];
  const e = { id: nextEnemy++, type, T, x, z, hp: T.hp, max: T.hp, camp, home: { x, z }, aggro: false, cool: rand(1, 2.5), wind: 0, flash: 0,
    kx: 0, kz: 0, face: rand(0, TAU), faceT: undefined, strafe: 0, strafeT: 0, wanderT: 0, tx: x, tz: z, shots: 0, moving: 0, far: false };
  enemies.set(e.id, e); if (camp) camp.alive++;
  return e;
}
function populateCamp(c) {
  for (const e of [...enemies.values()]) if (e.camp === c) enemies.delete(e.id);
  c.alive = 0; c.liberated = false; c.respawnT = 0;
  const d = c.def, list = [];
  for (let i = 0; i < d.snow; i++) list.push('snowman');
  for (let i = 0; i < d.peng; i++) list.push('penguin');
  if (d.boss) list.push('boss');
  list.forEach((t, i) => { const a = i / list.length * TAU + 0.4, r = t === 'boss' ? 4 : rand(4, 7.5); addEnemy(t, d.x + Math.cos(a) * r, d.z + Math.sin(a) * r, c); });
}
function openSpot(minFromPlayers = 0) {
  for (let k = 0; k < 200; k++) {
    const x = rand(-100, 100), z = rand(-100, 100);
    if (Math.hypot(x, z) < 16) continue;
    if (camps.some(c => Math.hypot(x - c.def.x, z - c.def.z) < c.R + 3)) continue;
    let near = false; for (const p of players.values()) if (Math.hypot(x - p.x, z - p.z) < minFromPlayers) near = true;
    if (near) continue;
    const o = { x, z }; pushOut(o, 1.5); if (Math.hypot(o.x - x, o.z - z) > 0.01) continue;
    return { x, z };
  }
  return { x: rand(-30, 30), z: rand(30, 40) };
}
function placeGift(i) { const s = openSpot(25); gifts[i] = { x: s.x, z: s.z, on: true, ti: Math.floor(Math.random() * 4), respawn: 0 }; }
camps.forEach(populateCamp);
for (let i = 0; i < 18; i++) placeGift(i);

// ============================================================
//  접속 처리
// ============================================================
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>]/g, '').trim().slice(0, 12);
function onConnect(conn) {
  let p = null;
  conn.onmessage = text => {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!p) {
      if (m.t !== 'hello') return;
      if (players.size >= MAX_PLAYERS) { conn.send({ t: 'full', max: MAX_PLAYERS }); return conn.close(); }
      const id = nextId++;
      p = { id, conn, n: cleanName(m.n) || '꼬마요정' + id, c: clamp(m.c | 0, 0, 5), x: rand(-3, 3), z: 12 + rand(-2, 2), y: 0, face: Math.PI, vx: 0, vz: 0,
        flags: 0, hp: W.MAX_HP, dead: false, score: 0, combo: 0, best: 0, kills: 0, tokens: 6, ready: true, voice: false, joined: Date.now() };
      p.y = heightAt(p.x, p.z);
      players.set(id, p);
      conn.send({ t: 'welcome', id, server: SERVER_NAME, x: p.x, z: p.z, players: [...players.values()].map(q => [q.id, q.n, q.c]),
        camps: camps.map(c => [c.liberated ? 1 : 0, c.alive, Math.ceil(c.respawnT)]), g: gifts.map(g => [r1(g.x), r1(g.z), g.on ? 1 : 0, g.ti]), h: heals.map(h => (h.on ? 1 : 0)) });
      broadcast({ t: 'pj', id, n: p.n, c: p.c }, p);
      log(`입장 ${p.n}#${id} (현재 ${players.size}명)`);
      return;
    }
    handle(p, m);
  };
  conn.onclose = () => {
    if (!p) return;
    players.delete(p.id);
    broadcast({ t: 'pl', id: p.id });
    log(`퇴장 ${p.n}#${p.id} (현재 ${players.size}명)`);
    p = null;
  };
}
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
function handle(p, m) {
  switch (m.t) {
    case 'p': {
      p.x = clamp(num(m.x, p.x), -W.LIMIT, W.LIMIT); p.z = clamp(num(m.z, p.z), -W.LIMIT, W.LIMIT);
      p.y = clamp(num(m.y, p.y), -20, 60); p.face = num(m.f, p.face);
      p.vx = clamp(num(m.vx), -40, 40); p.vz = clamp(num(m.vz), -40, 40);
      p.flags = m.fl | 0; p.hp = clamp(m.hp | 0, 0, W.MAX_HP);
      const dead = !!m.d;
      if (dead && !p.dead) { p.score = Math.max(0, p.score - 300); p.combo = 0; }
      p.dead = dead;
      break;
    }
    case 'th': {                 // 눈덩이 던지기
      if (p.dead || p.tokens < 1) return;
      p.tokens -= 1;
      const x = num(m.x, p.x), z = num(m.z, p.z);
      if (Math.hypot(x - p.x, z - p.z) > 4) return;
      let dx = num(m.dx), dz = num(m.dz); const dl = Math.hypot(dx, dz); if (dl < 0.5) return; dx /= dl; dz /= dl;
      const ch = !!m.ch, gi = !!m.gi, big = (ch ? 1 : 0) + (gi ? 1 : 0);
      const angs = m.tri ? [-0.15, 0, 0.15] : [0];
      const h = clamp(num(m.h, W.BALL_H), 0.5, 8), cid = m.cid | 0;
      angs.forEach((a, k) => {
        const c = Math.cos(a), s = Math.sin(a), bx = dx * c + dz * s, bz = -dx * s + dz * c;
        const b = { id: `${p.id}.${cid}.${k}`, owner: p.id, x, z, h, dx: bx, dz: bz, spd: ch ? 40 : 32, r: 0.28 + big * 0.14, dmg: 1 + big, dist: 0, max: W.PLAYER_RANGE, fall: 0, hit: false };
        balls.set(b.id, b);
        broadcast({ t: 'b', id: b.id, o: p.id, x: r1(x), z: r1(z), h: r1(h), dx: r2(bx), dz: r2(bz), s: b.spd, r: r2(b.r) }, p);
      });
      break;
    }
    case 'hurt': {               // 적 눈덩이에 맞음 (맞은 사람이 직접 알림)
      const b = balls.get(String(m.id));
      if (b && b.owner === 'e') { endBall(b, true); p.combo = 0; }
      break;
    }
    case 'gift': {
      const i = m.i | 0, g = gifts[i];
      if (!g || !g.on || p.dead || Math.hypot(g.x - p.x, g.z - p.z) > 3.5) return;
      g.on = false; g.respawn = 40; p.score += 50;
      broadcast({ t: 'gift', i, by: p.id, k: W.GIFT_KINDS[g.ti] });
      break;
    }
    case 'heal': {               // 힐팩 줍기
      const i = m.i | 0, h = heals[i];
      if (!h || !h.on || p.dead || Math.hypot(h.x - p.x, h.z - p.z) > 3.5) return;
      h.on = false; h.respawn = HEAL_RESPAWN;
      broadcast({ t: 'hoff', i, by: p.id });
      break;
    }
    case 'voice': {              // 보이스 채팅 참여/해제
      p.voice = !!m.on;
      break;
    }
    case 'rtc': {                // WebRTC 연결 신호 전달 (서버는 내용을 보지 않고 상대에게만 넘긴다)
      const to = players.get(m.to | 0);
      if (!to || to === p || !p.voice || !to.voice || !m.d || typeof m.d !== 'object') return;
      if (JSON.stringify(m.d).length > 20000) return;
      to.conn.send({ t: 'rtc', from: p.id, d: m.d });
      break;
    }
    case 'chat': {
      const text = String(m.s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').trim().slice(0, 60);
      if (!text || Date.now() - (p.lastChat || 0) < 1200) return;
      p.lastChat = Date.now();
      broadcast({ t: 'chat', id: p.id, s: text });
      break;
    }
  }
}

// ============================================================
//  시뮬레이션
// ============================================================
function targets() {
  const list = [];
  for (const p of players.values()) if (!p.dead && !inVillage(p.x, p.z)) list.push(p);
  return list;
}
function aiEnemy(e, dt, tg) {
  const T = e.T;
  e.flash = Math.max(0, e.flash - dt);
  e.x += e.kx * dt; e.z += e.kz * dt; const damp = Math.pow(0.004, dt); e.kx *= damp; e.kz *= damp;
  let tgt = null, d = 1e9;
  for (const t of tg) { const dd = Math.hypot(t.x - e.x, t.z - e.z); if (dd < d) { d = dd; tgt = t; } }
  let nearest = 1e9; for (const p of players.values()) nearest = Math.min(nearest, Math.hypot(p.x - e.x, p.z - e.z));
  e.far = nearest > 95;
  const aggroR = e.type === 'boss' ? 32 : 25;
  if (tgt && d < aggroR) e.aggro = true;
  if (!tgt || d > aggroR + 18) e.aggro = false;
  if (e.camp && Math.hypot(e.x - e.home.x, e.z - e.home.z) > 34) e.aggro = false;
  let mx = 0, mz = 0, spd = T.speed;
  if (e.aggro && tgt) {
    const dx = tgt.x - e.x, dz = tgt.z - e.z;
    e.faceT = Math.atan2(dx, dz);
    if (d > T.range + 3) { mx = dx / d; mz = dz / d; } else if (d < T.range - 4) { mx = -dx / d; mz = -dz / d; }
    e.strafeT -= dt; if (e.strafeT <= 0) { e.strafe = [-1, 0, 1][Math.floor(Math.random() * 3)]; e.strafeT = rand(1, 2.5); }
    mx += -dz / d * e.strafe * 0.7; mz += dx / d * e.strafe * 0.7;
    if (e.wind > 0) { e.wind -= dt; mx *= 0.15; mz *= 0.15; if (e.wind <= 0) { enemyThrow(e, tgt); e.cool = rand(...T.cool); } }
    else { e.cool -= dt; if (e.cool <= 0 && d < T.maxRange) e.wind = T.wind; }
  } else if (!e.far) {
    e.wind = 0; e.wanderT -= dt;
    if (e.wanderT <= 0) { e.wanderT = rand(2, 5); const a = rand(0, TAU), r = rand(0, e.camp ? 6 : 12); e.tx = e.home.x + Math.cos(a) * r; e.tz = e.home.z + Math.sin(a) * r; }
    const tx = e.tx - e.x, tz = e.tz - e.z, td = Math.hypot(tx, tz);
    if (td > 0.6) { mx = tx / td; mz = tz / td; spd *= 0.45; e.faceT = Math.atan2(tx, tz); }
  } else { e.wind = 0; e.moving = 0; return; }
  const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
  e.x += mx * spd * dt; e.z += mz * spd * dt;
  e.moving = ml > 0.1 ? 1 : 0;
  const vd = Math.hypot(e.x, e.z), wall = W.VILLAGE_SAFE + 3;
  if (vd < wall) { e.x = e.x / vd * wall; e.z = e.z / vd * wall; }
  e.x = clamp(e.x, -W.LIMIT, W.LIMIT); e.z = clamp(e.z, -W.LIMIT, W.LIMIT);
  pushOut(e, T.r);
  if (e.faceT !== undefined) e.face = angLerp(e.face, e.faceT, Math.min(1, dt * 6));
}
function enemyThrow(e, target) {
  const T = e.T;
  const d = Math.hypot(target.x - e.x, target.z - e.z), tFlight = d / T.spd;
  const tx = target.x + target.vx * tFlight * 0.6, tz = target.z + target.vz * tFlight * 0.6;
  const base = Math.atan2(tx - e.x, tz - e.z);
  const angs = [];
  if (e.type === 'boss') {
    if (e.shots % 3 === 2) for (let i = 0; i < 14; i++) angs.push({ a: i / 14 * TAU, spd: T.spd * 0.8 });
    else for (let i = -2; i <= 2; i++) angs.push({ a: base + i * 0.22, spd: T.spd });
  } else angs.push({ a: base + rand(-T.err, T.err), spd: T.spd });
  e.shots++; e.face = base;
  const r = e.type === 'boss' ? 0.45 : 0.3, h = e.type === 'boss' ? 2.2 : W.BALL_H;
  for (const s of angs) {
    const dx = Math.sin(s.a), dz = Math.cos(s.a);
    const b = { id: 'e' + (nextEBall++), owner: 'e', x: e.x + dx * (T.r + 0.3), z: e.z + dz * (T.r + 0.3), h, dx, dz, spd: s.spd, r, dmg: T.dmg, dist: 0, max: 34, fall: 0 };
    balls.set(b.id, b);
    broadcast({ t: 'b', id: b.id, o: 'e', x: r1(b.x), z: r1(b.z), h: r1(h), dx: r2(dx), dz: r2(dz), s: r1(b.spd), r: r2(r), dm: T.dmg });
  }
}
function endBall(b, silent) {
  balls.delete(b.id);
  if (!b.hit && b.owner !== 'e') { const p = players.get(b.owner); if (p) p.combo = 0; }
  if (!silent || b.owner === 'e') broadcast({ t: 'be', id: b.id, x: r1(b.x), y: r1(heightAt(b.x, b.z) + b.h), z: r1(b.z) });
}
function applyHit(e, b) {
  const p = players.get(b.owner);
  e.hp -= b.dmg; e.flash = 0.15; e.aggro = true;
  e.kx = b.dx * 10 / e.T.scale; e.kz = b.dz * 10 / e.T.scale;
  if (e.camp) for (const o of enemies.values()) if (o.camp === e.camp) o.aggro = true;
  let pts = 0;
  if (p) {
    p.combo++; p.best = Math.max(p.best, p.combo);
    const mult = Math.min(4, 1 + Math.floor(p.combo / 3) * 0.5);
    pts = e.hp <= 0 ? Math.round((e.camp ? e.T.pts : 75) * mult) : 10;
    p.score += pts; if (e.hp <= 0) p.kills++;
  }
  broadcast({ t: 'hit', id: b.id, e: e.id, by: b.owner, x: r1(b.x), y: r1(heightAt(b.x, b.z) + b.h), z: r1(b.z), k: e.hp <= 0 ? 1 : 0, pts, cb: p ? p.combo : 0 });
  if (e.hp <= 0) {
    enemies.delete(e.id);
    if (e.camp) { e.camp.alive--; if (e.camp.alive <= 0) liberate(e.camp, p); }
  }
}
function liberate(c, by) {
  c.liberated = true; c.respawnT = CAMP_RESPAWN;
  const bonus = c.def.boss ? 5000 : 1000;
  const helpers = [];
  for (const p of players.values()) if (p === by || Math.hypot(p.x - c.def.x, p.z - c.def.z) < 55) { p.score += bonus; helpers.push(p.id); }
  broadcast({ t: 'lib', c: c.idx, by: by ? by.n : '', bonus, helpers });
  log(`${c.def.name} 해방 by ${by ? by.n : '?'}`);
  const i = gifts.findIndex(g => !g.on); if (i >= 0) { gifts[i] = { x: c.def.x + 3, z: c.def.z + 3, on: true, ti: Math.floor(Math.random() * 4), respawn: 0 }; }
  if (camps.every(k => k.liberated)) {
    for (const p of players.values()) p.score += 2000;
    broadcast({ t: 'allfree' });
    log('모든 캠프 해방!');
  }
}
function step(dt) {
  const active = players.size > 0;
  for (const p of players.values()) p.tokens = Math.min(8, p.tokens + dt * 7);
  if (active) {
    patrolT -= dt;
    if (patrolT <= 0) {
      patrolT = 14;
      let patrols = 0; for (const e of enemies.values()) if (!e.camp) patrols++;
      if (patrols < 3 + Math.min(5, Math.floor(players.size / 2))) { const s = openSpot(55); if (Math.hypot(s.x, s.z) > 45) addEnemy('penguin', s.x, s.z, null); }
    }
    const tg = targets();
    for (const e of enemies.values()) aiEnemy(e, dt, tg);
    const list = [...enemies.values()];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), m = a.T.r + b.T.r;
      if (d < m && d > 1e-4) { const k = (m - d) / 2 / d; a.x -= dx * k; a.z -= dz * k; b.x += dx * k; b.z += dz * k; }
    }
  }
  // 눈덩이
  for (const b of [...balls.values()]) {
    const st = b.spd * dt;
    b.x += b.dx * st; b.z += b.dz * st; b.dist += st;
    if (b.dist > b.max) { b.fall += 22 * dt; b.h -= b.fall * dt; }
    else if (b.h < 2) b.h += (W.BALL_H - b.h) * Math.min(1, dt * 3);
    const y = heightAt(b.x, b.z) + b.h;
    if (b.h <= 0.1 || Math.abs(b.x) > 140 || Math.abs(b.z) > 140 || hitsCollider(b.x, y, b.z, b.r)) { endBall(b, b.owner !== 'e'); continue; }
    if (b.owner !== 'e') {
      for (const e of enemies.values()) {
        if (Math.hypot(b.x - e.x, b.z - e.z) < e.T.r + b.r && y > heightAt(e.x, e.z) - 0.3 && y < heightAt(e.x, e.z) + e.T.h) {
          b.hit = true; balls.delete(b.id); applyHit(e, b); break;
        }
      }
    }
  }
  // 선물, 캠프 재점령
  gifts.forEach((g, i) => { if (!g.on) { g.respawn -= dt; if (g.respawn <= 0) placeGift(i); } });
  heals.forEach((h, i) => { if (!h.on) { h.respawn -= dt; if (h.respawn <= 0) { h.on = true; broadcast({ t: 'hon', i }); } } });
  for (const c of camps) if (c.liberated) {
    c.respawnT -= dt;
    if (c.respawnT <= 0) {
      let close = false; for (const p of players.values()) if (Math.hypot(p.x - c.def.x, p.z - c.def.z) < 40) close = true;
      if (close) c.respawnT = 10;
      else { populateCamp(c); broadcast({ t: 'camp', c: c.idx }); }
    }
  }
}
let tick = 0;
function snapshot() {
  const ps = [...players.values()].map(p => [p.id, r1(p.x), r1(p.z), r1(p.y), r2(p.face), r1(p.vx), r1(p.vz), p.flags, p.hp, p.dead ? 1 : 0, p.score, p.voice ? 1 : 0]);
  const cs = camps.map(c => [c.liberated ? 1 : 0, c.alive, Math.ceil(Math.max(0, c.respawnT))]);
  const gs = gifts.map(g => [r1(g.x), r1(g.z), g.on ? 1 : 0, g.ti]);
  const hs = heals.map(h => (h.on ? 1 : 0));
  const es = [...enemies.values()];
  for (const p of players.values()) {
    if (!p.ready || p.conn.congested) continue;
    const near = es.filter(e => Math.abs(e.x - p.x) < 110 && Math.abs(e.z - p.z) < 110)
      .map(e => [e.id, e.T.id, r1(e.x), r1(e.z), r2(e.face), e.hp, e.max, e.wind > 0 ? 1 : 0, e.flash > 0 ? 1 : 0, e.moving]);
    p.conn.send({ t: 's', p: ps, e: near, c: cs, g: tick % 10 === 0 ? gs : undefined, h: tick % 10 === 0 ? hs : undefined, cb: p.combo });
  }
}
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt); tick++;
  if (tick % SNAP_EVERY === 0) snapshot();
}, 1000 / TICK);
// 응답 없는 연결 정리
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) { if (now - p.conn.lastMsg > 30000) p.conn.close(); else p.conn.frame(9, Buffer.alloc(0)); }
}, 10000);

server.listen(PORT, () => log(`${SERVER_NAME} 시작: http://localhost:${PORT} · 보이스 중계(TURN): ${TURN_KEY_ID && TURN_KEY_API_TOKEN ? '설정됨' : '없음 (직접 연결만)'}`));
