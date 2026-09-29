// 자동 비행 관리 (이륙 → 상승 → 순항 → 강하 → 접근 → 자동착륙 → 정지)
// 켜져 있으면 자동조종 모드·목표값과 플랩·바퀴·스피드브레이크·역추력·자동브레이크를 알아서 조작
// 조종사가 자동조종을 끄면 관리도 멈춤 (다시 켜면 현재 단계부터 이어서)

import { DEG, KT, FT, FPM, NM, clamp } from './geo.js?v=202609291349';
import { machToCas } from './atmosphere.js?v=202609291349';
import { rwyRel, approachWaypoints, toMag, IF_HEIGHT, GS_ANGLE } from './nav.js?v=202609291349';

export const PHASE_KO = {
  PREFLIGHT: '출발 준비', TAKEOFF: '이륙', CLIMB: '상승', CRUISE: '순항', DESCENT: '강하',
  APPROACH: '접근', LANDING: '착륙', ROLLOUT: '착륙 활주', DONE: '도착',
};

export class AutoFlight {
  constructor(fm, ap, plan) {
    this.fm = fm;
    this.ap = ap;
    this.plan = plan;            // { dep, dest, cruiseFt }
    this.enabled = false;
    this.phase = fm.onGround ? 'PREFLIGHT' : 'CRUISE';
    this.cmd = {};
    this.msg = null;
  }

  destMsl() { return this.plan.dest.h0 - (this.plan.dest.geoidN || 0); }
  depMsl() { return this.plan.dep ? this.plan.dep.h0 - (this.plan.dep.geoidN || 0) : 0; }

  // 강하 계획 고도 (MSL m): IF 고도 + 남은거리(24NM 이후)×3° — 24NM부터는 수평 비행하며 감속·형상 준비
  profileH(dtg) {
    return this.destMsl() + IF_HEIGHT + Math.max(0, dtg - 24 * NM) * Math.tan(GS_ANGLE);
  }

  start() {
    const { fm, ap, plan } = this;
    this.enabled = true;
    ap.dest = plan.dest;
    ap.dep = plan.dep;
    if (plan.dest) ap.setRoute(approachWaypoints(plan.dest));
    if (fm.onGround && this.phase === 'PREFLIGHT') {
      this.phase = 'TAKEOFF';
      fm.flapIdx = fm.ac.toFlap;
      fm.flapPos = fm.ac.toFlap;   // 출발 준비 때 이미 내려 둔 것으로 처리
      ap.takeoffSpeeds();
      fm.autobrake = 4;          // RTO
      fm.parking = false;
      ap.mcp.alt = plan.cruiseFt;
      ap.mcp.spd = Math.round(ap.v2 / KT + 10);
      ap.lat = 'RWY'; ap.vert = 'SRS'; ap.thr = 'TOGA';
      ap.at = true; ap.ap = true; ap.rotating = false;
    } else if (!fm.onGround) {
      // 공중에서 켜면 현재 상황에 맞는 단계부터
      ap.at = true;
      const onApp = ap.lat === 'LOC' || ap.vert === 'GS';
      if (!onApp && plan.dest) ap.lat = 'NAV';
      ap.engage(true);
      const d = fm.d;
      if (onApp) this.phase = 'APPROACH';
      else if (plan.dest && ap.distToGo() < 40 * NM) this.phase = 'APPROACH';
      else if (plan.dest && d.hMsl > this.profileH(ap.distToGo()) - 300) { this.phase = 'DESCENT'; ap.vert = 'PATH'; ap.thr = 'SPD'; }
      else if (d.hMsl > plan.cruiseFt * FT - 300) { this.phase = 'CRUISE'; ap.mcp.alt = plan.cruiseFt; ap.setVert('ALT'); }
      else { this.phase = 'CLIMB'; ap.mcp.alt = plan.cruiseFt; ap.setVert('FLCH'); }
      if (this.phase === 'APPROACH' || this.phase === 'DESCENT') ap.mcp.alt = Math.round((this.destMsl() + IF_HEIGHT) / FT / 100) * 100;
    }
  }

  stop() { this.enabled = false; }

  update(dt) {
    const { fm, ap, plan } = this;
    const d = fm.d, ac = fm.ac;
    this.cmd = {};
    ap.managed = this.enabled;
    if (!this.enabled) return this.cmd;
    if (!ap.ap && this.phase !== 'ROLLOUT' && this.phase !== 'DONE') { this.enabled = false; return this.cmd; }
    const c = this.cmd;
    const hAgl = d.hMsl - this.depMsl();
    const flap = fm.flapIdx;

    switch (this.phase) {
      case 'TAKEOFF': {
        if (!fm.onGround && d.vs > 1.5 && d.ra > 10) c.gearDown = false;
        if (!fm.onGround && d.ra > 400 * FT && ap.lat === 'RWY') ap.lat = plan.dest ? 'NAV' : 'HDG';
        if (!fm.onGround && hAgl > 1500 * FT) {
          ap.setVert('FLCH');
          ap.thr = 'CLB';
          fm.autobrake = 0;
          this.phase = 'CLIMB';
        }
        break;
      }
      case 'CLIMB': {
        // 플랩 정리: 다음 단계 최소조작속도 이상이면 한 단씩
        if (flap > 0 && d.cas > ap.minManeuver(flap - 1)) c.flapIdx = flap - 1;
        const vClean = ap.minManeuver(0) / KT + 5;
        if (d.hMsl < 10000 * FT) { ap.mcp.useMach = false; ap.mcp.spd = Math.max(250, Math.round(vClean)); }
        else {
          const m = ac.perf.cruiseMach;
          if (machToCas(m, d.atm) < 300 * KT) { ap.mcp.useMach = true; ap.mcp.mach = m; }
          else { ap.mcp.useMach = false; ap.mcp.spd = Math.max(300, Math.round(vClean)); }
        }
        if (ap.vert === 'ALT' && Math.abs(d.hMsl - plan.cruiseFt * FT) < 60) this.phase = 'CRUISE';
        if (plan.dest && ap.distToGo() < 60 * NM) this.phase = 'CRUISE';
        break;
      }
      case 'CRUISE': {
        if (flap > 0 && d.cas > ap.minManeuver(flap - 1)) c.flapIdx = flap - 1;
        const dtg = ap.distToGo();
        if (d.hMsl > 10000 * FT) { ap.mcp.useMach = true; ap.mcp.mach = ac.perf.cruiseMach; }
        if (plan.dest && d.hMsl > this.profileH(dtg) + 30) {
          this.phase = 'DESCENT';
          ap.mcp.alt = Math.round((this.destMsl() + IF_HEIGHT) / FT / 100) * 100;
          ap.vert = 'PATH'; ap.thr = 'SPD';
        }
        break;
      }
      case 'DESCENT':
      case 'APPROACH': {
        const dtg = ap.distToGo();
        const r = rwyRel(plan.dest, d.lat, d.lon);
        // 형상 목표: 플랩 단계
        const want =
          ap.vert === 'GS' && r.along > -5.5 * NM ? ac.ldgFlap :
          ap.vert === 'GS' ? ac.ldgFlap - 1 :
          ap.lat === 'LOC' ? Math.min(ac.toFlap - 1, ac.ldgFlap) :
          dtg < 24 * NM ? 1 : 0;
        const next = ac.flaps[flap + 1];
        // 속도 계획 (거리별) → 다음 플랩 제한속도 아래로 → 현재 형상 최소조작속도 이상
        let spd;
        if (d.hMsl > 10500 * FT) spd = 290;
        else if (dtg > 32 * NM) spd = 250;
        else if (dtg > 24 * NM) spd = 220;
        else spd = 200;
        const vapp = ap.vref() / KT + 5;
        if (flap < want && next) spd = Math.min(spd, next.vfe - 15);
        if (ac.flaps[flap].vfe) spd = Math.min(spd, ac.flaps[flap].vfe - 10);
        spd = Math.max(spd, ap.minManeuver(flap) / KT);
        if (flap >= ac.ldgFlap) spd = vapp;
        ap.mcp.spd = Math.round(spd);
        ap.mcp.useMach = d.hMsl > 26000 * FT && machToCas(ac.perf.cruiseMach - 0.02, d.atm) < spd * KT;
        ap.mcp.mach = ac.perf.cruiseMach - 0.02;
        // 강하 경로: 3° 기준 + 편차 보정
        if (ap.vert === 'PATH') {
          const err = this.profileH(dtg) - d.hMsl;
          let vs = -d.gs * Math.tan(GS_ANGLE) + 0.05 * err;
          if (d.cas / KT > ap.mcp.spd + 8 && err > -1500 * FT) vs *= 0.3;   // 너무 빠르면 완만히 내려가며 감속
          ap.pathVs = clamp(vs, -4000 * FPM, 0);
        }
        // 속도가 남으면 스피드브레이크
        const over = d.cas / KT - ap.mcp.spd;
        c.speedbrake = ap.vert !== 'GS' && fm.lever < 0.05 && over > 8 ? (over > 20 ? 1 : 0.6) : over > 3 && fm.sbLever > 0 ? fm.sbLever : 0;
        // 접근 준비
        if (dtg < 40 * NM) { ap.armLoc = ap.lat !== 'LOC'; ap.armGs = ap.vert !== 'GS'; fm.autobrake = 2; this.phase = 'APPROACH'; }
        // 형상: 플랩 (VFE 이하일 때 한 단씩)
        if (flap < want && next && d.cas < next.vfe * KT - 10 * KT && ap.mcp.spd <= next.vfe - 12) c.flapIdx = flap + 1;
        if ((ap.vert === 'GS' && r.along > -9 * NM) || d.ra < 2000 * FT) c.gearDown = true;
        if (ap.vert === 'FLARE' || fm.onGround) this.phase = 'LANDING';
        break;
      }
      case 'LANDING': {
        if (fm.onGround) {
          this.phase = 'ROLLOUT';
          ap.lat = 'ROLLOUT'; ap.vert = 'ROLLOUT'; ap.thr = 'IDLE';
        }
        break;
      }
      case 'ROLLOUT': {
        c.speedbrake = 0;
        c.reverse = d.gs > 70 * KT;
        c.lever = d.gs > 70 * KT ? 0.75 : 0;
        if (d.gs < 30 * KT) { fm.abActive = false; c.brake = d.gs > 1 ? 0.35 : 1; }
        if (d.gs < 0.5) {
          this.phase = 'DONE';
          c.parking = true;
          ap.ap = false; ap.at = false;
          this.msg = '도착 — 정지 완료';
        }
        break;
      }
      case 'DONE':
        c.parking = true;
        break;
    }
    return c;
  }
}
