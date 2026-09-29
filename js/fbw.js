// 비행제어컴퓨터 (조종간 → 각속도 명령)
// 공중: 조종간은 비행경로각·경사각 변화율 명령, 손을 떼면 현재 경로·경사 유지
//   에어버스: 경사 67°·피치 +30/-15°·받음각 보호 / 보잉: 경사 35° 넘으면 되돌림, 실속 가능(경고만)
// 착지 직전(전파고도 50ft 이하): 자세 유지 + 약한 기수 내림 → 조종사가 당겨서 플레어
// 지상: 속도에 비례한 기수 들기 권한, 손 떼면 기수가 천천히 내려옴

import { DEG, clamp } from './geo.js?v=202609291420';

const G0 = 9.80665;

export class FlightControl {
  constructor(fm) {
    this.fm = fm;
    this.reset();
  }

  reset() {
    const d = this.fm.d;
    this.gammaT = d.gamma;
    this.phiT = d.phi;
    this.iG = 0;
    this.flare = null;
    this.wasGround = this.fm.onGround;
    this.shaker = false;
  }

  // inp: {pitch, roll, yaw} -1..1 (pitch + = 당김/기수 들기, roll + = 오른쪽)
  // ap: 자동조종 출력 { gammaT, phiT, steer, groundPitchRate } (없으면 수동)
  update(dt, inp, ap) {
    const fm = this.fm, d = fm.d, ac = fm.ac;
    const airbus = ac.fbw === 'airbus';
    const out = { rates: [0, 0, 0], groundPitchRate: 0, steer: 0 };

    // ---------- 지상 ----------
    if (fm.onGround) {
      this.wasGround = true;
      out.steer = ap && ap.steer != null ? ap.steer : inp.yaw;
      if (ap && ap.groundPitchRate != null) {
        out.groundPitchRate = ap.groundPitchRate;
      } else {
        const ratio = (d.cas / fm.vs1g()) ** 2;           // 양력 여유 = (V/Vs)²
        const auth = clamp((ratio - 0.72) / 0.3, 0, 1);    // 기수 들기 권한
        if (inp.pitch > 0.05) out.groundPitchRate = inp.pitch * 3 * DEG * auth - (1 - auth) * DEG;
        else out.groundPitchRate = fm.noseDown ? 0 : -1.5 * DEG + Math.min(0, inp.pitch) * 2 * DEG;
      }
      this.gammaT = Math.max(d.gamma, 0);
      this.phiT = 0;
      this.iG = 0;
      this.flare = null;
      return out;
    }

    // 이륙 직후 초기화
    if (this.wasGround) {
      this.wasGround = false;
      this.gammaT = d.gamma;
      this.phiT = d.phi;
      this.iG = 0;
    }

    const V = Math.max(d.V, 30);
    const flapsOut = fm.flapPos > 0.5;
    const nzMax = flapsOut ? 2.0 : 2.5, nzMin = flapsOut ? 0 : -1;
    const aStall = d.aStall ?? 0.2;
    const aMax = airbus ? aStall - 1.5 * DEG : aStall + 4 * DEG;
    this.shaker = d.alpha > aStall - 1.5 * DEG;

    let gammaT, phiT, manualPitch = true;
    if (ap && ap.gammaT != null) {
      gammaT = ap.gammaT; phiT = ap.phiT; manualPitch = false;
      this.gammaT = d.gamma; this.phiT = d.phi; this.flare = null;
    } else {
      // 조종간 → 경로각 목표 적분
      const gRate = Math.min(4 * DEG, (G0 * (inp.pitch > 0 ? nzMax - 1 : 1 - nzMin)) / V);
      if (Math.abs(inp.pitch) > 0.03) this.gammaT += inp.pitch * gRate * dt;
      this.gammaT = clamp(this.gammaT, d.gamma - 6 * DEG, d.gamma + 6 * DEG);
      // 경사
      const rollRate = 15 * DEG;
      if (Math.abs(inp.roll) > 0.03) this.phiT += inp.roll * rollRate * dt;
      else {
        const hold = airbus ? 33 * DEG : 35 * DEG;
        const back = airbus ? 33 * DEG : 30 * DEG;
        if (Math.abs(this.phiT) > hold) this.phiT -= Math.sign(this.phiT) * Math.min(Math.abs(this.phiT) - back, 5 * DEG * dt);
      }
      this.phiT = clamp(this.phiT, -(airbus ? 67 : 80) * DEG, (airbus ? 67 : 80) * DEG);
      this.phiT = clamp(this.phiT, d.phi - 20 * DEG, d.phi + 20 * DEG);
      gammaT = this.gammaT; phiT = this.phiT;
    }

    // ---------- 세로: 필요 받음각 계산 ----------
    let qCmd;
    const flareH = 50 * 0.3048;
    if (manualPitch && d.ra < flareH && fm.gearPos > 0.9 && d.vs < 0.5) {
      // 플레어 모드: 자세 기억 후 서서히 기수 내림 → 당겨야 함
      if (!this.flare) this.flare = { theta: d.theta, t: 0 };
      this.flare.t += dt;
      if (d.ra < 30 * 0.3048) this.flare.theta -= (2 * DEG / 8) * dt;
      this.flare.theta += inp.pitch * 4 * DEG * dt;
      this.flare.theta = clamp(this.flare.theta, d.theta - 4 * DEG, d.theta + 4 * DEG);
      qCmd = 2.2 * (this.flare.theta - d.theta);
      this.gammaT = d.gamma;
    } else {
      if (!manualPitch || d.ra >= flareH) this.flare = null;
      const gErr = gammaT - d.gamma;
      this.iG = clamp(this.iG + gErr * dt, -0.15, 0.15);
      const gDot = clamp(1.2 * gErr + 0.25 * this.iG, -5 * DEG, 5 * DEG);
      const cphi = Math.max(0.3, Math.cos(d.phi));
      let nReq = (Math.cos(d.gamma) + (V * gDot) / G0) / cphi;
      nReq = clamp(nReq, nzMin, nzMax);
      const CLreq = (nReq * (d.weight || fm.mass * G0)) / (d.qbar * ac.dims.wingArea + 1);
      let aReq = fm.alphaForCL(CLreq);
      // 받음각 한계에 걸리면 경로각을 더 끌어올리지 않음 (에어버스 받음각 보호)
      const limited = aReq > aMax || d.alpha > aMax;
      aReq = Math.min(aReq, aMax);
      const gDotEff = limited ? Math.min(gDot, 0) : gDot;
      if (limited) this.gammaT = Math.min(this.gammaT, d.gamma);
      const qTurn = (G0 / V) * Math.sin(d.phi) * Math.tan(clamp(d.phi, -1.3, 1.3));
      qCmd = 1.6 * (aReq - d.alpha) + gDotEff * Math.cos(d.phi) + qTurn;
    }
    // 피치 자세 보호 (에어버스 +30/-15°, 보잉은 소프트 한계 +35/-25°)
    const thMax = (airbus ? 30 : 35) * DEG, thMin = (airbus ? -15 : -25) * DEG;
    if (d.theta > thMax - 3 * DEG) qCmd = Math.min(qCmd, 1.0 * (thMax - d.theta));
    if (d.theta < thMin + 3 * DEG) qCmd = Math.max(qCmd, 1.0 * (thMin - d.theta));
    qCmd = clamp(qCmd, -7 * DEG, 7 * DEG);

    // ---------- 가로 ----------
    const pCmd = clamp(1.6 * (phiT - d.phi), -15 * DEG, 15 * DEG);

    // ---------- 방향: 선회 협조 + 옆미끄럼 감쇠 + 방향타 ----------
    const rCmd = (G0 / V) * Math.sin(d.phi) * Math.cos(d.theta) + 1.2 * (d.beta || 0) + inp.yaw * 3 * DEG;

    out.rates = [pCmd, qCmd, rCmd];
    return out;
  }
}
