// 기종 제원
// ─ 치수·중량·추력: 제조사 공개값 (출처는 docs/research.md 참고)
// ─ 공력계수(cd0, e, 플랩별 clmax·alpha0·dcd0): 공개 성능(접근속도·순항 양항비)으로 역산한 추정치 → "추정" 표기
// 단위: m, m², kg, N(엔진 1기 이륙추력), kt, ft

// 보잉 777 플랩 (UP/1/5/15/20/25/30), 속도 제한은 777 공통 플랩 플래카드
const B777_FLAPS = [
  { name: 'UP', deg: 0,  vfe: null, clmax: 1.25, a0: -2.5,  dcd0: 0.0   },
  { name: '1',  deg: 1,  vfe: 255,  clmax: 1.55, a0: -3.0,  dcd0: 0.003 },
  { name: '5',  deg: 5,  vfe: 235,  clmax: 1.75, a0: -7.0,  dcd0: 0.008 },
  { name: '15', deg: 15, vfe: 215,  clmax: 1.92, a0: -11.0, dcd0: 0.016 },
  { name: '20', deg: 20, vfe: 195,  clmax: 2.02, a0: -12.0, dcd0: 0.022 },
  { name: '25', deg: 25, vfe: 185,  clmax: 2.20, a0: -13.0, dcd0: 0.040 },
  { name: '30', deg: 30, vfe: 170,  clmax: 2.34, a0: -13.8, dcd0: 0.052 },
];

// 에어버스 CONF 0/1/1+F/2/3/FULL
function airbusFlaps(vfe) {
  return [
    { name: '0',    deg: 0,  vfe: null,   clmax: 1.25, a0: -2.5,  dcd0: 0.0   },
    { name: '1',    deg: 0,  vfe: vfe[0], clmax: 1.55, a0: -3.0,  dcd0: 0.003, slatOnly: true },
    { name: '1+F',  deg: 8,  vfe: vfe[1], clmax: 1.80, a0: -7.5,  dcd0: 0.009 },
    { name: '2',    deg: 14, vfe: vfe[2], clmax: 1.95, a0: -11.0, dcd0: 0.017 },
    { name: '3',    deg: 22, vfe: vfe[3], clmax: 2.10, a0: -12.5, dcd0: 0.030 },
    { name: 'FULL', deg: 32, vfe: vfe[4], clmax: 2.25, a0: -13.5, dcd0: 0.048 },
  ];
}

export const AIRCRAFT = {
  'ke-b77w': {
    id: 'ke-b77w', airline: '대한항공', airlineEn: 'KOREAN AIR', code: 'KE', maker: 'Boeing', family: 'boeing',
    type: 'B777-300ER', name: '보잉 777-300ER',
    model: 'models/ke-b77w.glb',
    dims: { length: 73.86, span: 64.80, height: 18.5, wingArea: 436.8 }, sweep: 31.6,
    mass: { oew: 167800, mtow: 351534, mlw: 251290, mzfw: 237680, maxFuel: 145500 },
    engine: { count: 2, name: 'GE90-115B', thrust: 513e3 },
    perf: { cruiseMach: 0.84, mmo: 0.89, vmo: 330, ceiling: 43100, seats: 291 },
    aero: { cd0: 0.0160, e: 0.80, mdd: 0.87, gearCd: 0.018, spoilerCd: 0.040, spoilerCl: -0.45 },
    flaps: B777_FLAPS, toFlap: 3, ldgFlap: 6,
    fbw: 'boeing', tailStrike: 8.4,
  },
  'oz-b772': {
    id: 'oz-b772', airline: '아시아나항공', airlineEn: 'ASIANA AIRLINES', code: 'OZ', maker: 'Boeing', family: 'boeing',
    type: 'B777-200ER', name: '보잉 777-200ER',
    model: 'models/oz-b772.glb',
    dims: { length: 63.73, span: 60.93, height: 18.5, wingArea: 427.8 }, sweep: 31.6,
    mass: { oew: 138100, mtow: 297550, mlw: 213180, mzfw: 195040, maxFuel: 137460 },
    engine: { count: 2, name: 'PW4090', thrust: 400e3 },
    perf: { cruiseMach: 0.84, mmo: 0.87, vmo: 330, ceiling: 43100, seats: 300 },
    aero: { cd0: 0.0160, e: 0.80, mdd: 0.86, gearCd: 0.018, spoilerCd: 0.040, spoilerCl: -0.45 },
    flaps: B777_FLAPS, toFlap: 3, ldgFlap: 6,
    fbw: 'boeing', tailStrike: 10.5,
  },
  'ke-a380': {
    id: 'ke-a380', airline: '대한항공', airlineEn: 'KOREAN AIR', code: 'KE', maker: 'Airbus', family: 'airbus',
    type: 'A380-800', name: '에어버스 A380-800',
    model: 'models/ke-a380.glb',
    dims: { length: 72.72, span: 79.75, height: 24.09, wingArea: 845 }, sweep: 33.5,
    mass: { oew: 277000, mtow: 569000, mlw: 391000, mzfw: 366000, maxFuel: 256000 },
    engine: { count: 4, name: 'GP7270', thrust: 332.4e3, revEff: 0.18 },
    perf: { cruiseMach: 0.85, mmo: 0.89, vmo: 340, ceiling: 43000, seats: 407 },
    aero: { cd0: 0.0135, e: 0.80, mdd: 0.88, gearCd: 0.016, spoilerCd: 0.035, spoilerCl: -0.40 },
    flaps: airbusFlaps([263, 222, 220, 196, 182]), toFlap: 3, ldgFlap: 5,
    fbw: 'airbus', tailStrike: 11.0,
  },
  'oz-a359': {
    id: 'oz-a359', airline: '아시아나항공', airlineEn: 'ASIANA AIRLINES', code: 'OZ', maker: 'Airbus', family: 'airbus',
    type: 'A350-900', name: '에어버스 A350-900',
    model: 'models/oz-a359.glb',
    dims: { length: 66.80, span: 64.75, height: 17.05, wingArea: 442 }, sweep: 31.9,
    mass: { oew: 142400, mtow: 280000, mlw: 207000, mzfw: 195700, maxFuel: 110500 },
    engine: { count: 2, name: 'Trent XWB-84', thrust: 374.5e3 },
    perf: { cruiseMach: 0.85, mmo: 0.89, vmo: 340, ceiling: 43100, seats: 311 },
    aero: { cd0: 0.0140, e: 0.83, mdd: 0.88, gearCd: 0.017, spoilerCd: 0.038, spoilerCl: -0.42 },
    flaps: airbusFlaps([255, 220, 212, 195, 186]), toFlap: 3, ldgFlap: 5,
    fbw: 'airbus', tailStrike: 12.0,
  },
};

export const AIRCRAFT_ORDER = ['ke-a380', 'ke-b77w', 'oz-a359', 'oz-b772'];

// 이륙 중량 산정: 운항자기중량 + 승객·수하물(1인 100kg, 탑승률) + 노선 연료(추정)
export function planWeights(ac, routeKm, loadFactor = 0.8) {
  const payload = Math.round(ac.perf.seats * loadFactor) * 100;
  // 노선 연료 = 이착륙 고정분 + 거리비례 (추정: 대형기 1km당 연료 소모를 이륙중량 비례로 근사)
  const burnPerKm = ac.mass.mtow * 0.000038;     // kg/km (777-300ER ≈ 13 kg/km)
  const trip = 2500 * (ac.engine.count / 2) + routeKm * burnPerKm;
  const reserve = 0.3 * trip + 45 * 60 * burnPerKm * 0.14; // 비상 연료 + 45분 체공
  let fuel = Math.min(ac.mass.maxFuel, Math.round((trip + reserve) / 100) * 100);
  fuel = Math.max(fuel, 12000);
  let tow = ac.mass.oew + payload + fuel;
  tow = Math.min(tow, ac.mass.mtow);
  return { payload, fuel, tow, trip: Math.round(trip) };
}
