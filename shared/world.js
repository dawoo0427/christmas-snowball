// 크리스마스 눈싸움 - 서버와 브라우저가 함께 쓰는 월드 정의
// 지형 높이, 나무/집/캠프 배치, 충돌 판정이 양쪽에서 똑같이 계산되도록 한 파일에 모았다.
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = t => t * t * (3 - 2 * t);
  const angDiff = (a, b) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;

  function rng(seed) {
    let s = seed | 0;
    const f = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.range = (a, b) => a + f() * (b - a);
    return f;
  }

  // 맵 크기: 플레이 가능 범위 ±224 (예전의 2배). 가장자리 바깥은 산으로 막힌다.
  const LIMIT = 224, EDGE = 216, HALF = 290;
  const VILLAGE_SAFE = 28;            // 마을 안전지대 반지름. 이 밖에서는 플레이어끼리 PvP 가능
  const BONFIRE = { x: 0, z: 0, r: 3.2, healR: 11 };      // 마을 중앙의 대형 모닥불
  const VILLAGE_TREES = [{ x: -12.5, z: 7.2, s: 0.45 }, { x: 12.5, z: -7.2, s: 0.45 }];   // 모닥불 양옆의 작은 크리스마스트리
  // 모닥불을 둘러싼 통나무 의자 6개, 의자마다 2자리. 앉으면 모닥불을 바라본다
  const BENCH_R = 7.2, BENCH_TOP = 0.76;
  const BENCHES = Array.from({ length: 6 }, (_, i) => {
    const a = i / 6 * TAU + 0.25, x = BONFIRE.x + Math.cos(a) * BENCH_R, z = BONFIRE.z + Math.sin(a) * BENCH_R;
    const tx = -Math.sin(a), tz = Math.cos(a);              // 의자 길이 방향
    return { a, x, z, seats: [-0.65, 0.65].map(o => ({ x: x + tx * o, z: z + tz * o, face: Math.atan2(BONFIRE.x - (x + tx * o), BONFIRE.z - (z + tz * o)) })) };
  });
  const SEATS = BENCHES.flatMap(b => b.seats);
  const CAMPS = [
    // 바깥 고리: 마을에서 길이 이어진 큰 캠프
    { x: 110,  z: -80,  name: '얼음 언덕 캠프',    snow: 2, peng: 1 },
    { x: -124, z: -84,  name: '소나무 숲 캠프',    snow: 3, peng: 1 },
    { x: -132, z: 104,  name: '꽁꽁 호수 캠프',    snow: 3, peng: 2 },
    { x: 124,  z: 116,  name: '눈보라 골짜기 캠프', snow: 4, peng: 3 },
    { x: 0,    z: -184, name: '눈사람 왕의 요새',  snow: 3, peng: 2, boss: true },
    // 안쪽 고리: 길 사이 눈밭의 작은 캠프
    { x: 75,   z: 0,    name: '진저브레드 캠프',   snow: 2, peng: 1, mid: true },
    { x: 0,    z: 75,   name: '사탕지팡이 캠프',   snow: 2, peng: 1, mid: true },
    { x: -75,  z: 0,    name: '쿠키 언덕 캠프',    snow: 2, peng: 1, mid: true },
    { x: -38,  z: -65,  name: '고드름 숲 캠프',    snow: 2, peng: 1, mid: true },
  ];
  const LAKE = { x: -48, z: 150, r: 22 };

  function baseH(x, z) {
    return 2.2 * Math.sin(x * 0.045) * Math.cos(z * 0.04) + 0.9 * Math.sin(x * 0.12 + z * 0.08)
         + 1.1 * Math.cos(z * 0.1 - x * 0.035) + 0.45 * Math.sin(x * 0.3) * Math.sin(z * 0.27);
  }
  const FLATS = [
    { x: 0, z: 0, inner: 32, outer: 44 },
    ...CAMPS.map(c => ({ x: c.x, z: c.z, inner: c.boss ? 19 : 14, outer: c.boss ? 30 : 23 })),
    { x: LAKE.x, z: LAKE.z, inner: LAKE.r + 1, outer: LAKE.r + 10, lower: -1.4 },
  ];
  FLATS.forEach(f => { f.h = baseH(f.x, f.z) + (f.lower || 0); });
  function heightAt(x, z) {
    let h = baseH(x, z);
    for (const f of FLATS) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < f.outer) { const t = smooth(clamp((d - f.inner) / (f.outer - f.inner), 0, 1)); h = f.h + (h - f.h) * t; }
    }
    const e = Math.max(Math.abs(x), Math.abs(z));
    if (e > EDGE) { const k = e - EDGE; h += k * k * 0.06 + k * 0.35; }
    return h;
  }
  const PATHS = CAMPS.filter(c => !c.mid).map(c => [0, 0, c.x, c.z]);
  function pathDist(x, z) {
    let best = 1e9;
    for (const [ax, az, bx, bz] of PATHS) {
      const dx = bx - ax, dz = bz - az, t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  }
  const onIce = (x, z) => Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r;
  const inVillage = (x, z) => Math.hypot(x, z) < VILLAGE_SAFE;

  // ---- 충돌체 (공간 격자). 박스 rot = 메쉬 rotation.y ----
  const CELL = 10, grid = new Map(), colliders = [];
  function addCollider(c) {
    c.base = heightAt(c.x, c.z) - 0.5;
    colliders.push(c);
    const r = c.t === 'c' ? c.r : Math.hypot(c.hw, c.hd);
    for (let ix = Math.floor((c.x - r - 2) / CELL); ix <= Math.floor((c.x + r + 2) / CELL); ix++)
      for (let iz = Math.floor((c.z - r - 2) / CELL); iz <= Math.floor((c.z + r + 2) / CELL); iz++) {
        const k = ix + ',' + iz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c);
      }
  }
  const nearby = (x, z) => grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) || [];
  function pushOut(o, r) {
    for (const c of nearby(o.x, o.z)) {
      if (c.t === 'c') {
        const dx = o.x - c.x, dz = o.z - c.z, d = Math.hypot(dx, dz), m = r + c.r;
        if (d < m && d > 1e-5) { o.x = c.x + dx / d * m; o.z = c.z + dz / d * m; }
      } else {
        const cs = Math.cos(c.rot), sn = Math.sin(c.rot), dx = o.x - c.x, dz = o.z - c.z;
        let lx = cs * dx - sn * dz, lz = sn * dx + cs * dz;
        const qx = clamp(lx, -c.hw, c.hw), qz = clamp(lz, -c.hd, c.hd);
        const ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez);
        if (d < r) {
          if (d > 1e-5) { lx = qx + ex / d * r; lz = qz + ez / d * r; }
          else { const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz); if (px < pz) lx = Math.sign(lx || 1) * (c.hw + r); else lz = Math.sign(lz || 1) * (c.hd + r); }
          o.x = c.x + cs * lx + sn * lz; o.z = c.z - sn * lx + cs * lz;
        }
      }
    }
  }
  function hitsCollider(x, y, z, r) {
    for (const c of nearby(x, z)) {
      if (y > c.base + c.h + r) continue;
      if (c.t === 'c') { if (Math.hypot(x - c.x, z - c.z) < c.r + r) return true; }
      else {
        const cs = Math.cos(c.rot), sn = Math.sin(c.rot), dx = x - c.x, dz = z - c.z;
        if (Math.abs(cs * dx - sn * dz) < c.hw + r && Math.abs(sn * dx + cs * dz) < c.hd + r) return true;
      }
    }
    return false;
  }

  // ---- 배치 생성 (결정적) ----
  function build() {
    const R = rng(20261225);
    const data = { trees: [], rocks: [], houses: [], lamps: [], camps: [], friendly: { x: 8, z: 9 } };
    // 마을
    for (const t of VILLAGE_TREES) addCollider({ t: 'c', x: t.x, z: t.z, r: 4.8 * t.s + 0.3, h: 16 * t.s });
    const wallCols = [0x9b5a3c, 0x6d7fa6, 0x7c9a6a, 0xb07a4a, 0x8d5b8f];
    const pathAngles = PATHS.map(([, , bx, bz]) => Math.atan2(bz, bx));
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * TAU + 0.2, Rr = 24;
      if (pathAngles.some(pa => Math.abs(angDiff(pa, a)) < 0.3)) continue;
      const x = Math.cos(a) * Rr, z = Math.sin(a) * Rr, rot = Math.atan2(-x, -z);
      data.houses.push({ x, z, rot, col: wallCols[i % wallCols.length] });
      addCollider({ t: 'b', x, z, hw: 3.6, hd: 3.2, rot, h: 8 });
    }
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; data.lamps.push({ x: Math.cos(a) * 12, z: Math.sin(a) * 12, light: i % 2 === 0 }); }
    for (const [, , bx, bz] of PATHS) {
      const L = Math.hypot(bx, bz), nx = bx / L, nz = bz / L;
      for (let d = 34; d < L - 16; d += 24) data.lamps.push({ x: nx * d - nz * 3.4, z: nz * d + nx * 3.4, light: false });
    }
    for (const l of data.lamps) addCollider({ t: 'c', x: l.x, z: l.z, r: 0.3, h: 5 });
    addCollider({ t: 'c', x: 8, z: 9, r: 1, h: 3 });
    addCollider({ t: 'c', x: BONFIRE.x, z: BONFIRE.z, r: BONFIRE.r, h: 1.6 });
    // 캠프
    CAMPS.forEach((def, idx) => {
      const Rc = def.boss ? 15 : 10, n = def.boss ? 9 : 6, len = def.boss ? 6.5 : 5;
      const camp = { idx, def, R: Rc, walls: [], igloo: null, towers: [] };
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU + R.range(-0.12, 0.12) + idx * 0.4;
        const x = def.x + Math.cos(a) * Rc, z = def.z + Math.sin(a) * Rc, rot = Math.atan2(-Math.cos(a), -Math.sin(a));
        camp.walls.push({ x, z, rot, len });
        addCollider({ t: 'b', x, z, hw: len / 2, hd: 0.6, rot, h: 2.3 });
      }
      const ia = idx * 1.3 + 0.8, ix = def.x + Math.cos(ia) * (Rc - 4.5), iz = def.z + Math.sin(ia) * (Rc - 4.5);
      camp.igloo = { x: ix, z: iz, rot: Math.atan2(def.x - ix, def.z - iz) };
      addCollider({ t: 'c', x: ix, z: iz, r: 2.5, h: 2.6 });
      if (def.boss) for (let i = 0; i < 4; i++) {
        const a = i / 4 * TAU + Math.PI / 4, tx = def.x + Math.cos(a) * (Rc + 2), tz = def.z + Math.sin(a) * (Rc + 2);
        camp.towers.push({ x: tx, z: tz });
        addCollider({ t: 'c', x: tx, z: tz, r: 1.6, h: 9 });
      }
      addCollider({ t: 'c', x: def.x, z: def.z, r: 0.6, h: 5 });
      data.camps.push(camp);
    });
    // 숲과 바위
    const spots = [];
    const ok = (x, z, minD) => {
      for (const f of FLATS) if (Math.hypot(x - f.x, z - f.z) < f.outer - 3) return false;
      if (pathDist(x, z) < 5) return false;
      for (const s of spots) if (Math.abs(s.x - x) < minD && Math.abs(s.z - z) < minD && Math.hypot(s.x - x, s.z - z) < minD) return false;
      return true;
    };
    for (let i = 0; i < 9000 && spots.length < 1500; i++) {
      const x = R.range(-HALF + 10, HALF - 10), z = R.range(-HALF + 10, HALF - 10);
      if (ok(x, z, 3.6)) spots.push({ x, z, s: R.range(0.75, 1.55), r: R.range(0, TAU), heavy: R() < 0.3 });
    }
    for (const s of spots) { addCollider({ t: 'c', x: s.x, z: s.z, r: 0.55 * s.s + 0.3, h: 5.2 * s.s }); data.trees.push(s); }
    for (let i = 0; i < 1500 && data.rocks.length < 220; i++) {
      const x = R.range(-LIMIT, LIMIT), z = R.range(-LIMIT, LIMIT);
      if (ok(x, z, 5)) { const r = { x, z, s: R.range(0.6, 1.6) }; data.rocks.push(r); addCollider({ t: 'c', x, z, r: r.s * 1.05, h: r.s * 1.3 }); }
    }
    // 힐팩: 길 중간과 캠프 바깥, 숲 속 빈터에 고정 배치
    data.heals = [];
    const freeSpot = (x, z) => { const o = { x, z }; pushOut(o, 1.6); return o; };
    for (const [, , bx, bz] of PATHS) {
      const Lp = Math.hypot(bx, bz), nx = bx / Lp, nz = bz / Lp;
      data.heals.push(freeSpot(nx * Lp * 0.55 + nz * 2.5, nz * Lp * 0.55 - nx * 2.5));
    }
    for (const c of CAMPS) {
      const d = Math.hypot(c.x, c.z), nx = c.x / d, nz = c.z / d, Rr = c.boss ? 24 : 19;
      data.heals.push(freeSpot(c.x - nx * Rr - nz * 6, c.z - nz * Rr + nx * 6));
    }
    for (let i = 0; i < 2000 && data.heals.length < 32; i++) {
      const x = R.range(-200, 200), z = R.range(-200, 200);
      if (Math.hypot(x, z) < 40 || data.heals.some(h => Math.hypot(h.x - x, h.z - z) < 30)) continue;
      if (CAMPS.some(c => Math.hypot(x - c.x, z - c.z) < 20)) continue;
      const o = freeSpot(x, z); if (Math.hypot(o.x - x, o.z - z) < 0.01) data.heals.push(o);
    }
    return data;
  }
  const layout = build();

  const World = {
    TAU, clamp, smooth, angDiff, rng, LIMIT, VILLAGE_SAFE, CAMPS, LAKE, FLATS, PATHS,
    heightAt, pathDist, onIce, inVillage, pushOut, hitsCollider, colliders, layout,
    BALL_H: 1.35, PLAYER_RANGE: 34, MAX_HP: 100, HEAL_AMOUNT: 35, RELOAD_TIME: 2.0,
    TYPES: {
      snowman: { id: 0, hp: 3, r: 0.9, h: 2.9, speed: 4.2, cool: [1.9, 3.0], wind: 0.65, range: 13, maxRange: 24, spd: 17, err: 0.12, pts: 100, scale: 1, dmg: 15 },
      penguin: { id: 1, hp: 2, r: 0.7, h: 2.0, speed: 8.5, cool: [1.3, 2.1], wind: 0.5, range: 10, maxRange: 20, spd: 20, err: 0.1, pts: 150, scale: 1, dmg: 12 },
      boss:    { id: 2, hp: 40, r: 1.9, h: 6.3, speed: 3.0, cool: [1.6, 2.4], wind: 0.9, range: 15, maxRange: 30, spd: 15, err: 0.05, pts: 2000, scale: 2.2, dmg: 20 },
    },
    TYPE_BY_ID: ['snowman', 'penguin', 'boss'],
    // 선물 버프: 체력, 트리플, 왕눈덩이, 스피드, 공격력 2배, 연사 2배, 보호막, 무한 눈덩이
    GIFT_KINDS: ['heal', 'triple', 'giant', 'fast', 'power', 'rapid', 'shield', 'infinite'],
    BUFF_TIME: 15, PVP_DMG: 12, KO_POINTS: 200, EDGE, HALF, BONFIRE, VILLAGE_TREES, BENCHES, SEATS, BENCH_TOP, FIRE_HEAL: 12, TEA_TIME: 4.5, SIT_RANGE: 11,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = World;
  else root.World = World;
})(typeof self !== 'undefined' ? self : this);
