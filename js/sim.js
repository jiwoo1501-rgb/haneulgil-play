// 시뮬레이션 묶음: 물리 + 비행제어 + 자동조종 + 자동비행 + 조종사 입력
import { FlightModel } from './physics.js?v=202609291314';
import { FlightControl } from './fbw.js?v=202609291314';
import { Autopilot } from './autopilot.js?v=202609291314';
import { AutoFlight } from './fms.js?v=202609291314';
import { DEG, KT, FT, NM, FPM, clamp, destPoint, distBrg } from './geo.js?v=202609291314';
import { rwyRel, rwySurfaceH, finalFix, GS_ANGLE, GPI, toMag } from './nav.js?v=202609291314';
import { planWeights } from '../data/aircraft.js?v=202609291314';
import { thrustLapse } from './physics.js?v=202609291314';

const G0 = 9.80665;

// 지면 높이·표면 판정: 활주로 위면 활주로 단면, 아니면 지형 함수
export function makeEnv({ runways, terrain, geoid }) {
  const inside = (g, lat, lon, pad) => {
    const r = rwyRel(g, lat, lon);
    const s = r.along + g.disp;
    return s > -pad && s < g.len + pad && Math.abs(r.cross) < g.width / 2 + pad * 0.5 ? r : null;
  };
  return {
    runways,
    groundHeight(lat, lon) {
      for (const g of runways) {
        if (g.profile == null) continue;
        const r = inside(g, lat, lon, 60);
        if (r) return rwySurfaceH(g, r.along);
      }
      return terrain(lat, lon);
    },
    surface(lat, lon) {
      for (const g of runways) if (inside(g, lat, lon, 12)) return 'runway';
      return 'ground';
    },
    geoidN: geoid || (() => 0),
    nearAirport(lat, lon) { return runways.some((g) => Math.abs(rwyRel(g, lat, lon).cross) < 3000 && Math.abs(rwyRel(g, lat, lon).along) < 6000); },
  };
}

export class Sim {
  // o: { ac, meta, env, dep, dest, cruiseFt, start: 'runway'|'final', routeKm }
  constructor(o) {
    this.o = o;
    const ac = o.ac;
    this.ac = ac;
    this.fm = new FlightModel(ac, o.meta, o.env);
    const w = planWeights(ac, o.routeKm ?? 300, o.loadFactor ?? 0.8);
    this.weights = w;
    const fm = this.fm;
    if (o.start === 'final') {
      const g = o.dest;
      const dist = (o.finalNm ?? 10) * NM;
      const p = finalFix(g, dist);
      const hAbove = (GPI + dist) * Math.tan(GS_ANGLE);
      const landMass = ac.mass.oew + w.payload + Math.min(w.fuel, 15000);
      fm.reset({ lat: p.lat, lon: p.lon, hdg: g.crs, onGround: false, alt: g.h0 + hAbove + 6.5, speed: 70,
        gamma: -GS_ANGLE, flapIdx: ac.ldgFlap, gearDown: true, fuel: Math.min(w.fuel, 15000), payload: w.payload });
      this.ap = new Autopilot(fm);
      const vapp = this.ap.vref(landMass) + 5 * KT;
      fm.reset({ lat: p.lat, lon: p.lon, hdg: g.crs, onGround: false, alt: g.h0 + hAbove + 6.5,
        speed: vapp * Math.sqrt(1.225 / fm.d.atm.rho), gamma: -GS_ANGLE, flapIdx: ac.ldgFlap, gearDown: true,
        fuel: Math.min(w.fuel, 15000), payload: w.payload, autobrake: 2 });
      this.trimThrust();
      this.ap.dest = g;
      this.ap.at = true; this.ap.thr = 'SPD';
      this.ap.mcp.spd = Math.round(vapp / KT);
      this.ap.mcp.alt = Math.round((g.h0 - (g.geoidN || 0)) / FT / 100) * 100 + 3000;
      this.ap.mcp.hdg = Math.round(toMag(g.crs) / DEG) % 360;
      this.ap.lat = 'LOC'; this.ap.vert = 'GS';
    } else {
      const g = o.dep;
      const p = destPoint(g.endLat, g.endLon, g.crs, 40 + (o.meta ? 0 : 0));
      fm.reset({ lat: p.lat, lon: p.lon, hdg: g.crs, onGround: true, flapIdx: ac.toFlap, gearDown: true,
        fuel: w.fuel, payload: w.payload, parking: true, autobrake: 4 });
      this.ap = new Autopilot(fm);
      this.ap.mcp.hdg = Math.round(toMag(g.crs) / DEG) % 360;
      this.ap.mcp.alt = o.cruiseFt ?? 10000;
      this.ap.takeoffSpeeds();
      this.ap.mcp.spd = Math.round(this.ap.v2 / KT + 10);
      this.ap.dep = g;
      this.ap.dest = o.dest || null;
      this.ap.lat = 'RWY'; this.ap.vert = 'SRS'; this.ap.thr = 'TOGA';
    }
    this.fbw = new FlightControl(fm);
    this.fms = new AutoFlight(fm, this.ap, { dep: o.dep, dest: o.dest, cruiseFt: o.cruiseFt ?? 10000 });
    this.input = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
    this.lever = fm.lever;
    this.reverse = false;
    this.speedbrake = 0;
    this.events = [];
    this.time = 0;
    this.apDiscTime = -10;
  }

  // 현재 받음각에서 수평/활공 유지에 필요한 추력으로 맞춤 (공중 시작용)
  trimThrust() {
    const fm = this.fm, d = fm.d, ac = fm.ac;
    const W = fm.mass * G0;
    const A = fm.aero(d.theta - d.gamma, 0, d.mach, 1000);
    const D = d.qbar * ac.dims.wingArea * A.CD;
    const Tav = ac.engine.count * ac.engine.thrust * thrustLapse(d.mach, d.atm.sigma);
    const f = clamp((D + W * Math.sin(d.gamma)) / Tav, 0.04, 1);
    fm.spool = f;
    fm.lever = clamp((f - 0.04) / 0.96, 0, 1);
    Object.assign(d, { drag: D, thrustAvail: Tav, excess: (f * Tav - D) / W });
  }

  emit(type, extra = {}) { this.events.push({ type, t: this.time, ...extra }); }

  drainEvents() {
    const e = this.events.concat(this.fm.events);
    this.events = []; this.fm.events = [];
    return e;
  }

  // ---------- 조종사 조작 ----------
  action(name, arg) {
    const fm = this.fm, ap = this.ap;
    switch (name) {
      case 'flaps': fm.flapIdx = clamp(fm.flapIdx + arg, 0, fm.ac.flaps.length - 1); break;
      case 'gear':
        if (!fm.onGround) fm.gearDown = !fm.gearDown;
        if (fm.gearDown && fm.autobrake === 0) fm.autobrake = 2;   // 착륙 준비: 자동브레이크 MED
        break;
      case 'speedbrake': this.speedbrake = arg != null ? clamp(arg, 0, 1) : this.speedbrake > 0 ? 0 : 1; break;
      case 'parking': fm.parking = !fm.parking; break;
      case 'reverse': this.reverse = fm.onGround ? !this.reverse : false; if (this.reverse) this.lever = 0; break;
      case 'throttle':
        if (ap.at) { ap.at = false; this.emit('atoff'); }
        this.lever = clamp(this.lever + arg, 0, 1);
        break;
      case 'lever':
        if (ap.at) { ap.at = false; this.emit('atoff'); }
        this.lever = clamp(arg, 0, 1);
        break;
      case 'toga': this.lever = 1; if (ap.at) ap.thr = 'TOGA'; break;
      case 'ap':
        if (ap.ap) { ap.engage(false); this.fms.stop(); this.emit('apoff'); }
        else if (ap.engage(true)) this.emit('apon');
        break;
      case 'at':
        ap.at = !ap.at;
        if (ap.at && !['CLB', 'IDLE', 'TOGA'].includes(ap.thr)) ap.thr = 'SPD';
        if (!ap.at) this.emit('atoff');
        break;
      case 'autobrake': fm.autobrake = arg; break;
      case 'auto':   // 자동 비행 (이륙~착륙)
        if (this.fms.enabled) { this.fms.stop(); this.emit('fmsoff'); }
        else { this.fms.start(); this.lever = fm.lever; this.emit('fmson'); }
        break;
    }
  }

  step(dt) {
    const fm = this.fm, ap = this.ap, inp = this.input;
    if (fm.crashed) return;
    this.time += dt;
    // 조종간을 크게 움직이면 자동조종 해제
    if (ap.ap && !fm.onGround && (Math.abs(inp.pitch) > 0.4 || Math.abs(inp.roll) > 0.4)) {
      ap.engage(false); this.fms.stop(); this.emit('apoff', { reason: 'stick' });
    }
    const apo = ap.update(dt);
    const fc = this.fms.update(dt);
    const ctl = this.fbw.update(dt, inp, ap.ap ? apo : null);

    let lever = this.lever;
    if (ap.at && apo.lever != null) lever = apo.lever;
    if (fc.lever != null) lever = fc.lever;
    // 에어버스 알파 플로어: 받음각 과다 시 자동 최대추력 (저속·플랩 사용 구간에서만, 조건 해제 3초 후 복귀)
    const floorCond = fm.ac.family === 'airbus' && !fm.onGround && fm.d.ra > 30 && (fm.flapPos > 0.5 || fm.d.mach < 0.5)
      && fm.d.alpha > (fm.d.aStall ?? 1) - 1.5 * DEG;
    if (floorCond) {
      lever = 1; ap.at = true; ap.thr = 'TOGA';
      if (!this.aFloor) { this.aFloor = true; this.emit('afloor'); }
      this.aFloorT = 0;
    } else if (this.aFloor) {
      this.aFloorT = (this.aFloorT || 0) + dt;
      if (this.aFloorT > 3) { this.aFloor = false; ap.thr = 'SPD'; }
    }
    this.lever = lever;

    fm.step(dt, {
      rates: ctl.rates, groundPitchRate: ctl.groundPitchRate, steer: ctl.steer,
      lever, reverse: fc.reverse ?? this.reverse, brake: Math.max(inp.brake || 0, fc.brake || 0),
      flapIdx: fc.flapIdx, gearDown: fc.gearDown, speedbrake: fc.speedbrake ?? this.speedbrake, parking: fc.parking,
    });
    if (fc.reverse != null) this.reverse = fc.reverse;
    if (fm.onGround && fm.d.gs < 1 && this.reverse && !this.fms.enabled) this.reverse = false;
  }
}
