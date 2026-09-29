// 계기판 (캔버스): PFD(주비행표시) · ND(항법표시) · EICAS(엔진·장치)
import { DEG, KT, FT, FPM, NM, clamp, angDiff, distBrg } from './geo.js?v=202609291349';
import { toMag, rwyRel } from './nav.js?v=202609291349';
import { AIRPORTS } from '../data/airports.js?v=202609291349';
import { machToCas } from './atmosphere.js?v=202609291349';

const FONT = "'B612 Mono', Menlo, monospace";
const MAG = '#ff5cf0', CYAN = '#3ad7ff', GREEN = '#3dff8f', AMBER = '#ffb020', RED = '#ff3b3b', WHITE = '#f4f7fb';

function setup(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const MODE_NAMES = {
  airbus: {
    thr: { SPD: 'SPEED', MACH: 'MACH', CLB: 'THR CLB', IDLE: 'THR IDLE', TOGA: 'MAN TOGA', RETARD: 'RETARD' },
    vert: { ALT: 'ALT', VS: 'V/S', FLCH_UP: 'OP CLB', FLCH_DN: 'OP DES', PATH: 'DES', GS: 'G/S', FLARE: 'FLARE', SRS: 'SRS', ROLLOUT: 'ROLL OUT' },
    lat: { HDG: 'HDG', NAV: 'NAV', LOC: 'LOC', RWY: 'RWY', ROLLOUT: 'ROLL OUT' },
  },
  boeing: {
    thr: { SPD: 'SPD', MACH: 'SPD', CLB: 'THR REF', IDLE: 'IDLE', TOGA: 'THR REF', RETARD: 'IDLE' },
    vert: { ALT: 'ALT', VS: 'V/S', FLCH_UP: 'FLCH SPD', FLCH_DN: 'FLCH SPD', PATH: 'VNAV PTH', GS: 'G/S', FLARE: 'FLARE', SRS: 'TO/GA', ROLLOUT: 'ROLLOUT' },
    lat: { HDG: 'HDG SEL', NAV: 'LNAV', LOC: 'LOC', RWY: 'TO/GA', ROLLOUT: 'ROLLOUT' },
  },
};

export class Hud {
  constructor() {
    this.pfd = setup(document.getElementById('pfd'), 360, 360);
    this.nd = setup(document.getElementById('nd'), 360, 360);
    this.ei = setup(document.getElementById('eicas'), 250, 360);
    this.ndRange = 20;
  }

  // PFD는 매번(30Hz), 지도·엔진 화면은 번갈아(각 15Hz) 그려 부담을 줄임
  draw(sim, extra) {
    this.n = (this.n || 0) + 1;
    this.drawPfd(sim, extra);
    if (this.n % 2) this.drawNd(sim, extra);
    else this.drawEicas(sim, extra);
  }

  // ======================= PFD =======================
  drawPfd(sim, x) {
    const c = this.pfd, fm = sim.fm, d = fm.d, ap = sim.ap, ac = fm.ac;
    const fam = ac.family;
    c.fillStyle = '#000'; c.fillRect(0, 0, 360, 360);
    const cx = 180, cy = 178, PPD = 6;
    const th = d.theta / DEG, ph = d.phi;

    // --- 자세계 ---
    c.save();
    roundRect(c, 84, 44, 192, 262, 14); c.clip();
    c.translate(cx, cy); c.rotate(-ph);
    const py = th * PPD;
    const sky = c.createLinearGradient(0, py - 300, 0, py);
    sky.addColorStop(0, '#0a3d8f'); sky.addColorStop(1, '#2e86de');
    c.fillStyle = sky; c.fillRect(-400, py - 900, 800, 900);
    const gnd = c.createLinearGradient(0, py, 0, py + 300);
    gnd.addColorStop(0, '#8a5a2b'); gnd.addColorStop(1, '#4a2d12');
    c.fillStyle = gnd; c.fillRect(-400, py, 800, 900);
    c.strokeStyle = WHITE; c.lineWidth = 2;
    line(c, -400, py, 400, py);
    c.font = `11px ${FONT}`; c.fillStyle = WHITE; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 1.4;
    for (let a = -30; a <= 30; a += 2.5) {
      if (a === 0) continue;
      const y = py - a * PPD;
      const w = a % 10 === 0 ? 34 : a % 5 === 0 ? 20 : 9;
      line(c, -w, y, w, y);
      if (a % 10 === 0) { c.fillText(Math.abs(a), -w - 13, y); c.fillText(Math.abs(a), w + 13, y); }
    }
    // 비행경로 표시(FPV)
    if (!fm.onGround && d.V > 30) {
      const drift = angDiff(d.track, d.psi) / DEG;
      const fx = clamp(drift * PPD, -80, 80), fy = py - (d.gamma / DEG) * PPD;
      c.strokeStyle = GREEN; c.lineWidth = 2;
      c.beginPath(); c.arc(fx, fy, 6, 0, Math.PI * 2); c.stroke();
      line(c, fx - 16, fy, fx - 6, fy); line(c, fx + 6, fy, fx + 16, fy); line(c, fx, fy - 6, fx, fy - 12);
    }
    c.restore();

    // 경사 눈금
    c.save(); c.translate(cx, cy);
    c.strokeStyle = WHITE; c.lineWidth = 1.6;
    const R = 104;
    c.beginPath(); c.arc(0, 0, R, (-90 - 60) * DEG, (-90 + 60) * DEG); c.stroke();
    for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const a = (b - 90) * DEG, l = Math.abs(b) % 30 === 0 ? 10 : 6;
      line(c, Math.cos(a) * R, Math.sin(a) * R, Math.cos(a) * (R + l), Math.sin(a) * (R + l));
    }
    c.fillStyle = WHITE; tri(c, 0, -R - 1, 7, -1);
    c.rotate(-ph);
    const bankWarn = Math.abs(ph) > 35 * DEG;
    c.fillStyle = bankWarn ? AMBER : WHITE; tri(c, 0, -R + 2, 7, 1);
    c.restore();

    // FD 막대
    if (x.fd && !fm.onGround && ap.o && ap.o.gammaT != null) {
      c.save(); c.translate(cx, cy);
      c.strokeStyle = fam === 'airbus' ? GREEN : MAG; c.lineWidth = 3;
      const pitchCmd = ((ap.o.gammaT + d.alpha) / DEG - th) * PPD;
      const rollCmd = clamp(((ap.o.phiT ?? 0) - ph) / DEG * 2.2, -60, 60);
      line(c, -55, clamp(-pitchCmd, -80, 80), 55, clamp(-pitchCmd, -80, 80));
      line(c, rollCmd, -55, rollCmd, 55);
      c.restore();
    }
    // 항공기 기준 심볼
    c.save(); c.translate(cx, cy);
    c.fillStyle = '#000'; c.strokeStyle = '#ffd400'; c.lineWidth = 2.5;
    c.fillRect(-62, -3, 34, 6); c.strokeRect(-62, -3, 34, 6);
    c.fillRect(28, -3, 34, 6); c.strokeRect(28, -3, 34, 6);
    c.fillRect(-4, -4, 8, 8); c.strokeRect(-4, -4, 8, 8);
    c.restore();

    // 전파고도
    if (d.ra < 2500 * FT && !fm.onGround) {
      const ra = d.ra / FT;
      c.font = `bold 17px ${FONT}`; c.textAlign = 'center';
      c.fillStyle = ra < 200 ? AMBER : GREEN;
      c.fillText(ra < 50 ? Math.round(ra) : ra < 500 ? Math.round(ra / 5) * 5 : Math.round(ra / 10) * 10, cx, 286);
    }

    this.speedTape(c, sim, x);
    this.altTape(c, sim, x);
    this.hdgTape(c, sim, x);
    this.fma(c, sim, x);

    // 경고
    if (x.warn) {
      c.font = `bold 15px ${FONT}`; c.textAlign = 'center';
      c.fillStyle = x.warn.color || RED;
      c.fillStyle = 'rgba(0,0,0,.7)'; c.fillRect(cx - 70, 222, 140, 22);
      c.fillStyle = x.warn.color || RED; c.fillText(x.warn.text, cx, 234);
    }
  }

  speedTape(c, sim, x) {
    const fm = sim.fm, d = fm.d, ap = sim.ap, ac = fm.ac;
    const X = 16, W = 58, Y0 = 44, H = 262, cy = 178, PPK = 3.4;
    const v = d.cas / KT;
    c.save();
    c.fillStyle = '#2a2f37'; c.fillRect(X, Y0, W, H);
    c.beginPath(); c.rect(X, Y0, W, H); c.clip();
    // 실속·최소속도 띠
    const vs = fm.vs1g(Math.floor(fm.flapPos + 0.01)) / KT * Math.sqrt(Math.max(0.3, d.nz || 1));
    const yOf = (k) => cy - (k - v) * PPK;
    if (!fm.onGround) {
      c.fillStyle = AMBER; c.fillRect(X + W - 6, yOf(vs * 1.23), 4, Math.max(0, yOf(vs) - yOf(vs * 1.23)));
      hatch(c, X + W - 8, yOf(vs), 8, 400, RED);
    }
    // 최대속도
    const F = ac.flaps[Math.ceil(fm.flapPos - 0.01)];
    const vmax = Math.min(ac.perf.vmo, machToCas(ac.perf.mmo, d.atm) / KT, F.vfe || 999, fm.gearPos > 0.05 ? 270 : 999);
    hatch(c, X + W - 8, yOf(vmax) - 400, 8, 400, RED);
    // 눈금
    c.strokeStyle = WHITE; c.fillStyle = WHITE; c.font = `12px ${FONT}`; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.lineWidth = 1.4;
    const lo = Math.floor((v - 45) / 5) * 5;
    for (let k = Math.max(0, lo); k < v + 45; k += 5) {
      const y = yOf(k);
      line(c, X + W - 12, y, X + W, y);
      if (k % 20 === 0 && k >= 30) c.fillText(k, X + W - 15, y);
    }
    // 속도 추세
    const acc = sim.accelKt ?? 0;
    if (Math.abs(acc) > 0.3 && !fm.onGround || (fm.onGround && acc > 0.5)) {
      c.strokeStyle = GREEN; c.lineWidth = 2; line(c, X + W - 3, cy, X + W - 3, cy - acc * 10 * PPK);
    }
    // 목표 속도
    if (ap.at || x.fd) {
      const tgt = (ap.tgtCas ?? ap.mcp.spd * KT) / KT;
      const y = clamp(yOf(tgt), Y0 + 4, Y0 + H - 4);
      c.fillStyle = MAG; c.beginPath(); c.moveTo(X + W, y); c.lineTo(X + W + 9, y - 6); c.lineTo(X + W + 9, y + 6); c.closePath(); c.fill();
    }
    // V 속도
    c.font = `10px ${FONT}`; c.textAlign = 'left';
    const bugs = [];
    if (fm.onGround || d.ra < 400 * FT && d.vs > 0) {
      if (x.vspd) { bugs.push(['V1', x.vspd.v1 / KT], ['VR', x.vspd.vr / KT], ['V2', x.vspd.v2 / KT]); }
    }
    if (!fm.onGround && fm.gearDown) bugs.push(['REF', ap.vref() / KT]);
    for (const [name, val] of bugs) {
      const y = yOf(val);
      if (y < Y0 || y > Y0 + H) continue;
      c.fillStyle = CYAN; c.fillText(name, X + 2, y);
    }
    c.restore();
    // 현재 값
    c.fillStyle = '#000'; c.strokeStyle = WHITE; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(X - 2, cy - 14); c.lineTo(X + W - 4, cy - 14); c.lineTo(X + W + 4, cy); c.lineTo(X + W - 4, cy + 14); c.lineTo(X - 2, cy + 14); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = WHITE; c.font = `bold 17px ${FONT}`; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillText(Math.max(0, Math.round(v)), X + W - 6, cy + 1);
    // 목표 숫자 / 마하
    c.font = `13px ${FONT}`; c.fillStyle = MAG; c.textAlign = 'center';
    const tgtTxt = ap.mcp.useMach ? '.' + Math.round(ap.mcp.mach * 1000).toString().padStart(3, '0') : Math.round((ap.tgtCas ?? ap.mcp.spd * KT) / KT);
    c.fillText(tgtTxt, X + W / 2, Y0 - 11);
    if (d.mach > 0.4) { c.fillStyle = WHITE; c.fillText('.' + Math.round(d.mach * 1000).toString().padStart(3, '0'), X + W / 2, Y0 + H + 12); }
  }

  altTape(c, sim, x) {
    const fm = sim.fm, d = fm.d, ap = sim.ap;
    const X = 286, W = 52, Y0 = 44, H = 262, cy = 178, PPF = 0.3;
    const alt = d.hMsl / FT;
    c.save();
    c.fillStyle = '#2a2f37'; c.fillRect(X, Y0, W, H);
    c.beginPath(); c.rect(X, Y0, W, H); c.clip();
    const yOf = (k) => cy - (k - alt) * PPF;
    // 지면
    const groundMsl = (d.h - d.hAGL - (x.geoidN || 0)) / FT;
    if (yOf(groundMsl) < Y0 + H) hatch(c, X, yOf(groundMsl), W, 400, AMBER);
    c.strokeStyle = WHITE; c.fillStyle = WHITE; c.font = `11px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'middle'; c.lineWidth = 1.4;
    const lo = Math.floor((alt - 500) / 100) * 100;
    for (let k = lo; k < alt + 500; k += 100) {
      const y = yOf(k);
      line(c, X, y, X + (k % 500 === 0 ? 12 : 7), y);
      if (k % 200 === 0) c.fillText(k, X + 14, y);
    }
    // 목표 고도
    const tgt = ap.mcp.alt;
    const yt = clamp(yOf(tgt), Y0 + 3, Y0 + H - 3);
    c.fillStyle = MAG; c.fillRect(X, yt - 5, 7, 10);
    c.restore();
    // 현재 값
    c.fillStyle = '#000'; c.strokeStyle = WHITE; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(X - 6, cy); c.lineTo(X + 2, cy - 14); c.lineTo(X + W + 2, cy - 14); c.lineTo(X + W + 2, cy + 14); c.lineTo(X + 2, cy + 14); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = WHITE; c.font = `bold 15px ${FONT}`; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillText(Math.round(alt / 10) * 10, X + W - 1, cy + 1);
    c.font = `13px ${FONT}`; c.fillStyle = MAG; c.textAlign = 'center';
    c.fillText(tgt, X + W / 2, Y0 - 11);
    // 상승률
    const vs = d.vs / FPM;
    const VX = 342, vy = (f) => cy - Math.sign(f) * Math.min(95, Math.sqrt(Math.abs(f) / 6000) * 95);
    c.fillStyle = '#1b1f25'; c.fillRect(VX, cy - 100, 16, 200);
    c.strokeStyle = '#777'; c.lineWidth = 1;
    for (const f of [-6000, -2000, -1000, -500, 0, 500, 1000, 2000, 6000]) line(c, VX, vy(f), VX + 5, vy(f));
    c.strokeStyle = Math.abs(vs) > 6000 ? AMBER : GREEN; c.lineWidth = 2.5;
    line(c, VX + 16, cy, VX + 2, vy(vs));
    if (Math.abs(vs) > 400) {
      c.fillStyle = GREEN; c.font = `11px ${FONT}`; c.textAlign = 'right';
      c.fillText(Math.round(vs / 50) * 50, 358, vs > 0 ? cy - 108 : cy + 110);
    }
  }

  hdgTape(c, sim) {
    const fm = sim.fm, d = fm.d, ap = sim.ap;
    const X = 84, W = 192, Y = 314, H = 36, cx = 180, PPD = 3.2;
    const hdg = toMag(d.psi) / DEG;
    c.save();
    c.fillStyle = '#2a2f37'; c.fillRect(X, Y, W, H);
    c.beginPath(); c.rect(X, Y, W, H); c.clip();
    c.strokeStyle = WHITE; c.fillStyle = WHITE; c.font = `11px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'top'; c.lineWidth = 1.4;
    for (let k = Math.floor(hdg - 35); k < hdg + 35; k++) {
      if (k % 5) continue;
      const xx = cx + angDiff(k * DEG, hdg * DEG) / DEG * PPD;
      line(c, xx, Y, xx, Y + (k % 10 === 0 ? 8 : 4));
      if (k % 10 === 0) c.fillText(String(((k % 360) + 360) % 360 / 10).padStart(2, '0'), xx, Y + 10);
    }
    // 목표 방향
    const hx = cx + clamp(angDiff(ap.mcp.hdg * DEG, hdg * DEG) / DEG * PPD, -W / 2 + 4, W / 2 - 4);
    c.fillStyle = MAG; c.fillRect(hx - 5, Y, 10, 5);
    // 항적
    if (d.gs > 15) {
      const tx = cx + angDiff(toMag(d.track), hdg * DEG) / DEG * PPD;
      c.strokeStyle = GREEN; c.lineWidth = 1.5; c.beginPath(); c.moveTo(tx, Y + 1); c.lineTo(tx + 4, Y + 7); c.lineTo(tx, Y + 13); c.lineTo(tx - 4, Y + 7); c.closePath(); c.stroke();
    }
    c.restore();
    c.fillStyle = '#000'; c.strokeStyle = WHITE; c.lineWidth = 1.2;
    c.fillRect(cx - 22, Y - 18, 44, 18); c.strokeRect(cx - 22, Y - 18, 44, 18);
    c.fillStyle = WHITE; c.font = `bold 13px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(Math.round(hdg) % 360 || 360).padStart(3, '0'), cx, Y - 8);
  }

  fma(c, sim, x) {
    const ap = sim.ap, fm = sim.fm, fam = fm.ac.family;
    const N = MODE_NAMES[fam];
    const vert = ap.vert === 'FLCH' ? (ap.mcp.alt * FT > fm.d.hMsl ? 'FLCH_UP' : 'FLCH_DN') : ap.vert;
    const thr = ap.at ? (ap.thr === 'SPD' && ap.mcp.useMach ? 'MACH' : ap.thr) : null;
    const cols = [
      thr ? N.thr[thr] || thr : '',
      (ap.ap || x.fd) ? N.vert[vert] || vert : '',
      (ap.ap || x.fd) ? N.lat[ap.lat] || ap.lat : '',
      ap.ap ? (fam === 'airbus' ? 'AP1' : 'A/P') : (x.fd ? 'FD' : ''),
    ];
    const armed = [
      '',
      ap.armGs ? 'G/S' : (ap.vert !== 'ALT' && ap.vert !== 'GS' ? 'ALT' : ''),
      ap.armLoc ? 'LOC' : '',
      ap.at ? (fam === 'airbus' ? 'A/THR' : 'A/T') : '',
    ];
    c.fillStyle = '#000'; c.fillRect(0, 0, 360, 38);
    c.strokeStyle = '#555'; c.lineWidth = 1;
    const w = 90;
    for (let i = 0; i < 4; i++) {
      if (i) line(c, i * w, 2, i * w, 36);
      c.font = `bold 12px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = i === 3 ? WHITE : GREEN;
      c.fillText(cols[i], i * w + w / 2, 12);
      c.font = `10px ${FONT}`; c.fillStyle = i === 3 ? WHITE : CYAN;
      c.fillText(armed[i], i * w + w / 2, 28);
    }
  }

  // ======================= ND =======================
  drawNd(sim, x) {
    const c = this.nd, fm = sim.fm, d = fm.d, ap = sim.ap;
    c.fillStyle = '#000'; c.fillRect(0, 0, 360, 360);
    const cx = 180, cy = 292, R = 240;
    const hdgT = d.psi;
    // 거리 범위 자동
    let want = 20;
    const dest = ap.dest;
    if (dest) {
      const dd = distBrg(d.lat, d.lon, dest.lat, dest.lon).dist / NM;
      const wp = ap.wps[ap.wpIdx];
      const dw = wp ? distBrg(d.lat, d.lon, wp.lat, wp.lon).dist / NM : dd;
      want = Math.min(dd, Math.max(dw, 8)) * 1.15;
    }
    const ranges = [5, 10, 20, 40, 80, 160, 320];
    this.ndRange = Math.min(160, ranges.find((r) => r >= want) || 160);
    if (fm.onGround && !this.ndManual) this.ndRange = Math.min(this.ndRange, 10);
    const Rnm = this.ndRange;
    const proj = (lat, lon) => {
      const { dist, brg } = distBrg(d.lat, d.lon, lat, lon);
      const rel = brg - hdgT, r = (dist / NM) / Rnm * R;
      return [cx + Math.sin(rel) * r, cy - Math.cos(rel) * r];
    };
    c.save();
    c.beginPath(); c.rect(0, 0, 360, 360); c.clip();
    // 거리 호
    c.strokeStyle = '#3a4656'; c.lineWidth = 1;
    c.setLineDash([4, 5]); c.beginPath(); c.arc(cx, cy, R / 2, Math.PI, 2 * Math.PI); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#7f93aa'; c.font = `10px ${FONT}`; c.textAlign = 'left';
    c.fillText(Rnm / 2, cx - R / 2 - 12, cy - 6);
    // 공항·활주로
    for (const apt of Object.values(AIRPORTS)) {
      const [ax, ay] = proj(apt.lat * DEG, apt.lon * DEG);
      if (ax < -40 || ax > 400 || ay < -40 || ay > 400) continue;
      for (const r of apt.runways) {
        const a = proj(r.ends[0].lat * DEG, r.ends[0].lon * DEG), b = proj(r.ends[1].lat * DEG, r.ends[1].lon * DEG);
        c.strokeStyle = WHITE; c.lineWidth = Rnm <= 10 ? 3 : 1.5; line(c, a[0], a[1], b[0], b[1]);
      }
      c.strokeStyle = CYAN; c.lineWidth = 1.5; c.beginPath(); c.arc(ax, ay, 6, 0, Math.PI * 2); c.stroke();
      c.fillStyle = CYAN; c.font = `11px ${FONT}`; c.textAlign = 'left'; c.fillText(apt.icao, ax + 9, ay - 6);
    }
    // 목적지 연장선
    if (dest && x.finalFix) {
      const a = proj(dest.lat, dest.lon), b = proj(x.finalFix.lat, x.finalFix.lon);
      c.strokeStyle = '#cfd8e3'; c.setLineDash([6, 6]); c.lineWidth = 1; line(c, a[0], a[1], b[0], b[1]); c.setLineDash([]);
    }
    // 경로
    const onFinal = ap.lat === 'LOC' || ap.lat === 'ROLLOUT';
    if (ap.wps.length || dest) {
      c.strokeStyle = MAG; c.lineWidth = 2; c.beginPath(); c.moveTo(cx, cy);
      if (!onFinal) for (let i = ap.wpIdx; i < ap.wps.length; i++) { const p = proj(ap.wps[i].lat, ap.wps[i].lon); c.lineTo(p[0], p[1]); }
      if (dest) { const p = proj(dest.lat, dest.lon); c.lineTo(p[0], p[1]); }
      c.stroke();
      for (let i = onFinal ? ap.wps.length : ap.wpIdx; i < ap.wps.length; i++) {
        const [px, py] = proj(ap.wps[i].lat, ap.wps[i].lon);
        c.fillStyle = i === ap.wpIdx ? MAG : WHITE; star(c, px, py, 5);
        c.font = `10px ${FONT}`; c.fillText(ap.wps[i].name, px + 8, py + 4);
      }
    }
    c.restore();
    // 나침반 호
    c.save(); c.translate(cx, cy);
    c.strokeStyle = WHITE; c.lineWidth = 1.5;
    c.beginPath(); c.arc(0, 0, R, -Math.PI + 0.35, -0.35); c.stroke();
    const hdgM = toMag(hdgT) / DEG;
    c.font = `11px ${FONT}`; c.fillStyle = WHITE; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let k = 0; k < 360; k += 5) {
      const rel = angDiff(k * DEG, hdgM * DEG);
      if (Math.abs(rel) > 70 * DEG) continue;
      const sx = Math.sin(rel), sy = -Math.cos(rel);
      const l = k % 10 === 0 ? 10 : 5;
      line(c, sx * R, sy * R, sx * (R - l), sy * (R - l));
      if (k % 30 === 0) c.fillText(String(k / 10), sx * (R - 20), sy * (R - 20));
    }
    // 목표 방향
    const hr = angDiff(ap.mcp.hdg * DEG, hdgM * DEG);
    if (Math.abs(hr) < 70 * DEG) { c.fillStyle = MAG; c.save(); c.rotate(hr); c.fillRect(-5, -R - 2, 10, 7); c.restore(); }
    // 항적선
    if (d.gs > 15) { c.strokeStyle = GREEN; c.lineWidth = 1; c.save(); c.rotate(angDiff(d.track, hdgT)); c.setLineDash([3, 4]); line(c, 0, -14, 0, -R); c.setLineDash([]); c.restore(); }
    c.restore();
    // 항공기 기호
    c.strokeStyle = '#ffd400'; c.lineWidth = 2.5;
    line(c, cx, cy - 12, cx, cy + 16); line(c, cx - 12, cy, cx + 12, cy); line(c, cx - 5, cy + 13, cx + 5, cy + 13);
    // 상단 정보
    c.fillStyle = '#000'; c.fillRect(0, 0, 360, 36);
    c.font = `12px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillStyle = WHITE; c.fillText(`GS ${Math.round(d.gs / KT)}  TAS ${Math.round(d.V / KT)}`, 8, 12);
    c.fillStyle = GREEN; c.textAlign = 'center';
    c.fillText(`TRK ${String(Math.round(toMag(d.track) / DEG) % 360).padStart(3, '0')}`, 180, 12);
    if (dest) {
      const dtg = ap.distToGo() / NM;
      const eta = d.gs > 20 ? (dtg * NM / d.gs) / 60 : null;
      c.textAlign = 'right'; c.fillStyle = MAG;
      const wp = ap.lat === 'LOC' || ap.lat === 'ROLLOUT' ? null : ap.wps[ap.wpIdx];
      c.fillText(wp ? wp.name : `${dest.icao} ${dest.name}`, 352, 12);
      c.fillStyle = WHITE; c.fillText(`${dtg.toFixed(dtg < 100 ? 1 : 0)} NM${eta != null ? '  ' + Math.round(eta) + '분' : ''}`, 352, 28);
    }
    c.fillStyle = '#7f93aa'; c.textAlign = 'left'; c.fillText(`${Rnm} NM`, 8, 350);
    if (x.papiText) { c.textAlign = 'right'; c.fillStyle = WHITE; c.fillText(x.papiText, 352, 350); }
  }

  // ======================= EICAS =======================
  drawEicas(sim, x) {
    const c = this.ei, fm = sim.fm, d = fm.d, ac = fm.ac, ap = sim.ap;
    c.fillStyle = '#000'; c.fillRect(0, 0, 250, 360);
    const n = ac.engine.count;
    const n1 = Math.round(101 * Math.pow(Math.max(fm.spool, 0), 0.4) * 10) / 10;
    const lever = Math.round(101 * Math.pow(0.04 + 0.96 * fm.lever, 0.4));
    const r = n === 4 ? 24 : 34;
    for (let i = 0; i < n; i++) {
      const gx = n === 4 ? 32 + i * 62 : 64 + i * 122, gy = 52;
      c.strokeStyle = '#8a95a3'; c.lineWidth = 2;
      c.beginPath(); c.arc(gx, gy, r, Math.PI * 0.75, Math.PI * 2.25); c.stroke();
      const ang = (v) => Math.PI * 0.75 + (clamp(v, 0, 110) / 110) * Math.PI * 1.5;
      c.strokeStyle = MAG; c.lineWidth = 2; line(c, gx + Math.cos(ang(lever)) * (r - 6), gy + Math.sin(ang(lever)) * (r - 6), gx + Math.cos(ang(lever)) * (r + 4), gy + Math.sin(ang(lever)) * (r + 4));
      c.strokeStyle = WHITE; c.lineWidth = 2.5; line(c, gx, gy, gx + Math.cos(ang(n1)) * (r - 3), gy + Math.sin(ang(n1)) * (r - 3));
      c.fillStyle = WHITE; c.font = `bold ${n === 4 ? 11 : 14}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(n1.toFixed(1), gx, gy + r * 0.62);
      if (fm.rev > 0.05) { c.fillStyle = fm.rev > 0.95 ? GREEN : AMBER; c.font = `bold 11px ${FONT}`; c.fillText('REV', gx, gy - r * 0.35); }
    }
    c.fillStyle = '#8a95a3'; c.font = `11px ${FONT}`; c.textAlign = 'left'; c.fillText('N1 %', 6, 12);
    const row = (y, label, val, color = WHITE) => {
      c.textAlign = 'left'; c.fillStyle = '#8a95a3'; c.font = `11px ${FONT}`; c.fillText(label, 10, y);
      c.textAlign = 'right'; c.fillStyle = color; c.font = `bold 13px ${FONT}`; c.fillText(val, 240, y);
    };
    let y = 108;
    row(y, 'FUEL', (fm.fuel / 1000).toFixed(1) + ' t', fm.fuel < 3000 ? AMBER : GREEN); y += 20;
    row(y, 'F/F', (fm.fuelFlow * 3.6).toFixed(1) + ' t/h'); y += 20;
    row(y, 'GW', (fm.mass / 1000).toFixed(1) + ' t'); y += 26;
    // 플랩
    const F = ac.flaps;
    const fi = Math.round(fm.flapPos);
    const moving = Math.abs(fm.flapPos - fm.flapIdx) > 0.02;
    row(y, ac.family === 'airbus' ? 'FLAP' : 'FLAPS', (moving ? '→' : '') + F[fm.flapIdx].name, moving ? AMBER : GREEN);
    c.fillStyle = '#333'; c.fillRect(10, y + 10, 230, 6);
    c.fillStyle = moving ? AMBER : GREEN; c.fillRect(10, y + 10, 230 * fm.flapPos / (F.length - 1), 6);
    y += 34;
    // 바퀴
    const gtxt = fm.gearPos > 0.99 ? 'DOWN' : fm.gearPos < 0.01 ? 'UP' : 'TRANSIT';
    row(y, 'GEAR', gtxt, gtxt === 'DOWN' ? GREEN : gtxt === 'UP' ? WHITE : AMBER); y += 20;
    row(y, 'SPD BRK', fm.spoiler > 0.05 ? Math.round(fm.spoiler * 100) + '%' : fm.groundSpoilerArmed ? 'ARM' : 'RET', fm.spoiler > 0.05 ? AMBER : WHITE); y += 20;
    row(y, 'A/BRK', ['OFF', 'LO', 'MED', 'MAX', 'RTO'][fm.autobrake] + (fm.abActive ? ' ●' : ''), fm.autobrake ? GREEN : WHITE); y += 20;
    if (fm.parking) { row(y, 'PARK BRK', 'SET', AMBER); }
    else if (fm.brakeOut > 0.05) { row(y, 'BRAKES', Math.round(fm.brakeOut * 100) + '%', AMBER); }
    y += 20;
    // 경고 목록
    c.textAlign = 'left'; c.font = `bold 12px ${FONT}`;
    for (const w of (x.alerts || []).slice(0, 3)) { c.fillStyle = w.color || AMBER; c.fillText(w.text, 10, y); y += 17; }
  }
}

// ---------- 그리기 도우미 ----------
function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function tri(c, x, y, s, dir) { c.beginPath(); c.moveTo(x, y); c.lineTo(x - s, y - dir * s * 1.3); c.lineTo(x + s, y - dir * s * 1.3); c.closePath(); c.fill(); }
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function star(c, x, y, r) { c.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, rr = i % 2 ? r * 0.4 : r; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.closePath(); c.fill(); }
function hatch(c, x, y, w, h, color) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = color === RED ? '#000' : 'rgba(0,0,0,0)'; c.fillRect(x, y, w, h);
  c.strokeStyle = color; c.lineWidth = 2;
  for (let k = -h; k < h + w; k += 7) line(c, x, y + k, x + w, y + k - w);
  c.restore();
}
