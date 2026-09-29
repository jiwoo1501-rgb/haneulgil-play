/* global Cesium */
// 공항 부지 평탄화 지형
// 원본 Cesium World Terrain은 공항 부지에도 수~수십 m 요철이 있음 (인천: 실제 해발 약 7m 평지인데 자료는 24~74m 혼재)
// → 공항 경계(OpenStreetMap) 안쪽은 공항 표면으로, 경계 밖 300m는 자연 지형으로 부드럽게 이어 줌
//   공항 표면 = 활주로 끝 공식 표고(AIP) + 지오이드 높이(원본 지형 중앙값으로 추정)로 만든 평면,
//   활주로 주변은 그 활주로의 표고 직선(양 끝 AIP 표고)을 그대로 사용

import { destPoint } from './geo.js?v=202609291349';

const R = 6371008.8;
const BAND = 300;       // 경계 밖 연결 폭 (m)
const RWY_FULL = 80;    // 활주로 중심선에서 활주로 표고를 그대로 쓰는 폭 (m, 한쪽)
const RWY_BLEND = 90;   // 그 바깥에서 공항 평면으로 넘어가는 폭 (m)
const RWY_END = 300;    // 활주로 끝 너머까지 활주로 표고 연장 (m)

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 활주로 중심선 원본 높이 샘플 (100m 간격)
export async function sampleRunway(provider, g) {
  const n = Math.max(12, Math.ceil(g.len / 100));
  const cs = [];
  for (let i = 0; i <= n; i++) {
    const s = (g.len * i) / n;
    const p = destPoint(g.endLat, g.endLon, g.crs, s);
    cs.push(Cesium.Cartographic.fromRadians(p.lon, p.lat));
  }
  await Cesium.sampleTerrainMostDetailed(provider, cs);
  return cs.map((c, i) => ({ s: (g.len * i) / n, h: c.height }));
}

const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

// 공항별 평탄화 구역 만들기. runways: 활주로 끝 기하(양방향 전부), samples: Map(rwyKey → 샘플), area: [[위도,경도]...]
// 부수효과: 각 활주로 끝 기하에 profile·h0·h1·geoidN 을 채움
export function buildAirportZone(apt, runways, samplesByRwy, area) {
  const lat0 = apt.lat * Math.PI / 180, lon0 = apt.lon * Math.PI / 180;
  const kx = Math.cos(lat0) * R, ky = R;
  const toXY = (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const ft = 0.3048;
  // 1) 지오이드 높이 추정: 활주로마다 (원본 지형 높이 − 공식 표고)의 중앙값 → 그중 최댓값
  //    (지형 자료가 매립 전 측량이라 새 활주로 자리가 바다 높이로 남아 있는 경우가 있어 — 인천 3·4활주로 — 낮은 쪽은 버림)
  const phys = [];   // 물리적 활주로 1개당 대표 끝
  const meds = [];
  for (const g of runways) {
    const smp = samplesByRwy.get(g.icao + g.rwyId + g.name);
    if (!smp) continue;
    phys.push(g);
    meds.push(median(smp.map((p) => p.h - (g.elevFt + (g.oppElevFt - g.elevFt) * (p.s / g.len)) * ft)));
  }
  const N = Math.max(...meds);
  // 2) 활주로 표고 직선 (양 끝 공식 표고 + N)
  for (const g of runways) {
    const hA = N + g.elevFt * ft, hB = N + g.oppElevFt * ft;
    g.profile = [{ s: 0, h: hA }, { s: g.len, h: hB }];
    g.h0 = hA + (hB - hA) * (g.disp / g.len);
    g.h1 = hB;
    g.geoidN = N;
  }
  // 3) 공항 평면: 활주로 양 끝 점들로 최소제곱 평면 h = a + bx + cy
  const pts = [];
  for (const g of phys) {
    const [x1, y1] = toXY(g.endLat, g.endLon), [x2, y2] = toXY(g.oppLat, g.oppLon);
    pts.push([x1, y1, g.profile[0].h], [x2, y2, g.profile[1].h]);
  }
  let plane = { a: median(pts.map((p) => p[2])), b: 0, c: 0 };
  if (pts.length >= 3) {
    // 정규방정식 3x3
    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], T = [0, 0, 0];
    for (const [x, y, h] of pts) {
      const v = [1, x, y];
      for (let i = 0; i < 3; i++) { T[i] += v[i] * h; for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; }
    }
    const sol = solve3(S, T);
    if (sol) plane = { a: sol[0], b: sol[1], c: sol[2] };
  }
  // 4) 활주로 중심선 (지역 좌표)
  const rwys = phys.map((g) => {
    const [x1, y1] = toXY(g.endLat, g.endLon), [x2, y2] = toXY(g.oppLat, g.oppLon);
    const len = Math.hypot(x2 - x1, y2 - y1);
    return { x1, y1, ux: (x2 - x1) / len, uy: (y2 - y1) / len, len, hA: g.profile[0].h, hB: g.profile[1].h };
  });
  const poly = area.map(([la, lo]) => toXY(la * Math.PI / 180, lo * Math.PI / 180));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  for (const r of rwys) { xs.push(r.x1 - r.ux * RWY_END, r.x1 + r.ux * (r.len + RWY_END)); ys.push(r.y1 - r.uy * RWY_END, r.y1 + r.uy * (r.len + RWY_END)); }
  const pad = BAND + 50;
  const bx = { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
  const bbox = { w: lon0 + bx.x0 / kx, e: lon0 + bx.x1 / kx, s: lat0 + bx.y0 / ky, n: lat0 + bx.y1 / ky };
  return { icao: apt.icao, lat0, lon0, kx, ky, N, plane, rwys, poly, bx, bbox };
}

function solve3(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

function inPoly(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function distPoly(poly, x, y) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j], [x2, y2] = poly[i];
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L));
    const d = Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
    if (d < best) best = d;
  }
  return best;
}

// 공항 부지(경계 안 또는 활주로 연장 구역)인가
export function isAirportLand(zones, lat, lon) {
  for (const z of zones) {
    const b = z.bbox;
    if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
    const x = (lon - z.lon0) * z.kx, y = (lat - z.lat0) * z.ky;
    if (inPoly(z.poly, x, y)) return true;
    for (const r of z.rwys) {
      const a = (x - r.x1) * r.ux + (y - r.y1) * r.uy;
      const c = Math.abs((x - r.x1) * r.uy - (y - r.y1) * r.ux);
      if (a > -RWY_END && a < r.len + RWY_END && c < RWY_FULL) return true;
    }
  }
  return false;
}

// 한 지점의 목표 높이와 적용 비율 (없으면 null)
export function zoneTarget(zones, lat, lon, raw) {
  for (const z of zones) {
    const b = z.bbox;
    if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
    const x = (lon - z.lon0) * z.kx, y = (lat - z.lat0) * z.ky;
    const inside = inPoly(z.poly, x, y);
    let w = inside ? 1 : 1 - smooth(distPoly(z.poly, x, y) / BAND);
    // 공항 평면 + 활주로 표고
    let h = z.plane.a + z.plane.b * x + z.plane.c * y;
    let wr = 0, hr = h;
    for (const r of z.rwys) {
      const a = (x - r.x1) * r.ux + (y - r.y1) * r.uy;
      if (a < -RWY_END - RWY_BLEND || a > r.len + RWY_END + RWY_BLEND) continue;
      const c = Math.abs((x - r.x1) * r.uy - (y - r.y1) * r.ux);
      const dc = Math.max(0, c - RWY_FULL);
      const da = a < -RWY_END ? -RWY_END - a : a > r.len + RWY_END ? a - r.len - RWY_END : 0;
      const wk = 1 - smooth(Math.hypot(dc, da) / RWY_BLEND);
      if (wk > wr) {
        wr = wk;
        const s = Math.max(0, Math.min(r.len, a));
        hr = r.hA + (r.hB - r.hA) * (s / r.len);
      }
    }
    h = h + (hr - h) * wr;
    w = Math.max(w, wr);
    if (w <= 0) continue;
    // 경계 밖의 진짜 언덕·산은 그대로 둠 (목표와 크게 다르면 적용 비율을 줄임)
    const tol = inside || wr > 0.99 ? 60 : 15;
    w *= 1 - smooth((Math.abs(raw - h) - tol) / 30);
    return w > 0 ? { h, w } : null;
  }
  return null;
}

export class FlatTerrainProvider {
  constructor(inner, zones) {
    this.inner = inner;
    this.zones = zones;
    this.ellipsoid = inner.tilingScheme.ellipsoid;
  }
  get tilingScheme() { return this.inner.tilingScheme; }
  get errorEvent() { return this.inner.errorEvent; }
  get credit() { return this.inner.credit; }
  get hasWaterMask() { return this.inner.hasWaterMask; }
  get hasVertexNormals() { return this.inner.hasVertexNormals; }
  get availability() { return this.inner.availability; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }
  getLevelMaximumGeometricError(level) { return this.inner.getLevelMaximumGeometricError(level); }
  getTileDataAvailable(x, y, level) { return this.inner.getTileDataAvailable(x, y, level); }
  loadTileDataAvailability(x, y, level) { return this.inner.loadTileDataAvailability(x, y, level); }

  requestTileGeometry(x, y, level, request) {
    const p = this.inner.requestTileGeometry(x, y, level, request);
    if (!p) return p;
    return p.then((td) => {
      try { return this.flatten(td, x, y, level); } catch (e) { console.warn('평탄화 실패', e); return td; }
    });
  }

  // 공항 부지 안은 물 표시(파도 반사) 제거 — 원본 물 표시가 매립 전 해안선이라 활주로 위에 물결이 보였음
  // 물 표시: 256×256, 북→남 행, 서→동 열 (1바이트면 타일 전체 값)
  clearWater(mask, rect) {
    if (!mask) return mask;
    if (mask.length === 1 && mask[0] === 0) return mask;
    const W = rect.east - rect.west, H = rect.north - rect.south;
    let out = null;
    const B = 4;  // 4×4 픽셀 단위로 판정
    for (let r = 0; r < 256; r += B) {
      for (let c = 0; c < 256; c += B) {
        const lat = rect.north - ((r + B / 2) / 256) * H, lon = rect.west + ((c + B / 2) / 256) * W;
        if (!isAirportLand(this.zones, lat, lon)) continue;
        if (!out) { out = mask.length === 1 ? new Uint8Array(65536).fill(mask[0]) : new Uint8Array(mask); }
        for (let i = 0; i < B; i++) out.fill(0, (r + i) * 256 + c, (r + i) * 256 + c + B);
      }
    }
    return out || mask;
  }

  flatten(td, x, y, level) {
    if (!(td instanceof Cesium.QuantizedMeshTerrainData)) return td;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const hit = this.zones.some((z) => !(z.bbox.w > rect.east || z.bbox.e < rect.west || z.bbox.s > rect.north || z.bbox.n < rect.south));
    if (!hit) return td;
    const qv = td._quantizedVertices;
    const n = qv.length / 3;
    const minH = td._minimumHeight, maxH = td._maximumHeight;
    const heights = new Float64Array(n);
    const flat = new Uint8Array(n);
    let changed = false, lo = Infinity, hi = -Infinity;
    const W = rect.east - rect.west, H = rect.north - rect.south;
    for (let i = 0; i < n; i++) {
      const lon = rect.west + (qv[i] / 32767) * W;
      const lat = rect.south + (qv[n + i] / 32767) * H;
      let h = minH + (qv[2 * n + i] / 32767) * (maxH - minH);
      const t = zoneTarget(this.zones, lat, lon, h);
      if (t) { h = h + (t.h - h) * t.w; changed = true; if (t.w > 0.5) flat[i] = 1; }
      heights[i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const waterMask = this.clearWater(td._waterMask, rect);
    if (!changed && waterMask === td._waterMask) return td;
    const out = new Uint16Array(qv);
    const range = Math.max(hi - lo, 0.01);
    for (let i = 0; i < n; i++) out[2 * n + i] = Math.round(((heights[i] - lo) / range) * 32767);
    const E = this.ellipsoid;
    const pts = [];
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 400))) {
      pts.push(E.cartographicToCartesian(new Cesium.Cartographic(rect.west + (qv[i] / 32767) * W, rect.south + (qv[n + i] / 32767) * H, heights[i])));
    }
    const bs = Cesium.BoundingSphere.fromPoints(pts);
    bs.radius *= 1.05;
    const obb = Cesium.OrientedBoundingBox.fromRectangle(rect, lo, hi, E);
    // 평탄해진 곳의 법선은 수직
    let normals = td._encodedNormals;
    if (normals) {
      normals = new Uint8Array(normals);
      const c2 = new Cesium.Cartesian2(), nrm = new Cesium.Cartesian3(), carto = new Cesium.Cartographic();
      for (let i = 0; i < n; i++) {
        if (!flat[i]) continue;
        carto.longitude = rect.west + (qv[i] / 32767) * W; carto.latitude = rect.south + (qv[n + i] / 32767) * H; carto.height = 0;
        E.geodeticSurfaceNormalCartographic(carto, nrm);
        Cesium.AttributeCompression.octEncode(nrm, c2);
        normals[2 * i] = c2.x; normals[2 * i + 1] = c2.y;
      }
    }
    return new Cesium.QuantizedMeshTerrainData({
      minimumHeight: lo, maximumHeight: hi, quantizedVertices: out, indices: td._indices,
      boundingSphere: bs, orientedBoundingBox: obb, horizonOcclusionPoint: td._horizonOcclusionPoint,
      westIndices: td._westIndices, southIndices: td._southIndices, eastIndices: td._eastIndices, northIndices: td._northIndices,
      westSkirtHeight: td._westSkirtHeight, southSkirtHeight: td._southSkirtHeight, eastSkirtHeight: td._eastSkirtHeight, northSkirtHeight: td._northSkirtHeight,
      childTileMask: td._childTileMask, encodedNormals: normals, waterMask, credits: td._credits,
    });
  }
}
