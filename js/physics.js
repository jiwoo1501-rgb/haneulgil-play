// 비행 물리 (화면·Cesium과 독립 — Node 테스트 가능)
// 위치·속도: ECEF, 자세: 쿼터니언(몸체→ECEF), 몸체축: x 앞 / y 오른쪽 / z 아래
// 병진운동: 양력·항력·측력·추력·중력·지면반력을 모두 계산해 적분(물리)
// 회전운동: 비행제어컴퓨터(fbw.js)가 요구한 각속도를 1차 지연으로 따라감

import { v3, quat, enu, ecefToGeodetic, geodeticToEcef, attitudeToQuat, quatToAttitude, DEG, KT, clamp } from './geo.js?v=202609291314';
import { isa, tasToCas, RHO0 } from './atmosphere.js?v=202609291314';

const G0 = 9.80665;
const LB_PER_LBFH = 2.8325e-5; // 1 lb/(lbf·h) = kg/(N·s)

// glTF(X 왼쪽, Y 위, Z 앞) → 몸체(x 앞, y 오른쪽, z 아래)
export const gltfToBody = (p) => [p[2], -p[0], -p[1]];

// 모델 정보가 없을 때(Node 테스트) 치수로 추정한 바퀴 위치 (glTF 좌표)
export function defaultMeta(ac) {
  const L = ac.dims.length;
  const gh = ac.id === 'ke-a380' ? 7.6 : 5.9;       // 동체 중심의 지상고 (추정)
  const wb = { 'ke-a380': 30.4, 'ke-b77w': 31.2, 'oz-a359': 28.7, 'oz-b772': 25.9 }[ac.id] || L * 0.42;
  const xm = -2.2;
  return {
    gear: {
      nose: { contact: [0, -gh + 0.15, xm + wb] },
      mains: [{ node: 'gear_main_L', contact: [5.5, -gh, xm] }, { node: 'gear_main_R', contact: [-5.5, -gh, xm] }],
    },
    tailStrikeDeg: ac.tailStrike,
    bankStrikeDeg: ac.engine.count === 4 ? 6 : 9,
    pilotEye: [0.55, 1.2, L * 0.47],
  };
}

// DATCOM 양력경사 (1/rad): 가로세로비 A, 1/2시위 후퇴각 L, 마하 M
function liftSlope(A, sweepHalf, M) {
  const b2 = Math.max(0.2, 1 - Math.min(M, 0.86) ** 2);
  const t = Math.tan(sweepHalf);
  return (2 * Math.PI * A) / (2 + Math.sqrt(4 + (A * A * b2 / 0.9025) * (1 + (t * t) / b2)));
}

// 엔진 추력 감소율 (추정: 해면 정지 1.0, 이륙 M0.24 ≈ 0.82, FL350·M0.84 ≈ 0.21에 맞춘 근사식)
export function thrustLapse(M, sigma) {
  return (1 - 0.861 * M + 0.462 * M * M) * Math.pow(sigma, 0.9);
}

export class FlightModel {
  constructor(ac, meta, env) {
    this.ac = ac;
    this.env = env;
    const m = meta || defaultMeta(ac);
    this.meta = m;
    this.noseC = gltfToBody(m.gear.nose.contact);
    this.mainC = m.gear.mains.map((g) => gltfToBody(g.contact));
    const n = this.mainC.length;
    this.mainAvg = this.mainC.reduce((a, c) => v3.add(a, v3.scale(c, 1 / n)), [0, 0, 0]);
    this.wheelbase = this.noseC[0] - this.mainAvg[0];
    this.thetaGround = Math.atan2(this.noseC[2] - this.mainAvg[2], this.wheelbase);
    this.tailStrike = (m.tailStrikeDeg ?? ac.tailStrike) * DEG;
    // 경사 착지 한계: 엔진 아래·날개 끝이 지면에 닿는 경사각 (모델 기하에서 계산, 여유 2°·최소 6°)
    let bs = m.bankStrikeDeg ?? 8;
    if (m.enginePods || m.wingtips) {
      const gy = m.gear.mains[0].contact[1];
      const pts = [...(m.enginePods || []).map((e) => e.lowestPoint), ...Object.values(m.wingtips || {})];
      const angs = pts.filter(Boolean).map((p) => Math.atan2(p[1] - gy, Math.abs(p[0])) / DEG);
      if (angs.length) bs = Math.max(6, Math.min(...angs) + 2);
    }
    this.bankStrike = bs * DEG;
    this.AR = ac.dims.span ** 2 / ac.dims.wingArea;
    this.sweepHalf = ((ac.sweep ?? 31.6) - 3) * DEG;
    this.events = [];
  }

  // 초기화: 지상(활주로 위) 또는 공중
  reset(o) {
    const ac = this.ac;
    this.time = 0;
    this.fuel = o.fuel ?? ac.mass.maxFuel * 0.3;
    this.payload = o.payload ?? 30000;
    this.mass = ac.mass.oew + this.payload + this.fuel;
    this.flapIdx = o.flapIdx ?? 0;
    this.flapPos = this.flapIdx;
    this.gearDown = o.gearDown ?? true;
    this.gearPos = this.gearDown ? 1 : 0;
    this.sbLever = 0; this.spoiler = 0; this.groundSpoilerArmed = true;
    this.brake = 0; this.parking = !!o.parking; this.autobrake = o.autobrake ?? 0; this.abActive = false;
    this.rev = 0; this.revCmd = false;
    this.lever = o.lever ?? 0;
    this.crashed = null; this.tailStruck = false;
    this.events = [];
    this.w = [0, 0, 0];
    this.wind = [0, 0, 0];
    this.touchdown = null;

    const lat = o.lat, lon = o.lon, psi = o.hdg;
    if (o.onGround) {
      const g = this.env.groundHeight(lat, lon) ?? 0;
      const th = this.thetaGround;
      const hAGL = this.mainAvg[2] * Math.cos(th) - this.mainAvg[0] * Math.sin(th);
      this.p = geodeticToEcef(lat, lon, g + hAGL + 0.02);
      this.q = attitudeToQuat(lat, lon, psi, th, 0);
      const { e, n } = enu(lat, lon);
      const fwd = v3.add(v3.scale(n, Math.cos(psi)), v3.scale(e, Math.sin(psi)));
      this.v = v3.scale(fwd, o.speed ?? 0);
      this.onGround = true; this.noseDown = true;
      this.spool = 0.04;
    } else {
      this.p = geodeticToEcef(lat, lon, o.alt);
      const gamma = o.gamma ?? 0;
      const { e, n, u } = enu(lat, lon);
      const hor = v3.add(v3.scale(n, Math.cos(psi)), v3.scale(e, Math.sin(psi)));
      const dir = v3.add(v3.scale(hor, Math.cos(gamma)), v3.scale(u, Math.sin(gamma)));
      this.v = v3.scale(dir, o.speed);
      // 트림 받음각으로 자세 설정
      this.onGround = false; this.noseDown = false;
      this.q = attitudeToQuat(lat, lon, psi, gamma, 0);
      this.derive();
      const a = this.alphaForCL(this.mass * G0 * Math.cos(gamma) / (this.d.qbar * ac.dims.wingArea));
      this.q = attitudeToQuat(lat, lon, psi, gamma + a, 0);
      this.spool = o.spool ?? 0.3;
    }
    this.derive();
    this.spool = o.spool ?? this.spool;
    return this;
  }

  // ---------- 공력 ----------
  cfg() {
    const F = this.ac.flaps;
    const i = Math.min(Math.floor(this.flapPos), F.length - 2), t = this.flapPos - i;
    const a = F[i], b = F[i + 1];
    const L = (k) => a[k] + (b[k] - a[k]) * t;
    return { clmax: L('clmax'), a0: L('a0') * DEG, dcd0: L('dcd0') };
  }

  clmaxNow(M) {
    const c = this.cfg();
    // 플랩 없는 상태에서는 마하수가 높을수록 버핏 한계 양력계수 감소 (추정)
    const clean = Math.max(0, 1 - this.flapPos);
    return c.clmax - clean * 0.45 * clamp((M - 0.3) / 0.55, 0, 1);
  }

  cla(M) { return liftSlope(this.AR, this.sweepHalf, M); }

  alphaForCL(CL) {
    const M = this.d ? this.d.mach : 0.3;
    return this.cfg().a0 + CL / this.cla(M);
  }

  // 1g 실속속도 (CAS, m/s) — 현재 중량, 지정 플랩
  vs1g(flapIdx = this.flapPos, mass = this.mass) {
    const F = this.ac.flaps[Math.round(flapIdx)];
    return Math.sqrt((2 * mass * G0) / (RHO0 * this.ac.dims.wingArea * F.clmax));
  }

  aero(alpha, beta, M, hGround) {
    const ac = this.ac, c = this.cfg();
    const cla = this.cla(M);
    const clmax = this.clmaxNow(M);
    const aStall = c.a0 + clmax / cla;
    let CL;
    if (alpha <= aStall) {
      CL = cla * (alpha - c.a0);
      const aNeg = c.a0 - 0.9 * clmax / cla;
      if (alpha < aNeg) CL = -0.9 * clmax * (1 - 0.3 * clamp((aNeg - alpha) / (6 * DEG), 0, 1));
    } else {
      CL = clmax * (1 - 0.35 * clamp((alpha - aStall) / (6 * DEG), 0, 1));
    }
    CL += ac.aero.spoilerCl * this.spoiler * clamp(CL / 1.0, 0, 1.5);
    // 지면효과 (날개폭 기준 높이)
    const x = (16 * Math.max(hGround, 0.5)) / ac.dims.span;
    const ge = hGround < ac.dims.span ? (x * x) / (1 + x * x) : 1;
    const mcrit = ac.aero.mdd - 0.1 - 0.1 * Math.max(0, CL - 0.5);
    const wave = M > mcrit ? 20 * (M - mcrit) ** 4 : 0;
    const post = Math.max(0, alpha - aStall);
    const CD = ac.aero.cd0 + c.dcd0 + ac.aero.gearCd * this.gearPos + ac.aero.spoilerCd * this.spoiler
      + (CL * CL) / (Math.PI * ac.aero.e * this.AR) * ge + wave + 0.6 * beta * beta + 1.2 * post;
    const CY = -0.9 * beta;
    return { CL, CD, CY, aStall, clmax };
  }

  // ---------- 1 스텝 ----------
  // cmd: { rates:[p,q,r] (rad/s), groundPitchRate, steer(-1..1), lever(0..1), reverse, brake(0..1),
  //        flapIdx, gearDown, speedbrake(0..1) }
  step(dt, cmd) {
    if (this.crashed) return;
    const ac = this.ac;
    this.time += dt;

    // --- 작동기 ---
    if (cmd.flapIdx != null) this.flapIdx = clamp(cmd.flapIdx, 0, ac.flaps.length - 1);
    this.flapPos += clamp(this.flapIdx - this.flapPos, -dt / 6, dt / 6);         // 1단 6초
    if (cmd.gearDown != null) this.gearDown = cmd.gearDown;
    if (this.onGround) this.gearDown = true;
    this.gearPos = clamp(this.gearPos + (this.gearDown ? 1 : -1) * dt / 9, 0, 1); // 9초
    if (cmd.speedbrake != null) this.sbLever = clamp(cmd.speedbrake, 0, 1);
    if (cmd.lever != null) this.lever = clamp(cmd.lever, 0, 1);
    this.revCmd = !!cmd.reverse && this.onGround;
    this.rev = clamp(this.rev + (this.revCmd ? 1 : -1) * dt / 2, 0, 1);
    if (cmd.parking != null) this.parking = cmd.parking;

    // 지상 스포일러: 접지 후 추력 아이들이면 자동 전개
    let spTarget = this.sbLever * (this.onGround ? 1 : 0.6);
    if (this.onGround && this.groundSpoilerArmed && this.lever < 0.08 && this.d.gs > 30 * KT) spTarget = 1;
    this.spoiler += clamp(spTarget - this.spoiler, -dt / 1.5, dt / 1.5);

    // 엔진 (스풀 지연: 저출력에서 느림)
    const idle = 0.04;
    const target = idle + (1 - idle) * this.lever;
    const tau = this.spool < 0.35 ? 2.2 : 1.1;
    this.spool += (target - this.spool) * Math.min(1, dt / tau);

    // --- 상태 ---
    const d = this.d;
    const { lat, lon } = d;
    const { e, n, u } = enu(lat, lon);
    const atm = d.atm;
    const [bx, by, bz] = quat.toCols(this.q);
    const vAir = v3.sub(this.v, this.wind);
    const V = Math.max(v3.len(vAir), 0.1);
    const M = V / atm.a;
    const ub = v3.dot(vAir, bx), vb = v3.dot(vAir, by), wb = v3.dot(vAir, bz);
    const alpha = V > 1 ? Math.atan2(wb, Math.max(ub, 0.1)) : 0;
    const beta = V > 1 ? Math.asin(clamp(vb / V, -1, 1)) : 0;
    const qbar = 0.5 * atm.rho * V * V;
    const S = ac.dims.wingArea;
    const A = this.aero(alpha, beta, M, d.hAGL);

    const vhat = v3.scale(vAir, 1 / V);
    const up = v3.scale(bz, -1);
    let liftDir = v3.sub(up, v3.scale(vhat, v3.dot(up, vhat)));
    liftDir = v3.norm(liftDir);
    const L = qbar * S * A.CL, D = qbar * S * A.CD, Y = qbar * S * A.CY;

    // 추력
    const Tavail = ac.engine.count * ac.engine.thrust * thrustLapse(M, atm.sigma);
    const Tfwd = this.spool * Tavail;
    const T = Tfwd * (1 - this.rev) - (ac.engine.revEff ?? 0.35) * Tfwd * this.rev;

    const gLocal = G0 * (6371000 / (6371000 + d.h)) ** 2;
    const W = this.mass * gLocal;

    let F = v3.scale(liftDir, L);
    F = v3.madd(F, vhat, -D);
    F = v3.madd(F, by, Y);
    F = v3.madd(F, bx, T);
    F = v3.madd(F, u, -W);

    // --- 지면 반력·마찰·브레이크 ---
    let brakeOut = 0;
    if (this.onGround) {
      const N = Math.max(0, -v3.dot(F, u));
      const vg = v3.sub(this.v, v3.scale(u, v3.dot(this.v, u)));
      let fwdG = v3.sub(bx, v3.scale(u, v3.dot(bx, u)));
      fwdG = v3.norm(fwdG);
      const rightG = v3.cross(fwdG, u);
      const vF = v3.dot(vg, fwdG), vS = v3.dot(vg, rightG);

      // 자동 브레이크 (목표 감속도 m/s²: LO 1.7 / MED 3.0 / MAX 최대)
      let brake = clamp(cmd.brake ?? 0, 0, 1);
      if (brake > 0.5) this.abActive = false;
      if (this.abActive && vF > 1) {
        const decel = [0, 1.7, 3.0, 99, 99][this.autobrake];
        const other = -v3.dot(F, fwdG);                   // 브레이크 외 감속력
        const need = this.mass * decel - other;
        brake = Math.max(brake, clamp(need / (0.45 * N + 1), 0, 1));
      }
      if (this.parking) brake = 1;
      brakeOut = brake;

      const muR = 0.015, muB = 0.45;
      const sgn = vF >= 0 ? 1 : -1;
      let fLong = -sgn * (muR + muB * brake) * N;
      // 정지 상태에서 브레이크가 추력보다 크면 정지 유지
      const push = v3.dot(F, fwdG);
      if (Math.abs(vF) < 0.3 && Math.abs(push) <= (muR + muB * brake) * N) {
        fLong = -push;
        this.v = v3.sub(this.v, v3.scale(fwdG, vF));
      }
      const fSide = clamp((-vS * this.mass) / 0.12, -0.7 * N, 0.7 * N);
      F = v3.madd(F, fwdG, fLong);
      F = v3.madd(F, rightG, fSide);
      F = v3.madd(F, u, N);
      this.normalForce = N;
    } else {
      this.normalForce = 0;
    }
    this.brakeOut = brakeOut;

    // --- 병진 적분 ---
    const acc = v3.scale(F, 1 / this.mass);
    this.v = v3.madd(this.v, acc, dt);
    this.p = v3.madd(this.p, this.v, dt);
    this.accel = acc;

    // --- 회전 ---
    const r = cmd.rates || [0, 0, 0];
    const lag = [0.22, 0.3, 0.4];
    if (!this.onGround) {
      for (let k = 0; k < 3; k++) this.w[k] += (r[k] - this.w[k]) * Math.min(1, dt / lag[k]);
      this.q = quat.integrate(this.q, this.w, dt);
    } else {
      const g2 = ecefToGeodetic(this.p);
      let { psi, theta, phi } = quatToAttitude(this.q, g2.lat, g2.lon);
      const vF = v3.dot(this.v, bx);
      // 앞바퀴 조향: 저속 60°, 30kt 이상 8°, 고속 3° + 방향타 공력
      const vkt = Math.abs(vF) / KT;
      const maxSteer = (vkt < 8 ? 60 : vkt < 30 ? 60 - (vkt - 8) * (52 / 22) : Math.max(3, 8 - (vkt - 30) * 0.07)) * DEG;
      const steer = clamp(cmd.steer ?? 0, -1, 1);
      let yawRate = this.noseDown ? (vF * Math.tan(steer * maxSteer)) / this.wheelbase : 0;
      yawRate += steer * clamp(qbar / 8000, 0, 1) * 2.5 * DEG;   // 방향타
      psi += yawRate * dt;
      // 피치: 기수 들기/내리기 (주 바퀴 축 회전은 접지 처리에서 반영)
      const qg = cmd.groundPitchRate ?? 0;
      theta += qg * dt;
      if (theta <= this.thetaGround) { theta = this.thetaGround; this.noseDown = true; }
      else if (theta > this.thetaGround + 0.3 * DEG) this.noseDown = false;
      theta = Math.min(theta, this.tailStrike + 1.5 * DEG);
      phi -= phi * Math.min(1, dt * 3);
      this.q = attitudeToQuat(g2.lat, g2.lon, psi, theta, phi);
      this.w = [0, qg, yawRate];
    }

    // --- 접지 판정 ---
    this.derive();
    this.contacts();
    const dd = this.d;
    if (!this.onGround && this.hMain <= 0) {
      this.onTouchdown();
    } else if (this.onGround) {
      const vs = v3.dot(this.v, dd.u);
      if (this.hMain > 0.08 && vs > 0) {
        this.onGround = false; this.noseDown = false;
        this.w = [0, this.w[1], 0];
        this.events.push({ type: 'liftoff', t: this.time, cas: dd.cas });
        this.abActive = false;
        if (this.autobrake === 4) this.autobrake = 0;   // 이륙 후 RTO 해제
      }
    }
    if (this.onGround) {
      const vs = v3.dot(this.v, dd.u);
      if (this.normalForce > 0) {
        // 바퀴에 하중이 실려 있으면 지면에 붙임 (지구 곡률로 뜨는 것 방지)
        this.p = v3.madd(this.p, dd.u, -this.hMain);
        this.v = v3.madd(this.v, dd.u, -vs);
      } else {
        if (this.hMain < 0) this.p = v3.madd(this.p, dd.u, -this.hMain);
        if (vs < 0) this.v = v3.madd(this.v, dd.u, -vs);
      }
      if (dd.theta > this.tailStrike && !this.tailStruck) {
        this.tailStruck = true;
        this.events.push({ type: 'tailstrike', t: this.time });
      }
      this.derive();
      this.contacts();
    }

    // --- 연료 ---
    const tsfc = (0.30 + 0.30 * M) * LB_PER_LBFH;
    this.fuelFlow = tsfc * Tfwd;
    this.fuel = Math.max(0, this.fuel - this.fuelFlow * dt);
    this.mass = ac.mass.oew + this.payload + this.fuel;

    // 파생값 보관
    Object.assign(this.d, {
      alpha, beta, CL: A.CL, CD: A.CD, lift: L, drag: D, thrust: T, thrustAvail: Tavail,
      aStall: A.aStall, clmax: A.clmax, weight: W, excess: (Tfwd - D) / W,
      nz: L / W, brake: brakeOut,
    });
  }

  onTouchdown() {
    const d = this.d;
    const sink = -v3.dot(this.v, d.u);
    const gearOk = this.gearPos > 0.95;
    const surface = this.env.surface ? this.env.surface(d.lat, d.lon) : 'runway';
    const td = {
      type: 'touchdown', t: this.time, sink, fpm: sink / 0.00508, cas: d.cas, gs: d.gs,
      theta: d.theta, phi: d.phi, lat: d.lat, lon: d.lon, surface, noseFirst: this.hNose < this.hMain - 0.05,
    };
    this.touchdown = td;
    this.events.push(td);
    this.onGround = true;
    this.noseDown = false;
    if (this.autobrake > 0 && this.autobrake < 4) this.abActive = true;
    let crash = null;
    const nearApt = this.env.nearAirport ? this.env.nearAirport(d.lat, d.lon) : true;
    if (surface !== 'runway' && !nearApt) crash = '지면·바다와 충돌 (침하율 ' + Math.round(td.fpm) + ' ft/min)';
    else if (!gearOk) crash = '바퀴를 내리지 않고 착지';
    else if (sink > 7.0) crash = '너무 강한 착지 (침하율 ' + Math.round(td.fpm) + ' ft/min)';
    else if (Math.abs(d.phi) > this.bankStrike && sink > 1) crash = '엔진·날개가 활주로에 닿음 (경사 ' + (Math.abs(d.phi) / DEG).toFixed(1) + '°)';
    else if (surface !== 'runway' && (sink > 2.5 || d.gs > 50 * KT)) crash = '활주로 밖에 착지';
    if (crash) this.crash(crash);
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = { reason, t: this.time };
    this.events.push({ type: 'crash', reason, t: this.time });
    this.v = [0, 0, 0];
  }

  // 바퀴 높이 (지면 기준, m)
  contacts() {
    const d = this.d;
    const [bx, by, bz] = quat.toCols(this.q);
    const hOf = (c) => d.hAGL + v3.dot(v3.add(v3.add(v3.scale(bx, c[0]), v3.scale(by, c[1])), v3.scale(bz, c[2])), d.u);
    this.hMain = Math.min(...this.mainC.map(hOf));
    this.hNose = hOf(this.noseC);
    d.gearAlt = d.h - d.hAGL + hOf(this.mainAvg);  // 주 바퀴의 타원체 높이
    d.ra = Math.max(0, Math.min(this.hMain, this.hNose));
  }

  derive() {
    const g = ecefToGeodetic(this.p);
    const { e, n, u } = enu(g.lat, g.lon);
    const N = this.env.geoidN ? this.env.geoidN(g.lat, g.lon) : 0;
    const hMsl = g.h - N;
    const atm = isa(hMsl);
    const ground = this.env.groundHeight(g.lat, g.lon);
    this.groundH = ground ?? this.groundH ?? -1e4;
    const vAir = v3.sub(this.v, this.wind || [0, 0, 0]);
    const V = v3.len(vAir);
    const vs = v3.dot(this.v, u);
    const vN = v3.dot(this.v, n), vE = v3.dot(this.v, e);
    const gs = Math.hypot(vN, vE);
    const att = quatToAttitude(this.q, g.lat, g.lon);
    const [bx, by, bz] = quat.toCols(this.q);
    const ub = v3.dot(vAir, bx), vb = v3.dot(vAir, by), wb = v3.dot(vAir, bz);
    const prev = this.d || {};
    this.d = {
      ...prev,
      lat: g.lat, lon: g.lon, h: g.h, hMsl, u, e, n, atm,
      hAGL: g.h - this.groundH,
      V, tas: V, cas: tasToCas(V, atm), mach: V / atm.a, qbar: 0.5 * atm.rho * V * V,
      vs, gs, track: (Math.atan2(vE, vN) + 2 * Math.PI) % (2 * Math.PI),
      gamma: V > 1 ? Math.asin(clamp(vs / V, -1, 1)) : 0,
      psi: att.psi, theta: att.theta, phi: att.phi,
      alpha: V > 1 ? Math.atan2(wb, Math.max(ub, 0.1)) : 0,
      beta: V > 1 ? Math.asin(clamp(vb / V, -1, 1)) : 0,
      weight: this.mass * G0,
      onGround: this.onGround,
    };
    if (prev.aStall == null) this.d.aStall = this.cfg().a0 + this.clmaxNow(this.d.mach) / this.cla(this.d.mach);
    this.contacts();
    return this.d;
  }
}
