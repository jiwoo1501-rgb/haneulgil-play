// 공항·활주로
// 활주로 끝 좌표: OurAirports runways.csv (AIP 기반, 2026-09-29 조회) — OpenStreetMap 활주로 중심선과 대조해 수 m 이내 일치 확인
// elevFt: 활주로 끝 표고(ft, AIP). 게임에서는 지형에서 실제 높이를 다시 측정해 사용
// disp: 이설 시단 거리(m)

export const AIRPORTS = {
  RKSI: {
    icao: 'RKSI', iata: 'ICN', name: '인천국제공항', nameEn: 'Incheon', city: '인천',
    lat: 37.469101, lon: 126.450996, elevFt: 23,
    runways: [
      { id: '15L/33R', width: 60, ends: [
        { name: '15L', lat: 37.4838981628418, lon: 126.44000244140625, elevFt: 23 },
        { name: '33R', lat: 37.45640182495117, lon: 126.46499633789062, elevFt: 23 } ] },
      { id: '15R/33L', width: 60, ends: [
        { name: '15R', lat: 37.4818000793457, lon: 126.43599700927734, elevFt: 23 },
        { name: '33L', lat: 37.454200744628906, lon: 126.46099853515625, elevFt: 23 } ] },
      { id: '16L/34R', width: 60, ends: [
        { name: '16L', lat: 37.47274, lon: 126.415631, elevFt: 23 },
        { name: '34R', lat: 37.443432, lon: 126.441697, elevFt: 23 } ] },
      { id: '16R/34L', width: 60, ends: [
        { name: '16R', lat: 37.468746, lon: 126.413446, elevFt: 23 },
        { name: '34L', lat: 37.441272, lon: 126.437882, elevFt: 23 } ] },
    ],
  },
  RKSS: {
    icao: 'RKSS', iata: 'GMP', name: '김포국제공항', nameEn: 'Gimpo', city: '서울',
    lat: 37.5583, lon: 126.791, elevFt: 59,
    runways: [
      { id: '14L/32R', width: 45, ends: [
        { name: '14L', lat: 37.5703010559082, lon: 126.77799987792969, elevFt: 38 },
        { name: '32R', lat: 37.547401428222656, lon: 126.80699920654297, elevFt: 42 } ] },
      { id: '14R/32L', width: 60, ends: [
        { name: '14R', lat: 37.56800079345703, lon: 126.7760009765625, elevFt: 34 },
        { name: '32L', lat: 37.54759979248047, lon: 126.8010025024414, elevFt: 41 } ] },
    ],
  },
  RKPC: {
    icao: 'RKPC', iata: 'CJU', name: '제주국제공항', nameEn: 'Jeju', city: '제주',
    lat: 33.512058, lon: 126.492548, elevFt: 118,
    runways: [
      { id: '07/25', width: 45, ends: [
        { name: '07', lat: 33.50040054321289, lon: 126.46900177001953, elevFt: 86 },
        { name: '25', lat: 33.51449966430664, lon: 126.49700164794922, elevFt: 76 } ] },
      { id: '13/31', width: 45, ends: [
        { name: '13', lat: 33.515499114990234, lon: 126.48699951171875, elevFt: 67 },
        { name: '31', lat: 33.50550079345703, lon: 126.50399780273438, elevFt: 105, disp: 411 } ] },
    ],
  },
  RKPK: {
    icao: 'RKPK', iata: 'PUS', name: '김해국제공항', nameEn: 'Gimhae', city: '부산',
    lat: 35.179501, lon: 128.938004, elevFt: 6,
    runways: [
      { id: '18L/36R', width: 46, ends: [
        { name: '18L', lat: 35.19409942626953, lon: 128.93699645996094, elevFt: 8 },
        { name: '36R', lat: 35.169498443603516, lon: 128.9409942626953, elevFt: 8 } ] },
      { id: '18R/36L', width: 60, ends: [
        { name: '18R', lat: 35.19390106201172, lon: 128.93499755859375, elevFt: 12 },
        { name: '36L', lat: 35.165199279785156, lon: 128.93899536132812, elevFt: 12 } ] },
    ],
  },
};

// 한국 자북 편차: 약 9°W (추정, WMM2025 기준 서울 -9.0°, 제주 -7.9° 근처) → 자방위 = 진방위 + 9°
export const MAG_VAR_DEG = -9;

// 노선 (기본 순항고도 ft, 기본 도착 활주로)
export const ROUTES = [
  { id: 'ICN-CJU', from: 'RKSI', to: 'RKPC', depRwy: '33L', arrRwy: '07', cruiseFt: 33000, label: '인천 → 제주' },
  { id: 'ICN-PUS', from: 'RKSI', to: 'RKPK', depRwy: '33L', arrRwy: '36L', cruiseFt: 31000, label: '인천 → 부산(김해)' },
  { id: 'GMP-CJU', from: 'RKSS', to: 'RKPC', depRwy: '32R', arrRwy: '07', cruiseFt: 29000, label: '김포 → 제주' },
  { id: 'CJU-ICN', from: 'RKPC', to: 'RKSI', depRwy: '07', arrRwy: '33R', cruiseFt: 34000, label: '제주 → 인천' },
];

// 활주로 끝 이름으로 찾기 → { apt, rwy, end, opp }
export function findRunwayEnd(icao, endName) {
  const apt = AIRPORTS[icao];
  for (const rwy of apt.runways) {
    const i = rwy.ends.findIndex((e) => e.name === endName);
    if (i >= 0) return { apt, rwy, end: rwy.ends[i], opp: rwy.ends[1 - i] };
  }
  return null;
}
