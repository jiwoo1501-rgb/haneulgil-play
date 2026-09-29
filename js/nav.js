// 활주로 기하·항로
import { findRunwayEnd, MAG_VAR_DEG } from '../data/airports.js?v=202609291349';
import { DEG, NM, FT, distBrg, destPoint, angDiff, enu, v3, geodeticToEcef } from './geo.js?v=202609291349';

const MAGVAR = MAG_VAR_DEG * DEG;
export const toMag = (t) => (((t - MAGVAR) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
export const toTrue = (m) => (((m + MAGVAR) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// 활주로 끝 정보 → 기하 (시단, 진방위, 길이). 높이(h0/h1)는 지형 측정 후 채움
export function runwayGeom(icao, endName) {
  const r = findRunwayEnd(icao, endName);
  if (!r) throw new Error('활주로 없음: ' + icao + ' ' + endName);
  const { apt, rwy, end, opp } = r;
  const lat = end.lat * DEG, lon = end.lon * DEG;
  const oLat = opp.lat * DEG, oLon = opp.lon * DEG;
  const { dist, brg } = distBrg(lat, lon, oLat, oLon);
  const disp = end.disp || 0;
  const thr = disp ? destPoint(lat, lon, brg, disp) : { lat, lon };
  return {
    icao, apt, name: end.name, rwyId: rwy.id, width: rwy.width,
    endLat: lat, endLon: lon, lat: thr.lat, lon: thr.lon, oppLat: oLat, oppLon: oLon,
    crs: brg, len: dist, disp, lda: dist - disp,
    elevFt: end.elevFt ?? apt.elevFt, oppElevFt: opp.elevFt ?? apt.elevFt,
    h0: null, h1: null, profile: null, geoidN: 0,
  };
}

// 활주로 좌표계 (시단 기준 ECEF 단위벡터: c = 활주로 방향, r = 오른쪽)
function rwyFrame(g) {
  if (g._f) return g._f;
  const { e, n } = enu(g.lat, g.lon);
  const c = v3.add(v3.scale(n, Math.cos(g.crs)), v3.scale(e, Math.sin(g.crs)));
  const r = v3.sub(v3.scale(e, Math.cos(g.crs)), v3.scale(n, Math.sin(g.crs)));
  g._f = { p0: geodeticToEcef(g.lat, g.lon, 0), c, r };
  return g._f;
}

// 활주로 기준 위치: along(m, 시단에서 활주로 방향 +), cross(m, 오른쪽 +)
export function rwyRel(g, lat, lon) {
  const f = rwyFrame(g);
  const dp = v3.sub(geodeticToEcef(lat, lon, 0), f.p0);
  return { along: v3.dot(dp, f.c), cross: v3.dot(dp, f.r) };
}

// 활주로 방향 대비 속도(또는 기수) 각도 (rad, 오른쪽 +)
export function rwyAngle(g, vec) {
  const f = rwyFrame(g);
  return Math.atan2(v3.dot(vec, f.r), v3.dot(vec, f.c));
}

// 활주로 표면 높이 (시단 기준 along 위치) — profile: [{s, h}] (s = 활주로 끝(end)에서의 거리)
export function rwySurfaceH(g, along) {
  const s = along + g.disp;
  const P = g.profile;
  if (!P || !P.length) return g.h0;
  if (s <= P[0].s) return P[0].h;
  for (let i = 1; i < P.length; i++) {
    if (s <= P[i].s) {
      const t = (s - P[i - 1].s) / (P[i].s - P[i - 1].s);
      return P[i - 1].h + (P[i].h - P[i - 1].h) * t;
    }
  }
  return P[P.length - 1].h;
}

// 연장선 위 지점 (시단에서 활주로 반대 방향으로 dist m)
export function finalFix(g, dist) {
  return destPoint(g.lat, g.lon, (g.crs + Math.PI) % (2 * Math.PI), dist);
}

// 도착 경로점: 20NM(진입) → 12NM(IF)
export function approachWaypoints(g) {
  const base = finalFix(g, 20 * NM), iF = finalFix(g, 12 * NM);
  return [
    { ...base, name: g.icao.slice(2) + g.name + ' 20NM', along: -20 * NM },
    { ...iF, name: g.icao.slice(2) + g.name + ' IF', along: -12 * NM },
  ];
}

export const GS_ANGLE = 3 * DEG;
export const GPI = 204; // 바퀴 기준 활공각 기점 (시단 후 m, 시단 통과고도 약 35ft)
export const IF_HEIGHT = 3000 * FT;
