/* global Cesium */
// 공항 부지 평탄화 지형
// 원본 Cesium World Terrain은 공항 부지에도 수~수십 m 요철이 있음 (인천: 실제 해발 약 7m 평지인데 자료는 24~74m 혼재)
// → 공항 경계(OpenStreetMap) 안쪽은 공항 표면으로, 경계 밖 300m는 자연 지형으로 부드럽게 이어 줌
//   공항 표면 = 활주로 끝 공식 표고(AIP) + 지오이드 높이(원본 지형 중앙값으로 추정)로 만든 평면,
//   활주로 주변은 그 활주로의 표고 직선(양 끝 AIP 표고)을 그대로 사용

import { destPoint } from './geo.js?v=202609291420';

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
  // 경계까지의 부호 거리(안쪽 음수)를 25m 격자로 미리 계산 → 타일마다 다각형 계산을 반복하지 않음
  const cell = 25;
  const nx = Math.ceil((bx.x1 - bx.x0) / cell) + 1, ny = Math.ceil((bx.y1 - bx.y0) / cell) + 1;
  const sd = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = bx.x0 + i * cell, y = bx.y0 + j * cell;
    const dd = distPoly(poly, x, y);
    sd[j * nx + i] = inPoly(poly, x, y) ? -dd : dd;
  }
  const raster = { cell, nx, ny, sd };
  return { icao: apt.icao, lat0, lon0, kx, ky, N, plane, rwys, poly, bx, bbox, raster };
}

// 부호 거리 (양선형 보간)
function signedDist(z, x, y) {
  const r = z.raster;
  const fx = (x - z.bx.x0) / r.cell, fy = (y - z.bx.y0) / r.cell;
  const i = Math.max(0, Math.min(r.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(r.ny - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
  const a = r.sd[j * r.nx + i], b = r.sd[j * r.nx + i + 1], c = r.sd[(j + 1) * r.nx + i], d = r.sd[(j + 1) * r.nx + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
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
    if (signedDist(z, x, y) <= 0) return true;
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
    const sdv = signedDist(z, x, y);
    const inside = sdv <= 0;
    let w = inside ? 1 : 1 - smooth(sdv / BAND);
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
    const W = rect.east - rect.west, H = rect.north - rect.south;
    const E = this.ellipsoid;
    // 1) 꼭짓점 목록: 공항 근처 세밀한 타일은 원본 삼각망을 65×65 격자로 다시 만듦
    //    (바다였던 매립지는 원본 꼭짓점이 드물어 큰 삼각형이 활주로를 가로질러 가운데가 처졌음)
    let U, V, Hs, indices, edges, grid = 0;
    const src = decodeMesh(td);
    if (level >= 11) {
      grid = 65;
      const g = regrid(src, grid);
      U = g.u; V = g.v; Hs = g.h; indices = g.indices; edges = g.edges;
    } else {
      U = src.u; V = src.v; Hs = src.h; indices = td._indices;
      edges = { w: td._westIndices, s: td._southIndices, e: td._eastIndices, n: td._northIndices };
    }
    const n = U.length;
    const flat = new Uint8Array(n);
    let changed = grid > 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const lon = rect.west + U[i] * W, lat = rect.south + V[i] * H;
      let h = Hs[i];
      const t = zoneTarget(this.zones, lat, lon, h);
      if (t) { h = h + (t.h - h) * t.w; changed = true; if (t.w > 0.5) flat[i] = 1; }
      Hs[i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const waterMask = this.clearWater(td._waterMask, rect);
    if (!changed && waterMask === td._waterMask) return td;
    const range = Math.max(hi - lo, 0.01);
    const out = new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i] = Math.round(U[i] * 32767);
      out[n + i] = Math.round(V[i] * 32767);
      out[2 * n + i] = Math.round(((Hs[i] - lo) / range) * 32767);
    }
    const pts = [];
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 400))) {
      pts.push(E.cartographicToCartesian(new Cesium.Cartographic(rect.west + U[i] * W, rect.south + V[i] * H, Hs[i])));
    }
    const bs = Cesium.BoundingSphere.fromPoints(pts);
    bs.radius *= 1.05;
    const obb = Cesium.OrientedBoundingBox.fromRectangle(rect, lo, hi, E);
    // 2) 법선: 격자면 높이로 새로 계산, 아니면 평탄해진 곳만 수직으로
    let normals = td._encodedNormals;
    if (normals) {
      normals = grid ? gridNormals(U, V, Hs, grid, rect, E) : new Uint8Array(normals);
      if (!grid) {
        const c2 = new Cesium.Cartesian2(), nrm = new Cesium.Cartesian3(), carto = new Cesium.Cartographic();
        for (let i = 0; i < n; i++) {
          if (!flat[i]) continue;
          carto.longitude = rect.west + U[i] * W; carto.latitude = rect.south + V[i] * H; carto.height = 0;
          E.geodeticSurfaceNormalCartographic(carto, nrm);
          Cesium.AttributeCompression.octEncode(nrm, c2);
          normals[2 * i] = c2.x; normals[2 * i + 1] = c2.y;
        }
      }
    }
    return new Cesium.QuantizedMeshTerrainData({
      minimumHeight: lo, maximumHeight: hi, quantizedVertices: out, indices,
      boundingSphere: bs, orientedBoundingBox: obb, horizonOcclusionPoint: td._horizonOcclusionPoint,
      westIndices: edges.w, southIndices: edges.s, eastIndices: edges.e, northIndices: edges.n,
      westSkirtHeight: td._westSkirtHeight, southSkirtHeight: td._southSkirtHeight, eastSkirtHeight: td._eastSkirtHeight, northSkirtHeight: td._northSkirtHeight,
      childTileMask: td._childTileMask, encodedNormals: normals, waterMask, credits: td._credits,
    });
  }
}

// 양자화 메시 → u, v(0~1), 높이(m)
function decodeMesh(td) {
  const qv = td._quantizedVertices, n = qv.length / 3;
  const minH = td._minimumHeight, maxH = td._maximumHeight;
  const u = new Float64Array(n), v = new Float64Array(n), h = new Float64Array(n);
  for (let i = 0; i < n; i++) { u[i] = qv[i] / 32767; v[i] = qv[n + i] / 32767; h[i] = minH + (qv[2 * n + i] / 32767) * (maxH - minH); }
  return { u, v, h, idx: td._indices };
}

// 원본 삼각망을 N×N 격자로 다시 샘플링 (삼각형 버킷으로 빠르게 위치 찾기)
function regrid(src, N) {
  const { u, v, h, idx } = src;
  const B = 24;
  const buckets = Array.from({ length: B * B }, () => []);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const u0 = Math.min(u[a], u[b], u[c]), u1 = Math.max(u[a], u[b], u[c]);
    const v0 = Math.min(v[a], v[b], v[c]), v1 = Math.max(v[a], v[b], v[c]);
    const i0 = Math.max(0, Math.floor(u0 * B)), i1 = Math.min(B - 1, Math.floor(u1 * B));
    const j0 = Math.max(0, Math.floor(v0 * B)), j1 = Math.min(B - 1, Math.floor(v1 * B));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * B + i].push(t);
  }
  const heightAt = (x, y) => {
    const list = buckets[Math.min(B - 1, Math.floor(y * B)) * B + Math.min(B - 1, Math.floor(x * B))];
    let best = null, bestErr = Infinity;
    for (const t of list) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const d = (v[b] - v[c]) * (u[a] - u[c]) + (u[c] - u[b]) * (v[a] - v[c]);
      if (Math.abs(d) < 1e-14) continue;
      const l1 = ((v[b] - v[c]) * (x - u[c]) + (u[c] - u[b]) * (y - v[c])) / d;
      const l2 = ((v[c] - v[a]) * (x - u[c]) + (u[a] - u[c]) * (y - v[c])) / d;
      const l3 = 1 - l1 - l2;
      const err = Math.max(0, -l1, -l2, -l3);
      if (err < bestErr) { bestErr = err; best = l1 * h[a] + l2 * h[b] + l3 * h[c]; if (err === 0) break; }
    }
    return best ?? 0;
  };
  const n = N * N;
  const gu = new Float64Array(n), gv = new Float64Array(n), gh = new Float64Array(n);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    gu[k] = i / (N - 1); gv[k] = j / (N - 1);
    gh[k] = heightAt(gu[k], gv[k]);
  }
  const indices = new Uint16Array((N - 1) * (N - 1) * 6);
  let p = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N + 1, d = a + N;
    indices[p++] = a; indices[p++] = b; indices[p++] = c;
    indices[p++] = a; indices[p++] = c; indices[p++] = d;
  }
  const w = [], s = [], e = [], nn = [];
  for (let k = 0; k < N; k++) { w.push(k * N); e.push(k * N + N - 1); s.push(k); nn.push((N - 1) * N + k); }
  return { u: gu, v: gv, h: gh, indices, edges: { w: new Uint16Array(w), s: new Uint16Array(s), e: new Uint16Array(e), n: new Uint16Array(nn) } };
}

// 격자 꼭짓점 법선 (지구 중심 좌표, 8방위 압축)
function gridNormals(U, V, Hs, N, rect, E) {
  const W = rect.east - rect.west, H = rect.north - rect.south;
  const P = new Array(N * N);
  for (let k = 0; k < N * N; k++) P[k] = E.cartographicToCartesian(new Cesium.Cartographic(rect.west + U[k] * W, rect.south + V[k] * H, Hs[k]));
  const out = new Uint8Array(N * N * 2);
  const ex = new Cesium.Cartesian3(), ny = new Cesium.Cartesian3(), nrm = new Cesium.Cartesian3(), c2 = new Cesium.Cartesian2();
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const iL = Math.max(0, i - 1), iR = Math.min(N - 1, i + 1), jD = Math.max(0, j - 1), jU = Math.min(N - 1, j + 1);
    Cesium.Cartesian3.subtract(P[j * N + iR], P[j * N + iL], ex);
    Cesium.Cartesian3.subtract(P[jU * N + i], P[jD * N + i], ny);
    Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(ex, ny, nrm), nrm);
    Cesium.AttributeCompression.octEncode(nrm, c2);
    out[2 * k] = c2.x; out[2 * k + 1] = c2.y;
  }
  return out;
}
