/* global Cesium */
// 활주로 평탄화 지형: Cesium World Terrain 위에 활주로 구역만 매끈한 경사면으로 바꿔 줌
// (원본 지형 자료에는 인천공항 활주로에서도 ±6m 요철이 있어 바퀴가 뜨거나 파묻힘)
// 활주로마다 중심선 높이를 측정 → 직선 회귀(이상치 제거) → 구역 안 지형 꼭짓점을 그 높이로 맞춤

import { rwyRel } from './nav.js?v=202609291314';
import { destPoint } from './geo.js?v=202609291314';

const INNER = 110;   // 중심선에서 완전 평탄 폭 (m, 한쪽)
const BLEND = 90;    // 자연 지형으로 이어지는 폭 (m)
const END = 250;     // 활주로 끝 너머 평탄 구간 (m)

// 활주로 중심선 샘플 → 강건한 직선 (h = a + b·s, s = 활주로 끝에서의 거리)
export function fitProfile(samples) {
  let pts = samples.slice();
  let a = 0, b = 0;
  for (let iter = 0; iter < 4; iter++) {
    const n = pts.length;
    const ms = pts.reduce((x, p) => x + p.s, 0) / n, mh = pts.reduce((x, p) => x + p.h, 0) / n;
    let sxx = 0, sxy = 0;
    for (const p of pts) { sxx += (p.s - ms) ** 2; sxy += (p.s - ms) * (p.h - mh); }
    b = sxx > 0 ? sxy / sxx : 0;
    // 활주로 경사는 실제로 1% 이내
    b = Math.max(-0.01, Math.min(0.01, b));
    a = mh - b * ms;
    const res = pts.map((p) => Math.abs(p.h - (a + b * p.s)));
    const sorted = res.slice().sort((x, y) => x - y);
    const lim = Math.max(1.0, sorted[Math.floor(sorted.length * 0.7)] * 1.5);
    const keep = pts.filter((p, i) => res[i] <= lim);
    if (keep.length < 4 || keep.length === pts.length) break;
    pts = keep;
  }
  return { a, b };
}

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

export class FlatTerrainProvider {
  constructor(inner, zones) {
    this.inner = inner;
    this.zones = zones;           // [{ g, a, b, bbox:{w,s,e,n} }]
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

  // 구역 안이면 목표 높이와 가중치 반환
  target(lat, lon) {
    let best = null;
    for (const z of this.zones) {
      const b = z.bbox;
      if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
      const r = rwyRel(z.g, lat, lon);
      const s = r.along + z.g.disp;
      const dx = Math.max(0, Math.abs(r.cross) - INNER);
      const ds = s < -END ? -END - s : s > z.g.len + END ? s - (z.g.len + END) : 0;
      const dist = Math.hypot(dx, ds);
      if (dist >= BLEND) continue;
      const w = dist <= 0 ? 1 : 1 - smooth(dist / BLEND);
      const sc = Math.max(0, Math.min(z.g.len, s));
      const h = z.a + z.b * sc;
      if (!best || w > best.w || (w === best.w && Math.abs(r.cross) < best.c)) best = { h, w, c: Math.abs(r.cross) };
    }
    return best;
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
    let changed = false, lo = Infinity, hi = -Infinity;
    const W = rect.east - rect.west, H = rect.north - rect.south;
    for (let i = 0; i < n; i++) {
      const lon = rect.west + (qv[i] / 32767) * W;
      const lat = rect.south + (qv[n + i] / 32767) * H;
      let h = minH + (qv[2 * n + i] / 32767) * (maxH - minH);
      const t = this.target(lat, lon);
      if (t) { h = h + (t.h - h) * t.w; changed = true; }
      heights[i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (!changed) return td;
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
        const lon = rect.west + (qv[i] / 32767) * W, lat = rect.south + (qv[n + i] / 32767) * H;
        const t = this.target(lat, lon);
        if (!t || t.w < 0.5) continue;
        carto.longitude = lon; carto.latitude = lat; carto.height = 0;
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
      childTileMask: td._childTileMask, encodedNormals: normals, waterMask: td._waterMask, credits: td._credits,
    });
  }
}

function smooth(t) { return t * t * (3 - 2 * t); }

// 활주로 기하 → 평탄화 구역
export function makeZone(g, fit) {
  const pad = INNER + BLEND + 50, ext = END + BLEND + 50;
  const corners = [];
  for (const s of [-ext, g.len + ext]) for (const c of [-pad, pad]) {
    const p = destPoint(g.endLat, g.endLon, g.crs, s);
    corners.push(destPoint(p.lat, p.lon, g.crs + Math.PI / 2, c));
  }
  const lats = corners.map((c) => c.lat), lons = corners.map((c) => c.lon);
  return { g, a: fit.a, b: fit.b, bbox: { s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) } };
}
