// 국제표준대기(ISA, ICAO Doc 7488) + 속도 환산
const R = 287.05287, G0 = 9.80665, GAMMA = 1.4;
export const RHO0 = 1.225, P0 = 101325, T0 = 288.15, A0 = 340.294;

// h: 해발고도(m, 기하고도≈지오퍼텐셜 고도로 취급)
export function isa(h) {
  let T, p;
  if (h < 11000) {
    T = T0 - 0.0065 * h;
    p = P0 * Math.pow(T / T0, G0 / (0.0065 * R));
  } else {
    T = 216.65;
    const p11 = P0 * Math.pow(216.65 / T0, G0 / (0.0065 * R));
    p = p11 * Math.exp(-G0 * (h - 11000) / (R * T));
  }
  const rho = p / (R * T);
  return { T, p, rho, a: Math.sqrt(GAMMA * R * T), sigma: rho / RHO0 };
}

// 진대기속도(TAS) → 교정대기속도(CAS), 압축성 보정 포함
export function tasToCas(tas, atm) {
  const M = tas / atm.a;
  const qc = atm.p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

export function casToTas(cas, atm) {
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1);
  const M = Math.sqrt(5 * (Math.pow(qc / atm.p + 1, 2 / 7) - 1));
  return M * atm.a;
}

export function machToCas(M, atm) {
  return tasToCas(M * atm.a, atm);
}
