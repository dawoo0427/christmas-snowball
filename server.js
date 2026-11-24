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
  '/world.js': 'shared/world.js', '/lib/three.min.js': 'public/lib/three.min.js', '/i18n.js': 'public/i18n.js',
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
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });   // GitHub Pages 대기 화면에서 확인
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
    this.s = socket; this.buf = Buffer.alloc(0); this.frag = []; this.closed = false; this.lastMsg = Date.now(); this.lastApp = Date.now();
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
let nextId = 1, nextEnemy = 1, nextEBall = 1;
// 필드 몬스터 스폰 지점: 몬스터가 죽으면 MOB_RESPAWN초 뒤 같은 자리에서 다시 나타난다
const spawns = W.layout.spawns.map(sp => ({ ...sp, eid: 0, timer: 0 }));
const gifts = [];
const recentBalls = new Map();   // 방금 사라진 플레이어 눈덩이 (늦게 도착한 명중 신고를 받아주기 위해 잠깐 보관)
const HIT_SLACK = 4;             // 명중 신고 허용 오차 (통신 지연과 화면 보간 차이)
const drops = new Map(); let nextDrop = 1;
const heals = W.layout.heals.map(h => ({ x: h.x, z: h.z, on: true, respawn: 0 }));
const HEAL_RESPAWN = W.HEAL_RESPAWN;
const ornaments = [];            // 초대형 트리 장식 [{ id, k, a, y, n }] (서버가 켜져 있는 동안 유지)
let nextOrn = 1;
const ornRow = o => [o.id, o.k, r2(o.a), r2(o.y), o.n, o.pid];
const igloos = new Map();        // 주인 id -> { id, x, z, rot, n }
const igList = () => [...igloos.values()];
const igRow = ig => [ig.id, r1(ig.x), r1(ig.z), r2(ig.rot), ig.n, ig.lv];

function broadcast(obj, except) { const s = JSON.stringify(obj), buf = Buffer.from(s); for (const p of players.values()) if (p !== except && p.ready) p.conn.frame(1, buf); }
function addEnemy(type, x, z, spawn) {
  const T = TYPES[type];
  const e = { id: nextEnemy++, type, T, x, z, hp: T.hp, max: T.hp, spawn, home: { x, z }, aggro: false, cool: rand(1, 2.5), wind: 0, flash: 0,
    kx: 0, kz: 0, face: rand(0, TAU), faceT: undefined, strafe: 0, strafeT: 0, wanderT: 0, tx: x, tz: z, shots: 0, moving: 0, far: false };
  enemies.set(e.id, e); if (spawn) spawn.eid = e.id;
  return e;
}
function openSpot(minFromPlayers = 0) {
  for (let k = 0; k < 200; k++) {
    const x = rand(-W.LIMIT + 24, W.LIMIT - 24), z = rand(-W.LIMIT + 24, W.LIMIT - 24);
    if (Math.hypot(x, z) < 16 || Math.hypot(x - W.GIANT_TREE.x, z - W.GIANT_TREE.z) < W.GIANT_TREE.r + 3) continue;
    let near = false; for (const p of players.values()) if (Math.hypot(x - p.x, z - p.z) < minFromPlayers) near = true;
    if (near) continue;
    const o = { x, z }; pushOut(o, 1.5); if (Math.hypot(o.x - x, o.z - z) > 0.01) continue;
    return { x, z };
  }
  return { x: rand(-30, 30), z: rand(30, 40) };
}
const randGift = () => Math.floor(Math.random() * W.GIFT_KINDS.length);
function placeGift(i) { const s = openSpot(25); gifts[i] = { x: s.x, z: s.z, on: true, ti: randGift(), respawn: 0 }; }
for (const sp of spawns) addEnemy(sp.type, sp.x, sp.z, sp);
const GIFT_COUNT = 90;                 // 맵이 4배 넓어져서 선물도 늘림
for (let i = 0; i < GIFT_COUNT; i++) placeGift(i);

// ============================================================
//  접속 처리
// ============================================================
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>]/g, '').trim().slice(0, 12);
function onConnect(conn) {
  let p = null;
  conn.onmessage = text => {
    conn.lastApp = Date.now();          // 게임 화면이 보낸 메시지만 '살아 있음'으로 친다 (ping 응답은 제외)
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!p) {
      if (m.t !== 'hello') return;
      if (players.size >= MAX_PLAYERS) { conn.send({ t: 'full', max: MAX_PLAYERS }); return conn.close(); }
      const id = nextId++;
      const look = W.cleanLook(m.look || { c: m.c });
      p = { id, conn, look, n: cleanName(m.n) || '꼬마요정' + id, c: look.c, x: rand(-3, 3), z: 12 + rand(-2, 2), y: 0, face: Math.PI, vx: 0, vz: 0,
        flags: 0, hp: W.MAX_HP, dead: false, score: +process.env.START_SCORE || 0, combo: 0, best: 0, kills: 0, tokens: 6, ready: true, vl: false, vt: false, lastHitBy: 0, lastHitAt: 0, joined: Date.now(), allies: new Set(), reqTo: new Set() };
      p.y = heightAt(p.x, p.z);
      players.set(id, p);
      conn.send({ t: 'welcome', id, server: SERVER_NAME, x: p.x, z: p.z, players: [...players.values()].map(q => [q.id, q.n, q.c, q.look]), drops: [...drops.values()].map(d => [d.id, r1(d.x), r1(d.z), d.k]),
        g: gifts.map(g => [r1(g.x), r1(g.z), g.on ? 1 : 0, g.ti]), h: heals.map(h => (h.on ? 1 : 0)), ig: igList().map(igRow), orn: ornaments.map(ornRow) });
      broadcast({ t: 'pj', id, n: p.n, c: p.c, look: p.look }, p);
      log(`입장 ${p.n}#${id} (현재 ${players.size}명)`);
      return;
    }
    handle(p, m);
  };
  conn.onclose = () => {
    if (!p) return;
    players.delete(p.id);
    for (const q of players.values()) { q.reqTo.delete(p.id); if (q.allies.delete(p.id)) sendAllies(q); }
    if (igloos.delete(p.id)) broadcast({ t: 'igx', id: p.id });
    broadcast({ t: 'pl', id: p.id });
    log(`퇴장 ${p.n}#${p.id} (현재 ${players.size}명)`);
    p = null;
  };
}
function sendAllies(p) { p.conn.send({ t: 'allies', ids: [...p.allies] }); }
function makeAllies(a, b) {
  a.reqTo.delete(b.id); b.reqTo.delete(a.id);
  if (a.allies.size >= W.MAX_ALLIES || b.allies.size >= W.MAX_ALLIES) { a.conn.send({ t: 'allyNo', id: b.id, why: 'full' }); b.conn.send({ t: 'allyNo', id: a.id, why: 'full' }); return; }
  a.allies.add(b.id); b.allies.add(a.id); sendAllies(a); sendAllies(b);
  a.conn.send({ t: 'allyOk', id: b.id }); b.conn.send({ t: 'allyOk', id: a.id });
}
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
function handle(p, m) {
  switch (m.t) {
    case 'p': {
      p.x = clamp(num(m.x, p.x), -W.LIMIT, W.LIMIT); p.z = clamp(num(m.z, p.z), -W.LIMIT, W.LIMIT);
      p.y = clamp(num(m.y, p.y), -20, 60); p.face = num(m.f, p.face);
      p.vx = clamp(num(m.vx), -40, 40); p.vz = clamp(num(m.vz), -40, 40);
      p.flags = (m.fl | 0) & (p.sled ? ~0 : ~2048);     // 2048 = 눈썰매 타는 중 (산 사람만) p.hp = clamp(m.hp | 0, 0, W.MAX_HP);
      const dead = !!m.d;
      if (dead && !p.dead) {
        p.score = Math.max(0, p.score - 300); p.combo = 0;
        const a = players.get(p.lastHitBy);
        if (a && a !== p && Date.now() - p.lastHitAt < 6000) { a.score += W.KO_POINTS; a.kills++; broadcast({ t: 'ko', a: a.id, v: p.id }); }
        p.lastHitBy = 0;
      }
      p.dead = dead;
      break;
    }
    case 'th': {                 // 눈덩이 던지기: 한 번 던질 때 메시지 하나, 여러 발은 각자 화면이 같은 규칙으로 펼친다
      if (p.dead || p.tokens < 1 || (p.flags & 2048)) return;      // 썰매 타는 동안은 공격 불가
      p.tokens -= 1;
      const x = num(m.x, p.x), z = num(m.z, p.z);
      if (Math.hypot(x - p.x, z - p.z) > 8) return;
      let dx = num(m.dx), dz = num(m.dz); const dl = Math.hypot(dx, dz); if (dl < 0.5) return; dx /= dl; dz /= dl;
      const ch = m.ch ? 1 : 0, st = W.cleanStacks(m.st), bs = W.ballStats(st, ch);
      const pv = !inVillage(p.x, p.z);          // 안전지대 밖에서 던진 눈덩이만 플레이어를 맞힐 수 있다
      const h = clamp(num(m.h, W.BALL_H), 0.5, 8), cid = m.cid | 0;
      for (const v of W.volley(st)) {
        const c = Math.cos(v.a), sn = Math.sin(v.a), bx = dx * c + dz * sn, bz = -dx * sn + dz * c;
        const b = { id: `${p.id}.${cid}.${v.k}`, owner: p.id, x, z, h, dx: bx, dz: bz, spd: bs.spd * v.sm, r: bs.r, dmg: bs.dmg, pv, dist: 0, max: bs.max, fall: 0, hit: false,
          pierce: bs.pierce, boom: bs.boom, ice: bs.ice, hitE: null };
        balls.set(b.id, b);
      }
      broadcast({ t: 'b', id: `${p.id}.${cid}`, o: p.id, x: r2(x), z: r2(z), h: r2(h), dx: r2(dx), dz: r2(dz), ch, st, pv: pv ? 1 : 0 }, p);
      break;
    }
    case 'hc': {                 // 내 화면에서 맞은 걸 신고 → 서버가 거리만 확인하고 바로 적용 (공격 씹힘 방지)
      const id = String(m.id), b = balls.get(id) || recentBalls.get(id);
      if (!b || b.owner !== p.id || b.hit) break;
      if (m.e) {
        const e = enemies.get(m.e | 0);
        if (!e || Math.hypot(b.x - e.x, b.z - e.z) > e.T.r + b.r + HIT_SLACK) break;
        hitEnemy(b, e);
      } else if (m.v) {
        const v = players.get(m.v | 0);
        if (!v || v === p || v.dead || !b.pv || p.allies.has(v.id) || inVillage(v.x, v.z) || Math.hypot(b.x - v.x, b.z - v.z) > 0.6 + b.r + HIT_SLACK) break;
        b.hit = true; balls.delete(id); recentBalls.delete(id);
        broadcast({ t: 'be', id, x: r1(b.x), y: r1(heightAt(b.x, b.z) + b.h), z: r1(b.z) });
        v.lastHitBy = p.id; v.lastHitAt = Date.now(); p.score += 5;
        v.conn.send({ t: 'dmg', id, a: W.pvpDmg(b.dmg), by: p.id, ic: b.ice || 0 });
      }
      break;
    }
    case 'pick': {               // 나쁜 산타가 떨어뜨린 선물 줍기
      const d = drops.get(m.id | 0);
      if (!d || p.dead || Math.hypot(d.x - p.x, d.z - p.z) > 3.5) break;
      drops.delete(d.id); p.score += 80;
      broadcast({ t: 'dropx', id: d.id, by: p.id, k: d.k });
      break;
    }
    case 'ally': {               // 동맹 신청 (상대도 나에게 신청해 둔 상태면 바로 동맹)
      const q = players.get(m.id | 0);
      if (!q || q === p || p.allies.has(q.id)) break;
      if (q.reqTo.has(p.id)) { makeAllies(p, q); break; }
      if (p.reqTo.has(q.id)) break;
      p.reqTo.add(q.id); q.conn.send({ t: 'allyReq', from: p.id });
      break;
    }
    case 'allyAns': {            // 신청에 대한 대답
      const q = players.get(m.id | 0);
      if (!q || !q.reqTo.has(p.id)) break;
      if (m.ok) makeAllies(p, q); else { q.reqTo.delete(p.id); q.conn.send({ t: 'allyNo', id: p.id }); }
      break;
    }
    case 'unally': {             // 동맹 해제
      const q = players.get(m.id | 0);
      if (!q || !p.allies.delete(q.id)) break;
      q.allies.delete(p.id); sendAllies(p); sendAllies(q); q.conn.send({ t: 'allyOff', id: p.id });
      break;
    }
    case 'igloo': {              // 이글루 짓기 (5000점 차감). 이미 있으면 같은 레벨 그대로 옮기기(무료)
      const x = num(m.x), z = num(m.z), rot = num(m.rot), old = igloos.get(p.id), lv = old ? old.lv : 0;
      const cost = old ? 0 : W.IGLOO.LV[0].cost;
      let why = '', wv;     // 안내 문구는 한국어 키 + 값(wv)으로 보내고, 화면이 선택한 언어로 번역한다
      if (p.dead) why = '쓰러진 상태에서는 지을 수 없어요';
      else if (p.score < cost) { why = '이글루는 {n}점이 필요해요'; wv = { n: cost }; }
      else if (Math.hypot(x - p.x, z - p.z) > 16) why = '너무 멀어요';
      else why = W.iglooSpot(x, z, igList(), p.id, W.IGLOO.LV[lv].r);
      if (why) { p.conn.send({ t: 'igfail', why, wv }); break; }
      p.score -= cost;
      const ig = W.igDims({ id: p.id, x, z, rot, n: p.n, lv });
      igloos.set(p.id, ig);
      broadcast({ t: 'ig', i: igRow(ig), cost, mv: old ? 1 : 0 });
      break;
    }
    case 'igup': {               // 얼음성으로 업그레이드 (점수 차감)
      const ig = igloos.get(p.id);
      if (!ig) { p.conn.send({ t: 'igfail', why: '먼저 이글루를 지어 주세요' }); break; }
      if (ig.lv >= W.IGLOO.LV.length - 1) { p.conn.send({ t: 'igfail', why: '이미 최종 얼음성이에요' }); break; }
      const next = W.IGLOO.LV[ig.lv + 1];
      let why = p.score < next.cost ? '{name}은 {n}점이 필요해요' : W.iglooSpot(ig.x, ig.z, igList(), p.id, next.r);
      const wv = { n: next.cost, lv: ig.lv + 1 };
      if (why && why.includes('가까워요')) why = '주변이 좁아서 넓힐 수 없어요 (나무·바위·다른 이글루). 넓은 곳으로 옮긴 뒤 다시 해 보세요';
      if (why) { p.conn.send({ t: 'igfail', why, wv }); break; }
      p.score -= next.cost; ig.lv++; W.igDims(ig);
      broadcast({ t: 'ig', i: igRow(ig), cost: next.cost, up: 1 });
      break;
    }
    case 'buy': {                // 눈썰매 구매 (50,000점 차감, 접속해 있는 동안 계속 보유)
      if (m.item !== 'sled') break;
      if (p.sled) { p.conn.send({ t: 'bought', item: 'sled' }); break; }
      if (p.score < W.SLED.cost) { p.conn.send({ t: 'buyfail', why: '{n}점이 필요해요', wv: { n: W.SLED.cost } }); break; }
      p.score -= W.SLED.cost; p.sled = true;
      p.conn.send({ t: 'bought', item: 'sled', cost: W.SLED.cost });
      break;
    }
    case 'orn': {                // 초대형 트리에 오너먼트 달기 (1,000점 차감)
      const T = W.GIANT_TREE, k = String(m.k), y = num(m.y), a = num(m.a);
      let why = '';
      if (!W.ORNAMENTS.some(o => o.k === k)) why = '알 수 없는 장식이에요';
      else if (Math.hypot(p.x - T.x, p.z - T.z) > T.near + 6) why = '트리 가까이에서 꾸밀 수 있어요';
      else if (p.score < T.ornCost) why = '오너먼트 하나에 {n}점이 필요해요';
      else if (ornaments.length >= T.maxOrn) why = '트리가 장식으로 가득 찼어요!';
      else if (!(y >= T.trunk + 0.3 && y <= T.h - 0.5)) why = '트리 위에 달아 주세요';
      if (why) { p.conn.send({ t: 'ornfail', why, wv: { n: T.ornCost } }); break; }
      p.score -= T.ornCost;
      const o = { id: nextOrn++, k, a, y, n: p.n, pid: p.id };
      ornaments.push(o);
      broadcast({ t: 'orn', o: ornRow(o), by: p.id });
      break;
    }
    case 'ornundo': {            // 내가 단 오너먼트 되돌리기 (마지막 것부터, 점수 돌려받기)
      let i = -1;
      if (m.id) i = ornaments.findIndex(o => o.id === (m.id | 0) && o.pid === p.id);
      else for (let j = ornaments.length - 1; j >= 0; j--) if (ornaments[j].pid === p.id) { i = j; break; }
      if (i < 0) { p.conn.send({ t: 'ornfail', why: '되돌릴 내 장식이 없어요' }); break; }
      const [o] = ornaments.splice(i, 1);
      p.score += W.GIANT_TREE.ornCost;
      broadcast({ t: 'ornx', id: o.id, by: p.id });
      break;
    }
    case 'fish': {               // 얼음낚시 시작/그만
      if (m.on && !p.dead && W.onIce(p.x, p.z)) p.fishing = { x: p.x, z: p.z, t: W.FISH_EVERY };
      else p.fishing = null;
      break;
    }
    case 'look': {               // 꾸미기 변경
      p.look = W.cleanLook(m.look); p.c = p.look.c;
      broadcast({ t: 'lk', id: p.id, look: p.look });
      break;
    }
    case 'hurt': {               // 적 눈덩이에 맞음 (맞은 사람이 직접 알림)
      const b = balls.get(String(m.id));
      if (!b) break;
      if (b.owner === 'e') { endBall(b, true); p.combo = 0; }
      else if (b.pv && b.owner !== p.id && !p.allies.has(b.owner) && !inVillage(p.x, p.z)) {     // PvP: 다른 플레이어의 눈덩이에 맞음
        b.hit = true; balls.delete(b.id);
        broadcast({ t: 'be', id: b.id, x: r1(b.x), y: r1(heightAt(b.x, b.z) + b.h), z: r1(b.z) });
        p.lastHitBy = b.owner; p.lastHitAt = Date.now();
        const a = players.get(b.owner); if (a) a.score += 5;
      }
      break;
    }
    case 'gift': {
      const i = m.i | 0, g = gifts[i];
      if (!g || !g.on || p.dead || Math.hypot(g.x - p.x, g.z - p.z) > 3.5) return;
      g.on = false; g.respawn = W.GIFT_RESPAWN; p.score += 50;
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
    case 'voice': {              // 보이스 채팅: 듣기(l) / 말하기(k)
      p.vl = !!m.l; p.vt = !!m.k;
      break;
    }
    case 'rtc': {                // WebRTC 연결 신호 전달 (서버는 내용을 보지 않고 상대에게만 넘긴다)
      const to = players.get(m.to | 0);
      if (!to || to === p || !(p.vl || p.vt) || !(to.vl || to.vt) || !m.d || typeof m.d !== 'object') return;
      if (JSON.stringify(m.d).length > 20000) return;
      to.conn.send({ t: 'rtc', from: p.id, d: m.d });
      break;
    }
    case 'hb': break;                // 1초마다 오는 생존 신호
    case 'bye': p.conn.close(); break;  // 나가기·탭 닫기: 즉시 제거
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
  const sl = e.slow > 0 ? 0.4 : 1; if (e.slow > 0) e.slow -= dt;     // 얼음 눈덩이에 맞으면 느려진다
  dt *= sl;
  e.x += e.kx * dt; e.z += e.kz * dt; const damp = Math.pow(0.004, dt); e.kx *= damp; e.kz *= damp;
  let tgt = null, d = 1e9;
  for (const t of tg) { const dd = Math.hypot(t.x - e.x, t.z - e.z); if (dd < d) { d = dd; tgt = t; } }
  let nearest = 1e9; for (const p of players.values()) nearest = Math.min(nearest, Math.hypot(p.x - e.x, p.z - e.z));
  e.far = nearest > 95;
  const aggroR = T.boss ? 20 : e.type === 'badsanta' ? 17 : 14;      // 플레이어를 알아차리는 거리
  if (tgt && d < aggroR) e.aggro = true;
  if (!tgt || d > aggroR + 12) e.aggro = false;                       // 이만큼 멀어지면 포기
  if (Math.hypot(e.x - e.home.x, e.z - e.home.z) > (T.boss ? 75 : 40)) e.aggro = false;
  let mx = 0, mz = 0, spd = T.speed;
  if (e.aggro && tgt && T.melee) {
    // 근거리형(하프물범): 곧장 다가가서, 가까우면 몸을 일으켰다가(예고) 배치기로 주변을 내려친다
    const dx = tgt.x - e.x, dz = tgt.z - e.z;
    if (e.wind > 0) { e.wind -= dt; if (e.wind <= 0) { meleeStrike(e); e.cool = rand(...T.cool); } }
    else {
      e.faceT = Math.atan2(dx, dz);
      if (d > T.range) { mx = dx / d; mz = dz / d; }
      e.cool -= dt; if (e.cool <= 0 && d < T.reach - 0.4) e.wind = T.wind;
    }
  } else if (e.aggro && tgt) {
    const dx = tgt.x - e.x, dz = tgt.z - e.z;
    e.faceT = Math.atan2(dx, dz);
    if (d > T.range + 3) { mx = dx / d; mz = dz / d; } else if (d < T.range - 4) { mx = -dx / d; mz = -dz / d; }
    e.strafeT -= dt; if (e.strafeT <= 0) { e.strafe = [-1, 0, 1][Math.floor(Math.random() * 3)]; e.strafeT = rand(1, 2.5); }
    mx += -dz / d * e.strafe * 0.7; mz += dx / d * e.strafe * 0.7;
    if (e.wind > 0) { e.wind -= dt; mx *= 0.15; mz *= 0.15; if (e.wind <= 0) { enemyThrow(e, tgt); e.cool = rand(...T.cool); } }
    else { e.cool -= dt; if (e.cool <= 0 && d < T.maxRange) e.wind = T.wind; }
  } else if (!e.far) {
    e.wind = 0; e.wanderT -= dt;
    if (e.wanderT <= 0) { e.wanderT = rand(2, 5); const a = rand(0, TAU), r = rand(0, 10); e.tx = e.home.x + Math.cos(a) * r; e.tz = e.home.z + Math.sin(a) * r; }
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
  if (igloos.size) W.iglooPushFull(e, T.r, igList());
  if (e.faceT !== undefined) e.face = angLerp(e.face, e.faceT, Math.min(1, dt * 6));
}
// 배치기: 반경 안의 플레이어에게 피해 (안전지대·이글루 안은 안전)
function meleeStrike(e) {
  const T = e.T, ig = igList();
  broadcast({ t: 'slam', e: e.id, x: r1(e.x), z: r1(e.z), r: T.reach });
  for (const p of players.values()) {
    if (p.dead || inVillage(p.x, p.z) || Math.hypot(p.x - e.x, p.z - e.z) > T.reach + 0.6) continue;
    if (ig.length && W.iglooAt(ig, p.x, p.z)) continue;
    p.conn.send({ t: 'dmg', id: 'm' + (nextEBall++), a: T.dmg, by: 0, src: e.type });
  }
}
function enemyThrow(e, target) {
  const T = e.T;
  const d = Math.hypot(target.x - e.x, target.z - e.z), tFlight = d / T.spd;
  const tx = target.x + target.vx * tFlight * 0.6, tz = target.z + target.vz * tFlight * 0.6;
  const base = Math.atan2(tx - e.x, tz - e.z);
  const angs = [];
  if (T.spread) for (let i = 0; i < T.spread; i++) angs.push({ a: base + (i - (T.spread - 1) / 2) * 0.2, spd: T.spd });
  else angs.push({ a: base + rand(-T.err, T.err), spd: T.spd });
  e.shots++; e.face = base;
  const r = e.type === 'badsanta' ? 0.36 : 0.3, h = W.BALL_H;
  for (const s of angs) {
    const dx = Math.sin(s.a), dz = Math.cos(s.a);
    const b = { id: 'e' + (nextEBall++), owner: 'e', x: e.x + dx * (T.r + 0.3), z: e.z + dz * (T.r + 0.3), h, dx, dz, spd: s.spd, r, dmg: T.dmg, dist: 0, max: 34, fall: 0 };
    balls.set(b.id, b);
    broadcast({ t: 'b', id: b.id, o: 'e', x: r1(b.x), z: r1(b.z), h: r1(h), dx: r2(dx), dz: r2(dz), s: r1(b.spd), r: r2(r), dm: T.dmg, k: T.ball || 0 });
  }
}
function endBall(b, silent) {
  balls.delete(b.id);
  if (b.owner !== 'e' && !b.hit) { b.endedAt = Date.now(); recentBalls.set(b.id, b); }
  if (!b.hit && b.owner !== 'e') { const p = players.get(b.owner); if (p) p.combo = 0; }
  if (!silent || b.owner === 'e') broadcast({ t: 'be', id: b.id, x: r1(b.x), y: r1(heightAt(b.x, b.z) + b.h), z: r1(b.z) });
}
// 플레이어 눈덩이가 몬스터에 맞음: 관통(여러 마리), 폭발(주변 피해), 얼음(느려짐) 처리
function hitEnemy(b, e) {
  if (!b.hitE) b.hitE = new Set();
  if (b.hitE.has(e.id)) return;
  b.hitE.add(e.id);
  const goOn = b.hitE.size <= b.pierce;
  if (!goOn) { b.hit = true; balls.delete(b.id); recentBalls.delete(b.id); }
  if (b.ice) e.slow = Math.max(e.slow || 0, b.ice);
  applyHit(e, b, goOn);
  if (b.boom) {
    const ex = e.x, ez = e.z, sd = Math.ceil(b.dmg * 0.6);
    broadcast({ t: 'boom', x: r1(ex), z: r1(ez), r: r1(b.boom), by: b.owner });
    for (const o of [...enemies.values()]) {
      if (o === e || Math.hypot(o.x - ex, o.z - ez) > b.boom + o.T.r) continue;
      if (b.ice) o.slow = Math.max(o.slow || 0, b.ice);
      applyHit(o, { ...b, id: b.id + 's', dmg: sd, x: o.x, z: o.z }, true);
    }
  }
}
function applyHit(e, b, goOn) {
  const p = players.get(b.owner);
  e.hp -= b.dmg; e.flash = 0.15; e.aggro = true;
  e.kx = b.dx * 10 / e.T.scale; e.kz = b.dz * 10 / e.T.scale;
  for (const o of enemies.values()) if (o !== e && Math.hypot(o.x - e.x, o.z - e.z) < 10) o.aggro = true;   // 근처 동료도 화가 난다
  let pts = 0;
  if (p) {
    p.combo++; p.best = Math.max(p.best, p.combo);
    const mult = Math.min(4, 1 + Math.floor(p.combo / 3) * 0.5);
    pts = e.hp <= 0 ? (e.T.boss ? e.T.pts : Math.round(e.T.pts * mult)) : 10;
    p.score += pts; if (e.hp <= 0) p.kills++;
  }
  broadcast({ t: 'hit', id: b.id, e: e.id, by: b.owner, x: r1(b.x), y: r1(heightAt(b.x, b.z) + b.h), z: r1(b.z), k: e.hp <= 0 ? 1 : 0, pts, cb: p ? p.combo : 0, go: goOn ? 1 : 0 });
  if (e.hp <= 0 && enemies.has(e.id)) {
    enemies.delete(e.id);
    if (e.spawn) { e.spawn.eid = 0; e.spawn.timer = W.MOB_RESPAWN; }
    const nDrop = e.T.drops || (Math.random() < (e.T.drop || 0) ? 1 : 0);    // 산타 2개, 보스 4개, 나머지는 확률로 1개
    if (e.T.boss) { bossTimer = W.BOSS_RESPAWN; broadcast({ t: 'boss', on: 0, by: p ? p.id : 0, type: e.type }); log(`보스 처치 by ${p ? p.n : '?'}`); }
    for (let i = 0; i < nDrop; i++) {
      const a = rand(0, TAU), rr = e.T.boss ? 2.6 : 1.6, o = { x: e.x + Math.cos(a) * rr, z: e.z + Math.sin(a) * rr }; pushOut(o, 0.8);
      const d = { id: nextDrop++, x: o.x, z: o.z, k: W.GIFT_KINDS[Math.floor(Math.random() * W.GIFT_KINDS.length)], ttl: W.DROP_TTL };
      drops.set(d.id, d); broadcast({ t: 'drop', id: d.id, x: r1(d.x), z: r1(d.z), k: d.k, by: p ? p.id : 0, src: e.type, n: i });
    }
  }
}
// 보스: 맵의 랜덤한 곳에 한 마리. 쓰러지면 90초 뒤 다른 곳에 다시
let bossTimer = W.BOSS_FIRST;
function spawnBoss() {
  let s = null;
  for (let k = 0; k < 50 && !s; k++) { const c = openSpot(40); if (Math.hypot(c.x, c.z) > W.VILLAGE_SAFE * 2.5 && !W.onIce(c.x, c.z)) s = c; }
  if (!s) { bossTimer = 10; return; }
  const e = addEnemy('seal', s.x, s.z, null); e.boss = true;
  broadcast({ t: 'boss', on: 1, x: r1(s.x), z: r1(s.z), type: 'seal' });
  log(`보스 등장 (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`);
}
function step(dt) {
  const active = players.size > 0;
  if (active && ![...enemies.values()].some(e => e.T.boss)) { bossTimer -= dt; if (bossTimer <= 0) spawnBoss(); }
  for (const p of players.values()) p.tokens = Math.min(20, p.tokens + dt * 24);
  if (active) {
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
    const st = b.spd * dt, x0 = b.x, z0 = b.z;
    b.x += b.dx * st; b.z += b.dz * st; b.dist += st;
    if (igloos.size && W.iglooBlocks(igList(), x0, z0, b.x, b.z)) { endBall(b, b.owner !== 'e'); continue; }
    if (b.dist > b.max) { b.fall += 22 * dt; b.h -= b.fall * dt; }
    else if (b.h < 2) b.h += (W.BALL_H - b.h) * Math.min(1, dt * 3);
    const y = heightAt(b.x, b.z) + b.h;
    if (b.h <= 0.1 || Math.abs(b.x) > W.HALF || Math.abs(b.z) > W.HALF || hitsCollider(b.x, y, b.z, b.r)) { endBall(b, b.owner !== 'e'); continue; }
    if (b.owner !== 'e') {
      for (const e of enemies.values()) {
        if (b.hitE && b.hitE.has(e.id)) continue;
        if (Math.hypot(b.x - e.x, b.z - e.z) < e.T.r + b.r && y > heightAt(e.x, e.z) - 0.3 && y < heightAt(e.x, e.z) + e.T.h) {
          hitEnemy(b, e); if (b.hit) break;
        }
      }
    }
  }
  // 얼음낚시: 가만히 앉아 있으면 5초마다 랜덤 물고기
  for (const p of players.values()) {
    const f = p.fishing; if (!f) continue;
    if (p.dead || !W.onIce(p.x, p.z) || Math.hypot(p.x - f.x, p.z - f.z) > 1.2) { p.fishing = null; p.conn.send({ t: 'fishx' }); continue; }
    f.t -= dt; if (f.t > 0) continue;
    f.t = W.FISH_EVERY;
    let roll = Math.random() * 100, fish = W.FISH[0];
    for (const c of W.FISH) { if (roll < c.p) { fish = c; break; } roll -= c.p; }
    p.score += fish.pts;
    p.conn.send({ t: 'catch', k: fish.k, pts: fish.pts });
    if (fish.k === 'gold') broadcast({ t: 'goldfish', id: p.id }, p);
  }
  // 드랍 아이템 수명, 오래된 눈덩이 기록 정리
  for (const d of [...drops.values()]) { d.ttl -= dt; if (d.ttl <= 0) { drops.delete(d.id); broadcast({ t: 'dropx', id: d.id }); } }
  { const now = Date.now(); for (const [id, b] of recentBalls) if (now - b.endedAt > 700) recentBalls.delete(id); }
  // 선물·힐팩·필드 몬스터 리젠
  gifts.forEach((g, i) => { if (!g.on) { g.respawn -= dt; if (g.respawn <= 0) placeGift(i); } });
  heals.forEach((h, i) => { if (!h.on) { h.respawn -= dt; if (h.respawn <= 0) { h.on = true; broadcast({ t: 'hon', i }); } } });
  for (const sp of spawns) {
    if (sp.eid) continue;
    sp.timer -= dt;
    if (sp.timer > 0) continue;
    let close = false; for (const p of players.values()) if (!p.dead && Math.hypot(p.x - sp.x, p.z - sp.z) < 14) close = true;
    if (close) sp.timer = 2;                     // 바로 옆에 사람이 있으면 잠깐 미룬다
    else addEnemy(sp.type, sp.x, sp.z, sp);
  }
}
let tick = 0;
function snapshot() {
  const ps = [...players.values()].map(p => [p.id, r1(p.x), r1(p.z), r1(p.y), r2(p.face), r1(p.vx), r1(p.vz), p.flags, p.hp, p.dead ? 1 : 0, p.score, (p.vl ? 1 : 0) | (p.vt ? 2 : 0)]);
  const gs = gifts.map(g => [r1(g.x), r1(g.z), g.on ? 1 : 0, g.ti]);
  const hs = heals.map(h => (h.on ? 1 : 0));
  const es = [...enemies.values()], bossRows = es.filter(e => e.T.boss).map(e => [e.id, r1(e.x), r1(e.z), e.hp, e.max]);
  for (const p of players.values()) {
    if (!p.ready || p.conn.congested) continue;
    const near = es.filter(e => Math.abs(e.x - p.x) < 110 && Math.abs(e.z - p.z) < 110)
      .map(e => [e.id, e.T.id, r1(e.x), r1(e.z), r2(e.face), e.hp, e.max, e.wind > 0 ? 1 : 0, e.flash > 0 ? 1 : 0, e.moving, e.slow > 0 ? 1 : 0]);
    p.conn.send({ t: 's', p: ps, e: near, g: tick % 10 === 0 ? gs : undefined, h: tick % 10 === 0 ? hs : undefined, cb: p.combo, bs: tick % 10 === 0 ? bossRows : undefined });
  }
}
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt); tick++;
  if (tick % SNAP_EVERY === 0) snapshot();
}, 1000 / TICK);
// 응답 없는 연결 정리: 게임 화면이 8초 동안 아무것도 안 보내면(앱 전환, 화면 꺼짐, 네트워크 끊김) 바로 제거
const IDLE_KICK = +process.env.IDLE_KICK || 8000;
let pingT = 0;
setInterval(() => {
  const now = Date.now(); pingT++;
  for (const p of [...players.values()]) {
    if (now - p.conn.lastApp > IDLE_KICK) { log(`응답 없음으로 제거 ${p.n}#${p.id}`); p.conn.close(); }
    else if (pingT % 5 === 0) p.conn.frame(9, Buffer.alloc(0));
  }
}, 1000);

server.listen(PORT, () => log(`${SERVER_NAME} 시작: http://localhost:${PORT} · 보이스 중계(TURN): ${TURN_KEY_ID && TURN_KEY_API_TOKEN ? '설정됨' : '없음 (직접 연결만)'}`));
