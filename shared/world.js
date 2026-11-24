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

  // 맵 크기: 플레이 가능 범위 ±448 (예전의 2배). 가장자리 바깥은 산으로 막힌다.
  const LIMIT = 448, EDGE = 432, HALF = 580;
  const VILLAGE_SAFE = 56;            // 마을 안전지대 반지름 (예전의 2배). 이 밖에서는 플레이어끼리 PvP 가능
  const ZONES = [220, 340];           // 마을에서 이 거리 밖부터 나쁜 루돌프, 나쁜 산타가 나온다
  // 안전지대의 초대형 크리스마스트리: 플레이어가 오너먼트로 꾸민다 (하나에 1,000점)
  // 탑뷰 카메라(높이 약 24, 49도로 내려다봄)에서 꼭대기 전광판까지 잘리지 않고 보이도록 높이 약 12 + 전광판
  const GIANT_TREE = { x: 0, z: 30, r: 5.8, h: 12.2, trunk: 1.8,
    tiers: [0, 1, 2, 3, 4, 5].map(i => ({ b: 1.8 + i * 1.5, r: 6.2 * (1 - i / 6.3), h: 3.1 })), ornCost: 1000, maxOrn: 400, near: 20, view: 22 };
  // 트리 표면 반지름 (높이 y 에서 가장 바깥쪽 가지)
  GIANT_TREE.surfR = y => { let r = 0; for (const t of GIANT_TREE.tiers) if (y >= t.b && y <= t.b + t.h) r = Math.max(r, t.r * (1 - (y - t.b) / t.h)); return r; };
  const ORNAMENTS = [
    { k: 'red', name: '빨간 공', emoji: '🔴' }, { k: 'gold', name: '금빛 공', emoji: '🟡' }, { k: 'blue', name: '파란 공', emoji: '🔵' },
    { k: 'star', name: '별', emoji: '⭐' }, { k: 'cane', name: '지팡이 사탕', emoji: '🍭' }, { k: 'bell', name: '종', emoji: '🔔' },
    { k: 'bow', name: '리본', emoji: '🎀' }, { k: 'light', name: '반짝 전구', emoji: '💡' }, { k: 'snow', name: '눈꽃', emoji: '❄️' }, { k: 'gift', name: '작은 선물', emoji: '🎁' },
  ];
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
  // 마을에서 뻗어 나가는 길 5개의 끝 지점 (캠프는 없어졌고 길과 가로등은 이정표로 남김)
  const ROAD_ENDS = [{ x: 220, z: -160 }, { x: -248, z: -168 }, { x: -264, z: 208 }, { x: 248, z: 232 }, { x: 0, z: -368 }];
  const LAKE = { x: -96, z: 300, r: 32 };

  function baseH(x, z) {
    return 2.2 * Math.sin(x * 0.045) * Math.cos(z * 0.04) + 0.9 * Math.sin(x * 0.12 + z * 0.08)
         + 1.1 * Math.cos(z * 0.1 - x * 0.035) + 0.45 * Math.sin(x * 0.3) * Math.sin(z * 0.27);
  }
  const FLATS = [
    { x: 0, z: 0, inner: 62, outer: 78 },
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
  const PATHS = ROAD_ENDS.map(c => [0, 0, c.x, c.z]);
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
  // 집: 가로 7, 세로 6. 문은 앞쪽(+z) 가운데 폭 2.2
  const HOUSE = { hw: 3.5, hd: 3.0, door: 1.1, wall: 0.18 };
  const HOUSE_WALLS = [
    [0, -HOUSE.hd, HOUSE.hw, HOUSE.wall],                                        // 뒤
    [-HOUSE.hw, 0, HOUSE.wall, HOUSE.hd], [HOUSE.hw, 0, HOUSE.wall, HOUSE.hd],   // 옆
    [-(HOUSE.hw + HOUSE.door) / 2, HOUSE.hd, (HOUSE.hw - HOUSE.door) / 2, HOUSE.wall],  // 앞 왼쪽
    [(HOUSE.hw + HOUSE.door) / 2, HOUSE.hd, (HOUSE.hw - HOUSE.door) / 2, HOUSE.wall],   // 앞 오른쪽
  ];
  // 집 안에 있는지 (몇 번째 집인지, 없으면 -1)
  function houseAt(x, z) {
    const hs = World.layout.houses;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i], cs = Math.cos(h.rot), sn = Math.sin(h.rot), dx = x - h.x, dz = z - h.z;
      if (Math.abs(cs * dx - sn * dz) < HOUSE.hw - 0.1 && Math.abs(sn * dx + cs * dz) < HOUSE.hd - 0.1) return i;
    }
    return -1;
  }
  // ---- 이글루 / 얼음성: 둥근 벽, 문(rot 방향)으로만 드나들 수 있음. 레벨이 오를수록 커진다 ----
  const IGLOO = {
    r: 3.4, wall: 0.35, door: 0.42, score: 5000,
    LV: [
      { name: '이글루', r: 3.4, cost: 5000 },
      { name: '얼음성 Lv1', r: 4.6, cost: 10000 },
      { name: '얼음성 Lv2', r: 5.6, cost: 20000 },
      { name: '얼음성 Lv3', r: 6.8, cost: 50000 },
    ],
  };
  // 레벨에 맞는 반지름과 문 폭(문 너비는 2.7로 같고, 각도로 바꿔 둔다)
  function igDims(ig) { const r = IGLOO.LV[ig.lv | 0].r; ig.r = r; ig.d = Math.asin(1.35 / r); return ig; }
  const iglooDoor = (ig, x, z) => Math.abs(angDiff(Math.atan2(x - ig.x, z - ig.z), ig.rot)) < ig.d;
  // 플레이어: 벽에 막히고, 문으로는 통과
  function iglooPush(o, r, igs) {
    for (const ig of igs) {
      const dx = o.x - ig.x, dz = o.z - ig.z, d = Math.hypot(dx, dz);
      if (d < 1e-4 || Math.abs(d - ig.r) > r + IGLOO.wall || iglooDoor(ig, o.x, o.z)) continue;
      const to = d < ig.r ? ig.r - r - IGLOO.wall : ig.r + r + IGLOO.wall;
      o.x = ig.x + dx / d * to; o.z = ig.z + dz / d * to;
    }
  }
  // 몬스터: 이글루 안으로 못 들어옴
  function iglooPushFull(o, r, igs) {
    for (const ig of igs) {
      const dx = o.x - ig.x, dz = o.z - ig.z, d = Math.hypot(dx, dz), m = ig.r + IGLOO.wall + r;
      if (d < m) { const k = d > 1e-4 ? m / d : 0; o.x = ig.x + (k ? dx * k : m); o.z = ig.z + (k ? dz * k : 0); }
    }
  }
  // 눈덩이: 벽을 뚫고 지나가면 막힘 (문 쪽은 통과)
  function iglooBlocks(igs, x0, z0, x1, z1) {
    for (const ig of igs) {
      const d0 = Math.hypot(x0 - ig.x, z0 - ig.z) - ig.r, d1 = Math.hypot(x1 - ig.x, z1 - ig.z) - ig.r;
      if ((d0 > 0) !== (d1 > 0) && !iglooDoor(ig, x1, z1)) return true;
    }
    return false;
  }
  const iglooAt = (igs, x, z) => igs.find(ig => Math.hypot(x - ig.x, z - ig.z) < ig.r) || null;
  // 이글루를 지을 수 있는 자리인지 (이유 문자열 또는 '')
  function iglooSpot(x, z, igs, ignoreId, R = IGLOO.r) {
    if (Math.hypot(x, z) < VILLAGE_SAFE + R + 2) return '마을 안에는 지을 수 없어요';
    if (Math.abs(x) > LIMIT - 6 || Math.abs(z) > LIMIT - 6) return '맵 끝에는 지을 수 없어요';
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + R) return '얼음 호수 위에는 지을 수 없어요';
    for (const ig of igs) if (ig.id !== ignoreId && Math.hypot(x - ig.x, z - ig.z) < ig.r + R + 3) return '다른 이글루와 너무 가까워요';
    const y = heightAt(x, z) + 1;
    if (hitsCollider(x, y, z, 0.5)) return '나무나 바위가 있는 자리예요';
    for (const rr of [R * 0.5, R]) for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, px = x + Math.sin(a) * rr, pz = z + Math.cos(a) * rr; if (hitsCollider(px, heightAt(px, pz) + 1, pz, 0.6)) return '나무나 바위가 너무 가까워요'; }
    return '';
  }

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
    const data = { trees: [], rocks: [], houses: [], lamps: [], spawns: [], friendly: { x: 8, z: 9 } };
    // 마을
    for (const t of VILLAGE_TREES) addCollider({ t: 'c', x: t.x, z: t.z, r: 4.8 * t.s + 0.3, h: 16 * t.s });
    const wallCols = [0x9b5a3c, 0x6d7fa6, 0x7c9a6a, 0xb07a4a, 0x8d5b8f];
    const pathAngles = PATHS.map(([, , bx, bz]) => Math.atan2(bz, bx));
    addCollider({ t: 'c', x: GIANT_TREE.x, z: GIANT_TREE.z, r: GIANT_TREE.r, h: GIANT_TREE.h + 2 });
    const treeAng = Math.atan2(GIANT_TREE.z, GIANT_TREE.x);
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU + 0.2, Rr = 44;
      if (pathAngles.some(pa => Math.abs(angDiff(pa, a)) < 0.22) || Math.abs(angDiff(treeAng, a)) < 0.4) continue;
      const x = Math.cos(a) * Rr, z = Math.sin(a) * Rr, rot = Math.atan2(-x, -z);
      data.houses.push({ x, z, rot, col: wallCols[i % wallCols.length] });
      // 벽 4면 (앞쪽 가운데에 문). 로컬 좌표 → 월드 좌표: 메쉬 rotation.y = rot 과 같은 규칙
      const cs = Math.cos(rot), sn = Math.sin(rot);
      for (const [lx, lz, hw, hd] of HOUSE_WALLS) addCollider({ t: 'b', x: x + cs * lx + sn * lz, z: z - sn * lx + cs * lz, hw, hd, rot, h: 8 });
    }
    // 가로등은 위에서 보면 빛나는 하얀 상자처럼 보여 아이템과 헷갈려서 없앰 (data.lamps 는 빈 목록)
    addCollider({ t: 'c', x: 8, z: 9, r: 1, h: 3 });
    addCollider({ t: 'c', x: BONFIRE.x, z: BONFIRE.z, r: BONFIRE.r, h: 1.6 });
    // 숲과 바위
    const spots = [];
    const ok = (x, z, minD) => {
      for (const f of FLATS) if (Math.hypot(x - f.x, z - f.z) < f.outer - 3) return false;
      if (pathDist(x, z) < 5) return false;
      for (const s of spots) if (Math.abs(s.x - x) < minD && Math.abs(s.z - z) < minD && Math.hypot(s.x - x, s.z - z) < minD) return false;
      return true;
    };
    for (let i = 0; i < 40000 && spots.length < 4800; i++) {
      const x = R.range(-HALF + 10, HALF - 10), z = R.range(-HALF + 10, HALF - 10);
      if (ok(x, z, 3.6)) spots.push({ x, z, s: R.range(0.75, 1.55), r: R.range(0, TAU), heavy: R() < 0.3 });
    }
    for (const s of spots) { addCollider({ t: 'c', x: s.x, z: s.z, r: 0.55 * s.s + 0.3, h: 5.2 * s.s }); data.trees.push(s); }
    for (let i = 0; i < 6000 && data.rocks.length < 700; i++) {
      const x = R.range(-LIMIT, LIMIT), z = R.range(-LIMIT, LIMIT);
      if (ok(x, z, 5)) { const r = { x, z, s: R.range(0.6, 1.6) }; data.rocks.push(r); addCollider({ t: 'c', x, z, r: r.s * 1.05, h: r.s * 1.3 }); }
    }
    // 힐팩: 길 중간과 숲 속 빈터에 고정 배치
    data.heals = [];
    const freeSpot = (x, z) => { const o = { x, z }; pushOut(o, 1.6); return o; };
    for (const [, , bx, bz] of PATHS) {
      const Lp = Math.hypot(bx, bz), nx = bx / Lp, nz = bz / Lp;
      data.heals.push(freeSpot(nx * Lp * 0.55 + nz * 2.5, nz * Lp * 0.55 - nx * 2.5));
    }
    for (let i = 0; i < 8000 && data.heals.length < 80; i++) {
      const x = R.range(-LIMIT + 24, LIMIT - 24), z = R.range(-LIMIT + 24, LIMIT - 24);
      if (Math.hypot(x, z) < VILLAGE_SAFE + 14 || data.heals.some(h => Math.hypot(h.x - x, h.z - z) < 30)) continue;
      const o = freeSpot(x, z); if (Math.hypot(o.x - x, o.z - z) < 0.01) data.heals.push(o);
    }
    // 필드 몬스터 스폰 지점: 마을에서 멀수록 강한 몬스터. 죽으면 같은 자리에서 다시 생긴다
    const pick = (d) => {
      const t = R();
      if (d < ZONES[0]) return t < 0.6 ? 'snowman' : 'penguin';
      if (d < ZONES[1]) return t < 0.35 ? 'snowman' : t < 0.6 ? 'penguin' : 'rudolph';
      return t < 0.2 ? 'snowman' : t < 0.35 ? 'penguin' : t < 0.68 ? 'rudolph' : 'badsanta';
    };
    for (let i = 0; i < 30000 && data.spawns.length < 225; i++) {      // 필드 몬스터 225마리 (예전의 3배)
      const x = R.range(-LIMIT + 12, LIMIT - 12), z = R.range(-LIMIT + 12, LIMIT - 12), d = Math.hypot(x, z);
      if (d < VILLAGE_SAFE + 20 || onIce(x, z) || data.spawns.some(sp => Math.hypot(sp.x - x, sp.z - z) < 17)) continue;
      const o = freeSpot(x, z); if (Math.hypot(o.x - x, o.z - z) > 0.01) continue;
      data.spawns.push({ id: data.spawns.length, x, z, type: pick(d) });
    }
    return data;
  }
  const layout = build();

  const World = {
    TAU, clamp, smooth, angDiff, rng, LIMIT, VILLAGE_SAFE, ZONES, GIANT_TREE, ORNAMENTS, ROAD_ENDS, LAKE, FLATS, PATHS,
    HOUSE, houseAt, IGLOO, igDims, iglooDoor, iglooPush, iglooPushFull, iglooBlocks, iglooAt, iglooSpot, MAX_ALLIES: 10,
    heightAt, pathDist, onIce, inVillage, pushOut, hitsCollider, colliders, layout,
    BALL_H: 1.35, PLAYER_RANGE: 34, MAX_HP: 100, HEAL_AMOUNT: 35, RELOAD_TIME: 2.0,
    TYPES: {
      snowman: { id: 0, hp: 3, r: 0.9, h: 2.9, speed: 4.2, cool: [1.9, 3.0], wind: 0.65, range: 13, maxRange: 24, spd: 17, err: 0.12, pts: 100, scale: 1, dmg: 15, drop: 0.1 },
      penguin: { id: 1, hp: 2, r: 0.7, h: 2.0, speed: 8.5, cool: [1.3, 2.1], wind: 0.5, range: 10, maxRange: 20, spd: 20, err: 0.1, pts: 150, scale: 1, dmg: 12, drop: 0.1 },
      // 나쁜 루돌프: 빠르게 달려들어 빨간 눈덩이를 빠르게 던진다
      rudolph:  { id: 2, hp: 4, r: 0.95, h: 2.4, speed: 9.5, cool: [1.0, 1.7], wind: 0.4, range: 11, maxRange: 20, spd: 24, err: 0.08, pts: 220, scale: 1, dmg: 14, ball: 2, drop: 0.15 },
      // 나쁜 산타: 덩치 큰 정예. 석탄 눈덩이를 3발씩 부채꼴로 던진다
      badsanta: { id: 3, hp: 10, r: 1.1, h: 3.6, speed: 3.6, cool: [1.7, 2.5], wind: 0.8, range: 14, maxRange: 26, spd: 18, err: 0.05, pts: 1000, scale: 1.25, dmg: 18, ball: 1, spread: 3, drops: 2 },
      // 거대 하프물범 (보스): 맵 랜덤한 곳에 한 마리. 다가와서 배치기로 주변을 내려친다. 처치 시 10,000점 + 선물 4개
      seal: { id: 4, hp: 300, r: 1.8, h: 2.6, speed: 7.2, cool: [1.2, 1.9], wind: 0.75, range: 2.4, maxRange: 4.4, spd: 0, err: 0, pts: 10000, scale: 1.6, dmg: 30,
        melee: true, reach: 4.4, boss: true, drops: 4, name: '거대 하프물범' },
    },
    TYPE_BY_ID: ['snowman', 'penguin', 'rudolph', 'badsanta', 'seal'],
    BOSS_RESPAWN: 90, BOSS_FIRST: 20,
    SLED: { cost: 50000, speed: 3 },      // 눈썰매: 50,000점에 구매, 타면 이동 속도 3배(스피드 아이템과 곱해짐), 타는 동안 공격 불가
    MOB_RESPAWN: 20, GIFT_RESPAWN: 10, HEAL_RESPAWN: 10,
    DROP_TTL: 30, SANTA_DROPS: 2,
    // 캐릭터 꾸미기 선택지 개수 (화면 쪽 이름 목록과 순서를 맞춘다)
    // a 캐릭터, h 머리, e 눈, n 코, m 입, r 귀, k 목, b 등, c 옷 색
    LOOK_SLOTS: { a: 6, h: 9, e: 7, n: 5, m: 6, r: 6, k: 4, b: 4, c: 6 },
    cleanLook(o) {
      const L = World.LOOK_SLOTS, out = {};
      o = o && typeof o === 'object' ? Object.assign({}, o) : {};
      if (o.f && o.e == null && o.n == null && o.m == null) {      // 예전 '얼굴' 한 칸 → 눈·코·입으로 옮김
        if (o.f === 1) o.n = 1; if (o.f === 2) o.m = 1; if (o.f === 3) o.e = 1; if (o.f === 4) o.e = 2;
      }
      for (const key in L) { const v = o[key] | 0; out[key] = v >= 0 && v < L[key] ? v : 0; }
      return out;
    },
    // 선물: 체력, 트리플, 왕눈덩이, 스피드, 공격력, 연사, 보호막 + 공격형(관통, 폭발, 얼음, 저격, 연발)
    GIFT_KINDS: ['heal', 'triple', 'giant', 'fast', 'power', 'rapid', 'shield', 'pierce', 'boom', 'ice', 'snipe', 'double'],
    // 보호막 말고는 시간 제한 없이 쓰러질 때까지 유지, 먹을수록 중첩 (최대 단계)
    STACK_MAX: { triple: 3, giant: 4, fast: 3, power: 4, rapid: 3, pierce: 4, boom: 4, ice: 4, snipe: 3, double: 2 },
    STACK_KEYS: ['triple', 'giant', 'power', 'snipe', 'pierce', 'boom', 'ice', 'double'],   // 눈덩이에 실리는 효과
    cleanStacks(o) {
      const out = {}; o = o && typeof o === 'object' ? o : {};
      for (const k of World.STACK_KEYS) out[k] = Math.max(0, Math.min(World.STACK_MAX[k], o[k] | 0));
      return out;
    },
    // 한 번 던질 때 나가는 눈덩이들: 트리플 단계마다 양옆으로 한 발씩, 연발 단계마다 조금 느린 한 줄 더
    volley(s) {
      const out = []; let k = 0;
      for (let j = 0; j <= s.double; j++) for (let i = -s.triple; i <= s.triple; i++) out.push({ k: k++, a: i * 0.13, sm: 1 - j * 0.17 });
      return out;
    },
    // 눈덩이 능력치 (서버와 화면이 같은 계산을 쓴다)
    ballStats(s, ch) {
      const big = (ch ? 1 : 0) + s.giant;
      return {
        r: 0.28 + Math.min(big, 3) * 0.14, dmg: (1 + big) * (1 + s.power),
        spd: (ch ? 40 : 32) * (1 + 0.2 * s.snipe), max: World.PLAYER_RANGE * (1 + 0.4 * s.snipe),
        pierce: s.pierce, boom: s.boom ? 2.5 + s.boom : 0, ice: s.ice ? 1.5 + s.ice : 0,
      };
    },
    // 얼음낚시: 5초마다 한 마리 (확률 %, 점수)
    FISH_EVERY: 5,
    FISH: [
      { k: 'smelt', name: '빙어', emoji: '🐟', p: 40, pts: 20 },
      { k: 'trout', name: '송어', emoji: '🐠', p: 27, pts: 50 },
      { k: 'salmon', name: '연어', emoji: '🐟', p: 15, pts: 100 },
      { k: 'puffer', name: '복어', emoji: '🐡', p: 8, pts: 150 },
      { k: 'boot', name: '낡은 장화', emoji: '👢', p: 7, pts: 5 },
      { k: 'gold', name: '황금 물고기', emoji: '✨', p: 3, pts: 500 },
    ],
    pvpDmg(dmg) { return Math.min(40, Math.round(dmg * World.PVP_DMG)); },
    BUFF_TIME: 15, PVP_DMG: 12, KO_POINTS: 200, EDGE, HALF, BONFIRE, VILLAGE_TREES, BENCHES, SEATS, BENCH_TOP, FIRE_HEAL: 12, TEA_TIME: 4.5, SIT_RANGE: 11,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = World;
  else root.World = World;
})(typeof self !== 'undefined' ? self : this);
