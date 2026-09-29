// 자동조종·자동추력 (MCP 방식)
// 가로: HDG(방향) / NAV(경로점) / LOC(활주로 정렬) / RWY(이륙 활주·초기 상승) / ROLLOUT(착륙 활주)
// 세로: ALT / VS / FLCH(속도 유지 상승·강하) / PATH(자동 강하 경로) / GS(3° 활공) / FLARE / SRS(이륙) / ROLLOUT
// 추력: SPD / CLB / IDLE / RETARD / TOGA

import { DEG, KT, FT, FPM, NM, clamp, angDiff, distBrg } from './geo.js?v=202609291349';
import { casToTas, machToCas } from './atmosphere.js?v=202609291349';
import { rwyRel, rwyAngle, toTrue, toMag, GS_ANGLE, GPI } from './nav.js?v=202609291349';

const G0 = 9.80665;

export class Autopilot {
  constructor(fm) {
    this.fm = fm;
    this.ap = false;
    this.at = false;
    this.lat = 'HDG';
    this.vert = 'VS';
    this.thr = 'SPD';
    this.armLoc = false;
    this.armGs = false;
    this.mcp = { spd: 250, hdg: 0, alt: 10000, vs: 0, useMach: false, mach: 0.84 };
    this.wps = [];
    this.wpIdx = 0;
    this.dep = null;
    this.dest = null;
    this.vsCap = 10;
    this.pathVs = 0;
    this.vr = 150 * KT;
    this.v2 = 160 * KT;
    this.rotating = false;
    this.o = {};
    this.flareH = (fm.ac.family === 'airbus' ? 40 : 50) * FT;
    this.retardH = (fm.ac.family === 'airbus' ? 20 : 25) * FT;
  }

  // 이륙 속도 (현재 중량·플랩) — V2 = 1.13 Vs1g, VR = V2 - 7kt, V1 = VR - 4kt (추정 규칙)
  takeoffSpeeds() {
    const fm = this.fm;
    const vs = fm.vs1g(fm.flapIdx);
    const v2 = Math.max(1.13 * vs, 1.10 * vs + 5 * KT);
    const vr = Math.max(v2 - 7 * KT, 1.05 * vs);
    this.v2 = v2; this.vr = vr;
    return { v1: vr - 4 * KT, vr, v2 };
  }

  // 착륙 기준속도 VREF = 1.23 Vs1g(착륙 플랩), 접근속도 = VREF + 5kt
  vref(mass = this.fm.mass) {
    return 1.23 * this.fm.vs1g(this.fm.ac.ldgFlap, mass);
  }

  // 최소 조작 속도 (현재 플랩) ≈ 1.25 Vs1g + 5kt
  minManeuver(flap = this.fm.flapPos) {
    return 1.25 * this.fm.vs1g(Math.floor(flap + 0.01)) + 5 * KT;
  }

  targetCas() {
    const fm = this.fm, d = fm.d, ac = fm.ac;
    let v = this.mcp.useMach ? machToCas(this.mcp.mach, d.atm) : this.mcp.spd * KT;
    if (this.vert === 'SRS') v = this.v2 + 10 * KT;
    const F = ac.flaps[Math.ceil(fm.flapPos - 0.01)];
    const vfe = F.vfe ? F.vfe * KT - 4 * KT : Infinity;
    const vmo = Math.min(ac.perf.vmo * KT, machToCas(ac.perf.mmo - 0.02, d.atm)) - 4 * KT;
    const vls = 1.23 * fm.vs1g(Math.floor(fm.flapPos + 0.01));
    return clamp(v, Math.min(vls, vmo), Math.min(vfe, vmo));
  }

  engage(on) {
    const fm = this.fm, d = fm.d;
    if (on && !this.ap) {
      if (fm.onGround && this.vert !== 'SRS') return false;
      if (!fm.onGround && !['ALT', 'VS', 'FLCH', 'PATH', 'GS', 'SRS', 'FLARE'].includes(this.vert)) this.vert = 'VS';
      if (this.vert === 'VS' && !this.apWasOn) this.mcp.vs = Math.round(d.vs / FPM / 100) * 100;
      if (this.lat === 'HDG') this.mcp.hdg = Math.round(toMag(d.psi) / DEG) % 360;
    }
    this.ap = on;
    this.apWasOn = on;
    return true;
  }

  setVert(mode) {
    const d = this.fm.d;
    if (mode === 'VS') this.mcp.vs = Math.round(d.vs / FPM / 100) * 100;
    if (mode === 'ALT') { this.mcp.alt = Math.round(d.hMsl / FT / 100) * 100; this.vsCap = 5; }
    this.vert = mode;
    if (mode !== 'SRS') this.thr = mode === 'FLCH' ? (this.mcp.alt * FT > d.hMsl ? 'CLB' : 'IDLE') : 'SPD';
  }

  setRoute(wps) { this.wps = wps || []; this.wpIdx = 0; }

  // 남은 거리 (m): 현재 경로점까지 + 남은 구간 + 마지막 점→시단
  distToGo() {
    const d = this.fm.d;
    if (this.dest && (this.lat === 'LOC' || this.lat === 'ROLLOUT')) return Math.max(0, -rwyRel(this.dest, d.lat, d.lon).along);
    let dist = 0, lat = d.lat, lon = d.lon;
    for (let i = this.wpIdx; i < this.wps.length; i++) {
      dist += distBrg(lat, lon, this.wps[i].lat, this.wps[i].lon).dist;
      lat = this.wps[i].lat; lon = this.wps[i].lon;
    }
    if (this.dest) dist += distBrg(lat, lon, this.dest.lat, this.dest.lon).dist;
    return dist;
  }

  navBank(d) {
    if (this.wpIdx >= this.wps.length) {
      const trk = this.lastTrk ?? d.track;
      return clamp(1.8 * angDiff(trk, d.track), -25 * DEG, 25 * DEG);
    }
    const wp = this.wps[this.wpIdx];
    const { dist, brg } = distBrg(d.lat, d.lon, wp.lat, wp.lon);
    // 도착 경로점을 활주로 쪽으로 이미 지나쳤으면 다음으로
    const rr = this.dest && wp.along != null ? rwyRel(this.dest, d.lat, d.lon) : null;
    if (rr && rr.along > wp.along + 200 && rr.along < 0 && Math.abs(rr.cross) < 5 * NM && Math.abs(angDiff(d.track, this.dest.crs)) < 60 * DEG) {
      this.wpIdx++;
      return this.navBank(d);
    }
    const next = this.wps[this.wpIdx + 1];
    const R = d.gs ** 2 / (G0 * Math.tan(25 * DEG));
    if (next) {
      const nb = distBrg(wp.lat, wp.lon, next.lat, next.lon).brg;
      const turn = Math.abs(angDiff(nb, brg));
      const lead = Math.min(R * Math.tan(Math.min(turn, 150 * DEG) / 2), 6 * NM);
      if (dist < lead + 150) this.wpIdx++;
    } else if (dist < 300 || (dist < 3000 && Math.abs(angDiff(brg, d.track)) > 90 * DEG)) {
      this.lastTrk = brg;
      this.wpIdx++;
    }
    return clamp(1.8 * angDiff(brg, d.track), -25 * DEG, 25 * DEG);
  }

  update(dt) {
    const fm = this.fm, d = fm.d, ac = fm.ac;
    const o = { gammaT: null, phiT: null, steer: null, groundPitchRate: null, lever: null };
    const V = Math.max(d.V, 30);
    const tgtCas = this.targetCas();
    const tgtTas = casToTas(tgtCas, d.atm);
    this.tgtCas = tgtCas;

    // 수동 이륙 후 자동조종을 켠 경우: 이륙 모드에서 일반 상승 모드로 넘어감
    if (!fm.onGround && this.ap && !this.managed) {
      if (this.vert === 'SRS' && d.ra > 1500 * 0.3048) { this.mcp.spd = Math.max(this.mcp.spd, 250); this.setVert('FLCH'); }
      if (this.lat === 'RWY' && d.ra > 400 * 0.3048) { this.mcp.hdg = Math.round(toMag(d.psi) / DEG) % 360; this.lat = 'HDG'; }
    }

    // ================= 가로 =================
    let phiT = 0;
    if (this.armLoc && this.dest && this.lat !== 'LOC' && !fm.onGround) {
      const r = rwyRel(this.dest, d.lat, d.lon);
      const icpt = Math.abs(angDiff(d.track, this.dest.crs));
      const R = d.gs ** 2 / (G0 * Math.tan(25 * DEG));
      const lead = Math.min(3000, R * (1 - Math.cos(Math.min(icpt, Math.PI / 2))) + 250);
      if (r.along < -500 && Math.abs(r.cross) < lead && icpt < 100 * DEG) { this.lat = 'LOC'; this.armLoc = false; }
    }
    switch (this.lat) {
      case 'HDG': {
        const err = angDiff(toTrue(this.mcp.hdg * DEG), d.psi);
        phiT = clamp(1.8 * err, -25 * DEG, 25 * DEG);
        break;
      }
      case 'NAV': phiT = this.navBank(d); break;
      case 'LOC': {
        const r = rwyRel(this.dest, d.lat, d.lon);
        const Dref = Math.max(700, d.gs * 22);
        const want = -clamp(Math.atan(r.cross / Dref), -30 * DEG, 30 * DEG);
        const trkRel = rwyAngle(this.dest, fm.v);
        const lim = Math.abs(r.cross) > 300 ? 25 : 12;
        phiT = clamp(2.2 * (want - trkRel), -lim * DEG, lim * DEG);
        if (fm.onGround) { this.lat = 'ROLLOUT'; }
        break;
      }
      case 'RWY': {
        const r = rwyRel(this.dep, d.lat, d.lon);
        if (fm.onGround) o.steer = clamp(-0.015 * r.cross - 2.0 * angDiff(d.psi, this.dep.crs), -1, 1);
        else {
          const trk = this.dep.crs - clamp(Math.atan(r.cross / 1500), -10 * DEG, 10 * DEG);
          phiT = clamp(1.8 * angDiff(trk, d.track), -15 * DEG, 15 * DEG);
        }
        break;
      }
      case 'ROLLOUT': {
        const g = this.dest || this.dep;
        const r = rwyRel(g, d.lat, d.lon);
        o.steer = clamp(-0.02 * r.cross - 2.0 * angDiff(d.psi, g.crs), -1, 1);
        break;
      }
    }

    // ================= 세로 =================
    const h = d.hMsl, hT = this.mcp.alt * FT;
    let vsCmd = null, gammaT = null;
    if (this.armGs && this.dest && this.lat === 'LOC' && this.vert !== 'GS') {
      const r = rwyRel(this.dest, d.lat, d.lon);
      const gsH = (GPI - r.along) * Math.tan(GS_ANGLE);
      const hAbove = d.gearAlt - this.dest.h0;
      if (r.along < -1500 && hAbove >= gsH - 20 && hAbove <= gsH + 200) { this.vert = 'GS'; this.armGs = false; this.thr = 'SPD'; }
    }
    switch (this.vert) {
      case 'ALT': vsCmd = clamp(0.08 * (hT - h), -this.vsCap, this.vsCap); this.vsCap = Math.max(3, this.vsCap - 0.3 * dt); break;
      case 'VS': vsCmd = this.mcp.vs * FPM; break;
      case 'PATH': vsCmd = this.pathVs; break;
      case 'FLCH': {
        const climb = hT > h;
        const aD = clamp(0.06 * (tgtTas - d.V), -0.35, 0.35);
        gammaT = Math.asin(clamp((d.excess ?? 0) - aD / G0, -0.12, 0.2));
        gammaT = climb ? Math.max(gammaT, 0.5 * DEG) : Math.min(gammaT, -0.5 * DEG);
        this.thr = climb ? 'CLB' : 'IDLE';
        break;
      }
      case 'GS': {
        const r = rwyRel(this.dest, d.lat, d.lon);
        const gsH = (GPI - r.along) * Math.tan(GS_ANGLE);
        const hAbove = d.gearAlt - this.dest.h0;
        vsCmd = -d.gs * Math.tan(GS_ANGLE) + clamp(0.3 * (gsH - hAbove), -3, 3);
        if (d.ra < this.flareH && d.ra > 0.5) this.vert = 'FLARE';
        break;
      }
      case 'FLARE':
        vsCmd = -(0.9 + 0.2 * d.ra);
        if (fm.onGround) { this.vert = 'ROLLOUT'; this.lat = 'ROLLOUT'; }
        break;
      case 'SRS': {
        if (fm.onGround) {
          if (d.cas >= this.vr) this.rotating = true;
          const thT = Math.min(12.5 * DEG, fm.tailStrike - 1.5 * DEG);
          o.groundPitchRate = this.rotating ? (d.theta < thT ? 2.5 * DEG : 0) : 0;
        } else {
          const aD = clamp(0.05 * (tgtTas - d.V), -0.3, 0.3);
          gammaT = Math.asin(clamp((d.excess ?? 0) - aD / G0, 0.02, 0.25));
          if (d.theta > 18 * DEG) gammaT = Math.min(gammaT, d.gamma);
        }
        break;
      }
      case 'ROLLOUT':
        o.groundPitchRate = fm.noseDown ? 0 : -1.5 * DEG;
        break;
    }
    // 목표 고도 포착
    if (['VS', 'FLCH', 'PATH'].includes(this.vert) && !fm.onGround) {
      const err = hT - h;
      const vsNow = this.vert === 'VS' ? this.mcp.vs * FPM : d.vs;
      if ((Math.sign(err) === Math.sign(vsNow) && Math.abs(0.08 * err) <= Math.abs(vsNow) + 0.2) || Math.abs(err) < 8) {
        this.vert = 'ALT';
        this.vsCap = Math.max(3, Math.abs(vsNow));
        this.thr = 'SPD';
      }
    }
    if (gammaT == null && vsCmd != null) gammaT = Math.asin(clamp(vsCmd / V, -0.25, 0.25));
    if (fm.onGround) gammaT = null;

    // ================= 추력 =================
    if (this.vert === 'FLARE' && d.ra < this.retardH) this.thr = 'RETARD';
    if (this.at) {
      switch (this.thr) {
        case 'SPD': {
          const W = d.weight || fm.mass * G0;
          const Treq = (d.drag ?? 0) + W * Math.sin(d.gamma) + fm.mass * clamp(0.25 * (tgtTas - d.V), -1.2, 1.2);
          o.lever = clamp((Treq / Math.max(d.thrustAvail ?? 1, 1) - 0.04) / 0.96, 0, 0.95);
          break;
        }
        case 'CLB': o.lever = 0.93; break;
        case 'IDLE': case 'RETARD': o.lever = 0; break;
        case 'TOGA': o.lever = 1; break;
      }
    }

    o.gammaT = gammaT;
    o.phiT = fm.onGround ? null : phiT;
    this.o = o;
    return o;
  }
}
