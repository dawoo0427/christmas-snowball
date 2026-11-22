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

  const LIMIT = 112;
  const VILLAGE_SAFE = 28;
  const CAMPS = [
    { x: 55,  z: -40, name: '얼음 언덕 캠프',    snow: 2, peng: 0 },
    { x: -62, z: -42, name: '소나무 숲 캠프',    snow: 3, peng: 1 },
    { x: -66, z: 52,  name: '꽁꽁 호수 캠프',    snow: 3, peng: 2 },
    { x: 62,  z: 58,  name: '눈보라 골짜기 캠프', snow: 4, peng: 3 },
    { x: 0,   z: -92, name: '눈사람 왕의 요새',  snow: 3, peng: 2, boss: true },
  ];
  const LAKE = { x: -24, z: 70, r: 15 };

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
    if (e > 108) { const k = e - 108; h += k * k * 0.06 + k * 0.35; }
    return h;
  }
  const PATHS = CAMPS.map(c => [0, 0, c.x, c.z]);
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
    addCollider({ t: 'c', x: 0, z: 0, r: 4.8, h: 16 });
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
      for (let d = 34; d < L - 16; d += 20) data.lamps.push({ x: nx * d - nz * 3.4, z: nz * d + nx * 3.4, light: false });
    }
    for (const l of data.lamps) addCollider({ t: 'c', x: l.x, z: l.z, r: 0.3, h: 5 });
    addCollider({ t: 'c', x: 8, z: 9, r: 1, h: 3 });
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
    for (let i = 0; i < 2600 && spots.length < 460; i++) {
      const x = R.range(-140, 140), z = R.range(-140, 140);
      if (ok(x, z, 3.6)) spots.push({ x, z, s: R.range(0.75, 1.55), r: R.range(0, TAU), heavy: R() < 0.3 });
    }
    for (const s of spots) { addCollider({ t: 'c', x: s.x, z: s.z, r: 0.55 * s.s + 0.3, h: 5.2 * s.s }); data.trees.push(s); }
    for (let i = 0; i < 400 && data.rocks.length < 70; i++) {
      const x = R.range(-120, 120), z = R.range(-120, 120);
      if (ok(x, z, 5)) { const r = { x, z, s: R.range(0.6, 1.6) }; data.rocks.push(r); addCollider({ t: 'c', x, z, r: r.s * 1.05, h: r.s * 1.3 }); }
    }
    return data;
  }
  const layout = build();

  const World = {
    TAU, clamp, smooth, angDiff, rng, LIMIT, VILLAGE_SAFE, CAMPS, LAKE, FLATS, PATHS,
    heightAt, pathDist, onIce, inVillage, pushOut, hitsCollider, colliders, layout,
    BALL_H: 1.35, PLAYER_RANGE: 34,
    TYPES: {
      snowman: { id: 0, hp: 3, r: 0.9, h: 2.9, speed: 4.2, cool: [1.9, 3.0], wind: 0.65, range: 13, maxRange: 24, spd: 17, err: 0.12, pts: 100, scale: 1 },
      penguin: { id: 1, hp: 2, r: 0.7, h: 2.0, speed: 8.5, cool: [1.3, 2.1], wind: 0.5, range: 10, maxRange: 20, spd: 20, err: 0.1, pts: 150, scale: 1 },
      boss:    { id: 2, hp: 40, r: 1.9, h: 6.3, speed: 3.0, cool: [1.6, 2.4], wind: 0.9, range: 15, maxRange: 30, spd: 15, err: 0.05, pts: 2000, scale: 2.2 },
    },
    TYPE_BY_ID: ['snowman', 'penguin', 'boss'],
    GIFT_KINDS: ['heal', 'triple', 'giant', 'fast'],
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = World;
  else root.World = World;
})(typeof self !== 'undefined' ? self : this);
