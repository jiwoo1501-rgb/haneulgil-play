// 지구·벡터·회전 수학 (Cesium 없이 Node에서도 동작)
// 좌표: ECEF(지구 중심 고정, m), WGS84 타원체, 각도는 라디안

export const DEG = Math.PI / 180;
export const KT = 0.514444;          // 1 kt = m/s
export const FT = 0.3048;            // 1 ft = m
export const NM = 1852;              // 1 해리 = m
export const FPM = FT / 60;          // 1 ft/min = m/s

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const B = A * (1 - F);
const EP2 = (A * A - B * B) / (B * B);

// ---------- 3차원 벡터 ([x,y,z] 배열) ----------
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  madd: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// ---------- 좌표 변환 ----------
export function geodeticToEcef(lat, lon, h) {
  const s = Math.sin(lat), c = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(lon), (N + h) * c * Math.sin(lon), (N * (1 - E2) + h) * s];
}

// Bowring 방식 (1회 반복으로 mm 정밀도)
export function ecefToGeodetic(p) {
  const [x, y, z] = p;
  const r = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let beta = Math.atan2(z * A, r * B);
  let lat = Math.atan2(z + EP2 * B * Math.sin(beta) ** 3, r - E2 * A * Math.cos(beta) ** 3);
  beta = Math.atan2((1 - F) * Math.sin(lat), Math.cos(lat));
  lat = Math.atan2(z + EP2 * B * Math.sin(beta) ** 3, r - E2 * A * Math.cos(beta) ** 3);
  const s = Math.sin(lat);
  const N = A / Math.sqrt(1 - E2 * s * s);
  const h = r * Math.cos(lat) + (z + E2 * N * s) * s - N;
  return { lat, lon, h };
}

// 지역 좌표축 (동·북·위) — ECEF 단위벡터
export function enu(lat, lon) {
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return {
    e: [-so, co, 0],
    n: [-sl * co, -sl * so, cl],
    u: [cl * co, cl * so, sl],
  };
}

// ---------- 쿼터니언 [w,x,y,z] ----------
export const quat = {
  mul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
  },
  norm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  // 회전행렬(열 = 몸체축의 바깥좌표 표현) → 쿼터니언
  fromCols(c0, c1, c2) {
    const m00 = c0[0], m10 = c0[1], m20 = c0[2];
    const m01 = c1[0], m11 = c1[1], m21 = c1[2];
    const m02 = c2[0], m12 = c2[1], m22 = c2[2];
    const tr = m00 + m11 + m22;
    let w, x, y, z;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    return quat.norm([w, x, y, z]);
  },
  // 쿼터니언 → 열벡터 3개 (몸체 x,y,z축의 바깥좌표 표현)
  toCols(q) {
    const [w, x, y, z] = q;
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
      [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
      [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
    ];
  },
  // 몸체 각속도 w(rad/s)로 dt 동안 회전 (정확한 지수사상)
  integrate(q, w, dt) {
    const ang = Math.hypot(w[0], w[1], w[2]) * dt;
    if (ang < 1e-12) return q;
    const s = Math.sin(ang / 2) / (ang / dt);
    const dq = [Math.cos(ang / 2), w[0] * s, w[1] * s, w[2] * s];
    return quat.norm(quat.mul(q, dq));
  },
};

// ---------- 자세 (지역 북·동·아래 기준 방위·피치·롤) ----------
// 몸체축: x 앞, y 오른쪽, z 아래 (항공 표준)
export function attitudeToQuat(lat, lon, psi, theta, phi) {
  const { e, n, u } = enu(lat, lon);
  const d = v3.scale(u, -1);
  const cps = Math.cos(psi), sps = Math.sin(psi);
  const cth = Math.cos(theta), sth = Math.sin(theta);
  const cph = Math.cos(phi), sph = Math.sin(phi);
  // NED 기준 몸체축 (3-2-1 오일러)
  const xb = [cth * cps, cth * sps, -sth];
  const yb = [sph * sth * cps - cph * sps, sph * sth * sps + cph * cps, sph * cth];
  const zb = [cph * sth * cps + sph * sps, cph * sth * sps - sph * cps, cph * cth];
  const toE = (b) => [
    n[0] * b[0] + e[0] * b[1] + d[0] * b[2],
    n[1] * b[0] + e[1] * b[1] + d[1] * b[2],
    n[2] * b[0] + e[2] * b[1] + d[2] * b[2],
  ];
  return quat.fromCols(toE(xb), toE(yb), toE(zb));
}

export function quatToAttitude(q, lat, lon) {
  const [xb, yb, zb] = quat.toCols(q);
  const { e, n, u } = enu(lat, lon);
  const d = v3.scale(u, -1);
  // NED 성분
  const x = [v3.dot(xb, n), v3.dot(xb, e), v3.dot(xb, d)];
  const y2 = v3.dot(yb, d), z2 = v3.dot(zb, d);
  const theta = -Math.asin(Math.max(-1, Math.min(1, x[2])));
  const phi = Math.atan2(y2, z2);
  const psi = Math.atan2(x[1], x[0]);
  return { psi: (psi + 2 * Math.PI) % (2 * Math.PI), theta, phi };
}

// ---------- 대권 거리·방위 (구면 근사, 오차 0.5% 이내) ----------
const R_MEAN = 6371008.8;
export function distBrg(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1, dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const dist = 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return { dist, brg: (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI) };
}

export function destPoint(lat, lon, brg, dist) {
  const d = dist / R_MEAN;
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
  return { lat: lat2, lon: lon2 };
}

// 각도 차이 (-π..π)
export function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
