/* global Cesium */
// 하늘길 — 메뉴 · 비행 준비 · 게임 루프 · 계기/패널 연결
import { AIRCRAFT, AIRCRAFT_ORDER, planWeights } from '../data/aircraft.js?v=202609291314';
import { AIRPORTS, ROUTES } from '../data/airports.js?v=202609291314';
import { View } from './view.js?v=202609291314';
import { Hud } from './hud.js?v=202609291314';
import { Controls } from './controls.js?v=202609291314';
import { Audio } from './audio.js?v=202609291314';
import { Sim, makeEnv } from './sim.js?v=202609291314';
import { runwayGeom, rwyRel, finalFix, toMag, toTrue } from './nav.js?v=202609291314';
import { scoreLanding } from './score.js?v=202609291314';
import { DEG, KT, FT, FPM, NM, clamp, distBrg, angDiff } from './geo.js?v=202609291314';
import { machToCas } from './atmosphere.js?v=202609291314';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('skysim.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('skysim.' + k, JSON.stringify(v)); } catch { /* 저장 불가 */ } },
};

const state = {
  acId: store.get('ac', 'ke-b77w'),
  mode: store.get('mode', 'route'),
  freeRwy: store.get('freeRwy', '33L'),
  routeId: store.get('route', 'ICN-CJU'),
  arrRwy: store.get('arrRwy', null),
  ldgApt: store.get('ldgApt', 'RKSI'),
  ldgRwy: store.get('ldgRwy', '33R'),
};

const view = new View();
const hud = new Hud();
const audio = new Audio();
let viewReady = null;
let sim = null, scenario = null, runways = {}, geoidPts = [], meta = {};
let paused = false, timeScale = 1, last = performance.now(), acc = 0, t = 0, hudT = 0, uiT = 0;
let fd = true, calloutPrev = {}, landing = null, resultShown = false, towerCache = null;

const controls = new Controls((name, arg) => onAction(name, arg));

// ======================= 메뉴 =======================
function stripe(ac) { return ac.code === 'KE' ? 'linear-gradient(#8fc9ec,#2f7fc0)' : 'linear-gradient(#e63946,#f4a261,#2a6fdb)'; }

function buildMenu() {
  const list = $('ac-list');
  list.innerHTML = '';
  for (const id of AIRCRAFT_ORDER) {
    const ac = AIRCRAFT[id];
    const b = document.createElement('button');
    b.className = 'ac-card' + (id === state.acId ? ' sel' : '');
    b.innerHTML = `<span class="stripe" style="background:${stripe(ac)}"></span>
      <div class="airline">${ac.airline}</div><div class="type">${ac.type}</div>
      <dl><dt>엔진</dt><dd>${ac.engine.name} ×${ac.engine.count}</dd>
      <dt>최대이륙</dt><dd>${(ac.mass.mtow / 1000).toFixed(0)} t</dd>
      <dt>길이·폭</dt><dd>${ac.dims.length} × ${ac.dims.span} m</dd>
      <dt>순항</dt><dd>마하 ${ac.perf.cruiseMach}</dd></dl>`;
    b.onclick = () => { state.acId = id; store.set('ac', id); buildMenu(); };
    list.appendChild(b);
  }
  const modes = [
    ['route', '노선 비행', '실제 노선을 이륙부터 착륙까지'],
    ['free', '인천 자유비행', '인천공항 활주로에서 출발'],
    ['landing', '착륙 연습', '최종접근 10NM에서 시작'],
  ];
  const ml = $('mode-list');
  ml.innerHTML = '';
  for (const [id, name, desc] of modes) {
    const b = document.createElement('button');
    b.className = 'mode-btn' + (state.mode === id ? ' sel' : '');
    b.innerHTML = `<b>${name}</b><small>${desc}</small>`;
    b.onclick = () => { state.mode = id; store.set('mode', id); buildMenu(); };
    ml.appendChild(b);
  }
  const o = $('mode-opts');
  o.innerHTML = '';
  const sel = (label, opts, value, onChange) => {
    const l = document.createElement('label');
    l.textContent = label;
    const s = document.createElement('select');
    for (const [v, t2] of opts) { const op = document.createElement('option'); op.value = v; op.textContent = t2; if (v === value) op.selected = true; s.appendChild(op); }
    s.onchange = () => onChange(s.value);
    l.appendChild(s); o.appendChild(l);
  };
  const ends = (icao) => AIRPORTS[icao].runways.flatMap((r) => r.ends.map((e) => [e.name, `${e.name} (${r.id.replace('/', ' / ')})`]));
  if (state.mode === 'free') {
    sel('출발 활주로', ends('RKSI'), state.freeRwy, (v) => { state.freeRwy = v; store.set('freeRwy', v); });
  } else if (state.mode === 'route') {
    sel('노선', ROUTES.map((r) => [r.id, `${r.label} (${r.from}→${r.to})`]), state.routeId, (v) => { state.routeId = v; state.arrRwy = null; store.set('route', v); store.set('arrRwy', null); buildMenu(); });
    const r = ROUTES.find((x) => x.id === state.routeId) || ROUTES[0];
    sel('도착 활주로', ends(r.to), state.arrRwy || r.arrRwy, (v) => { state.arrRwy = v; store.set('arrRwy', v); });
  } else {
    sel('공항', Object.values(AIRPORTS).map((a) => [a.icao, `${a.name} (${a.icao})`]), state.ldgApt, (v) => { state.ldgApt = v; state.ldgRwy = AIRPORTS[v].runways[0].ends[1].name; store.set('ldgApt', v); buildMenu(); });
    sel('활주로', ends(state.ldgApt), state.ldgRwy, (v) => { state.ldgRwy = v; store.set('ldgRwy', v); });
  }
}

// ======================= 비행 준비 =======================
async function ensureView(msg) {
  if (!viewReady) {
    for (const apt of Object.values(AIRPORTS)) for (const r of apt.runways) for (const e of r.ends) {
      runways[apt.icao + ' ' + e.name] = runwayGeom(apt.icao, e.name);
    }
    viewReady = view.init('view', { quality: $('opt-q').value, buildings: $('opt-bld').value }, Object.values(runways), msg);
    await viewReady;
    const all = Object.values(runways);
    geoidPts = Object.values(AIRPORTS).map((a) => {
      const gs = all.filter((g) => g.icao === a.icao);
      return { lat: a.lat * DEG, lon: a.lon * DEG, N: gs.reduce((s, g) => s + g.geoidN, 0) / gs.length };
    });
    view.viewer.scene.preUpdate.addEventListener(frame);
    try { meta = await (await fetch('models/models.json?v=202609291314', { cache: 'no-cache' })).json(); } catch { meta = {}; }
  }
  await viewReady;
  return Object.values(runways);
}

// 지형 높이 (물리용): 15m 이상 움직였을 때만 다시 조회.
// 아직 저해상도 타일만 있으면 큰 삼각형이 지구 곡면 아래로 처져 수 km 낮은 값이 나오므로 해수면으로 대체
let tq = { lat: 0, lon: 0, h: null };
function terrainCached(lat, lon) {
  // 지면에서 높을수록 조회 간격을 넓힘 (지면 근처 15m, 높은 고도 최대 약 1.5km)
  const agl = sim ? sim.fm.d.hAGL : 0;
  const k = agl < 300 ? 1 : Math.min(100, agl / 300);
  if (tq.h != null && Math.abs(lat - tq.lat) < 2.4e-6 * k && Math.abs(lon - tq.lon) < 3e-6 * k) return tq.h;
  let h = view.terrainHeight(lat, lon);
  const sea = geoidN(lat, lon);
  if (h == null || h < sea - 40 || h > 3000) h = Math.max(sea, tq.h != null && Math.abs(lat - tq.lat) < 1e-3 ? tq.h : sea);
  tq = { lat, lon, h };
  return h;
}

// 지오이드 높이(타원체-해발 차): 공항 4곳에서 측정한 값을 거리 역가중 평균 (추정)
function geoidN(lat, lon) {
  if (!geoidPts.length) return 0;
  let sw = 0, s = 0;
  for (const p of geoidPts) {
    const dd = Math.max(1000, distBrg(lat, lon, p.lat, p.lon).dist);
    const w = 1 / (dd * dd);
    sw += w; s += w * p.N;
  }
  return s / sw;
}

async function startFlight() {
  // 화질·건물 설정은 화면을 처음 만들 때만 적용되므로, 바뀌었으면 새로고침 후 바로 시작
  if (view.opts && (view.opts.quality !== $('opt-q').value || view.opts.buildings !== $('opt-bld').value)) {
    store.set('autostart', true);
    location.reload();
    return;
  }
  audio.start();
  $('menu').hidden = true;
  $('result').hidden = true; $('pause').hidden = true;
  $('loading').hidden = false;
  const msg = (m) => { $('load-msg').textContent = m; };
  try {
    msg('지형·위성사진 준비 중…');
    const all = await ensureView(msg);
    view.setTime($('opt-time').value);
    const ac = AIRCRAFT[state.acId];
    let dep = null, dest = null, cruiseFt = 10000, label = '', start = 'runway', routeKm = 300;
    if (state.mode === 'free') {
      dep = runways['RKSI ' + state.freeRwy];
      label = `인천 ${state.freeRwy} 출발 자유비행`;
      routeKm = 600;
    } else if (state.mode === 'route') {
      const r = ROUTES.find((x) => x.id === state.routeId) || ROUTES[0];
      dep = runways[r.from + ' ' + r.depRwy];
      dest = runways[r.to + ' ' + (state.arrRwy || r.arrRwy)];
      cruiseFt = r.cruiseFt;
      routeKm = distBrg(dep.lat, dep.lon, dest.lat, dest.lon).dist / 1000;
      label = `${r.label} · 도착 ${dest.name}`;
    } else {
      dest = runways[state.ldgApt + ' ' + state.ldgRwy];
      start = 'final';
      label = `${AIRPORTS[state.ldgApt].name} ${dest.name} 착륙 연습`;
    }
    const env = makeEnv({ runways: all, terrain: terrainCached, geoid: geoidN });
    msg('항공기 불러오는 중…');
    const m = meta[ac.id];
    sim = new Sim({ ac, meta: m, env, dep, dest, cruiseFt, start, routeKm });
    scenario = { ac, dep, dest, cruiseFt, label, start };
    try { await view.loadAircraft(ac.model + '?v=' + (m?.version || '202609291314'), m); } catch (e) { console.warn('모델 없음', e); }
    if (dest) view.makePapi(dest);
    view.makeRunwayLights(all);
    towerCache = null;
    view.setMode(start === 'final' ? 'chase' : 'chase', sim.fm);
    // 첫 화면: 주변 지형 로딩 대기
    view.updateAircraft(sim.fm, sim, 0);
    view.updateCamera(0.016, sim.fm, tower());
    msg('주변 지형 불러오는 중…');
    await waitTiles(15000);
    paused = false; timeScale = 1; acc = 0; t = 0;
    landing = null; resultShown = false; calloutPrev = {};
    view.viewer.clock.multiplier = 1;
    $('btn-time').textContent = '×1';
    $('loading').hidden = true;
    $('hud').hidden = false;
    controls.enabled = true;
    document.body.classList.toggle('touch', isTouch());
    $('touch').hidden = !isTouch();
    if (start === 'runway') {
      flash(sim.ac.family === 'airbus' ? '출발 준비 완료 — [자동비행] 또는 추력 올리고(+) 주차브레이크 해제(P)' : '출발 준비 완료 — [자동비행] 또는 추력 올리고(+) 주차브레이크 해제(P)', '', 7000);
    } else flash('최종접근 10NM — 활공각을 따라 내려가세요. 자동착륙: [자동비행]', '', 6000);
  } catch (e) {
    console.error(e);
    msg('오류: ' + e.message);
  }
}

function waitTiles(ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    const check = () => {
      const g = view.scene.globe;
      if ((g.tilesLoaded && performance.now() - t0 > 1500) || performance.now() - t0 > ms) res();
      else setTimeout(check, 150);
    };
    check();
  });
}

const isTouch = () => matchMedia('(pointer: coarse)').matches;

function tower() {
  if (!sim) return null;
  const d = sim.fm.d;
  let best = null, bd = Infinity;
  for (const a of Object.values(AIRPORTS)) {
    const dd = distBrg(d.lat, d.lon, a.lat * DEG, a.lon * DEG).dist;
    if (dd < bd) { bd = dd; best = a; }
  }
  if (!towerCache || towerCache.icao !== best.icao) {
    const g = Object.values(runways).find((r) => r.icao === best.icao);
    towerCache = { icao: best.icao, lat: best.lat * DEG, lon: best.lon * DEG, h: (g?.h0 ?? 20) + 85 };
  }
  return towerCache;
}

// ======================= 조작 =======================
function onAction(name, arg) {
  if (!sim) return;
  const fm = sim.fm, ap = sim.ap;
  switch (name) {
    case 'view': {
      const order = ['cockpit', 'chase', 'orbit', 'tower'];
      const next = arg || order[(order.indexOf(view.mode) + 1) % order.length];
      view.setMode(next, fm);
      flash({ cockpit: '조종석', chase: '추적', orbit: '자유 회전 (마우스 끌기)', tower: '관제탑' }[next]);
      break;
    }
    case 'timescale': {
      const steps = [1, 2, 4, 8, 16];
      let i = steps.indexOf(timeScale) + arg;
      i = clamp(i, 0, steps.length - 1);
      if (steps[i] > 4 && (fm.onGround || fm.d.ra < 2500 * FT)) { flash('낮은 고도에서는 4배속까지', 'warn'); i = Math.min(i, 2); }
      timeScale = steps[i];
      view.viewer.clock.multiplier = timeScale;
      $('btn-time').textContent = '×' + timeScale;
      break;
    }
    case 'hidepanel': togglePanel(); break;
    case 'pause': togglePause(); break;
    case 'help': $('help').hidden = !$('help').hidden; break;
    case 'app': armApp(); break;
    case 'auto':
      sim.action('auto');
      flash(sim.fms.enabled ? '자동비행 켜짐 — 이륙부터 착륙까지 자동' : '자동비행 꺼짐', sim.fms.enabled ? '' : 'warn');
      break;
    case 'flaps': {
      const before = fm.flapIdx;
      sim.action('flaps', arg);
      if (fm.flapIdx !== before) flash((fm.ac.family === 'airbus' ? 'FLAPS ' : '플랩 ') + fm.ac.flaps[fm.flapIdx].name);
      break;
    }
    case 'gear':
      if (fm.onGround) { flash('지상에서는 바퀴를 올릴 수 없습니다', 'warn'); break; }
      sim.action('gear'); flash(fm.gearDown ? '바퀴 내림' : '바퀴 올림');
      break;
    case 'parking': sim.action('parking'); flash(fm.parking ? '주차 브레이크 설정' : '주차 브레이크 해제'); break;
    case 'reverse':
      if (!fm.onGround) { flash('역추력은 착륙 후에만', 'warn'); break; }
      sim.action('reverse'); flash(sim.reverse ? '역추력' : '역추력 해제');
      break;
    case 'speedbrake': sim.action('speedbrake'); flash(sim.speedbrake ? '스피드브레이크 펼침' : '스피드브레이크 접음'); break;
    case 'ap': {
      const was = ap.ap;
      if (!was && fm.onGround) { flash('지상에서는 [자동비행]으로 이륙하세요', 'warn'); break; }
      sim.action('ap');
      if (was && !ap.ap) { audio.apOff(fm.ac.family); flash('자동조종 해제', 'warn'); }
      else if (ap.ap) { audio.chime(); flash('자동조종 연결'); }
      break;
    }
    case 'at': sim.action('at'); flash(ap.at ? '자동추력 연결' : '자동추력 해제', ap.at ? '' : 'warn'); break;
    case 'autobrake': {
      const next = fm.onGround ? (fm.autobrake === 4 ? 0 : 4) : (fm.autobrake + 1) % 4;
      sim.action('autobrake', next);
      flash('자동브레이크 ' + ['OFF', 'LO', 'MED', 'MAX', 'RTO'][next]);
      break;
    }
    case 'throttle': sim.action('throttle', arg); break;
    case 'lever': sim.action('lever', arg); break;
  }
}

function armApp() {
  const fm = sim.fm, ap = sim.ap, d = fm.d;
  if (!ap.dest) {
    // 가장 잘 정렬된 활주로 찾기
    let best = null, bs = Infinity;
    for (const g of Object.values(runways)) {
      const r = rwyRel(g, d.lat, d.lon);
      if (r.along > -300 || r.along < -35 * NM) continue;
      const s = Math.abs(r.cross) / 1000 + Math.abs(angDiff(d.track, g.crs)) / DEG / 10 + (-r.along / NM) / 10;
      if (s < bs) { bs = s; best = g; }
    }
    if (!best) { flash('정렬된 활주로가 없습니다 (35NM 이내)', 'warn'); return; }
    ap.dest = best;
    view.makePapi(best);
  }
  ap.armLoc = ap.lat !== 'LOC'; ap.armGs = ap.vert !== 'GS';
  flash(`착륙 접근 준비: ${ap.dest.icao} ${ap.dest.name}`);
}

// 계기판 전체(PFD·ND·엔진 화면·자동조종 패널·비행 정보) 켜고 끄기
function togglePanel(force) {
  const hide = force ?? !document.body.classList.contains('hide-panel');
  document.body.classList.toggle('hide-panel', hide);
  $('btn-panel').classList.toggle('off', hide);
  $('btn-panel').textContent = hide ? '계기판 켜기' : '계기판 끄기';
  store.set('hidePanel', hide);
  if (sim) {
    flash(hide ? '계기판 숨김 — 다시 켜려면 [계기판 켜기] 또는 H' : '계기판 표시');
    if (!hide) { updatePanel(); updateInfo(); hudT = 1; }
  }
}

function togglePause(force) {
  paused = force ?? !paused;
  $('pause').hidden = !paused;
  view.viewer.clock.shouldAnimate = !paused;
}

// ======================= MCP 패널 =======================
function setupPanel() {
  for (const k of document.querySelectorAll('#mcp .knob')) {
    const key = k.dataset.k;
    const bump = (dir, big) => {
      if (!sim) return;
      const ap = sim.ap, mcp = ap.mcp;
      if (sim.fms.enabled && key !== 'hdg') { sim.fms.stop(); flash('자동비행 해제 — 직접 설정 모드', 'warn'); }
      if (key === 'spd') {
        if (mcp.useMach) mcp.mach = clamp(Math.round((mcp.mach + dir * (big ? 0.05 : 0.01)) * 100) / 100, 0.4, 0.89);
        else mcp.spd = clamp(mcp.spd + dir * (big ? 10 : 1), 100, 360);
      } else if (key === 'hdg') mcp.hdg = ((mcp.hdg + dir * (big ? 10 : 1)) % 360 + 360) % 360;
      else if (key === 'alt') mcp.alt = clamp(mcp.alt + dir * (big ? 1000 : 100), 0, 43000);
      else if (key === 'vs') { const v = clamp(mcp.vs + dir * (big ? 500 : 100), -6000, 6000); if (ap.vert !== 'VS' && !sim.fm.onGround) ap.setVert('VS'); mcp.vs = v; }
      updatePanel(true);
    };
    for (const b of k.querySelectorAll('button')) {
      let timer = null;
      const d = +b.dataset.d;
      b.addEventListener('pointerdown', (e) => {
        bump(d, e.shiftKey);
        let n = 0;
        timer = setInterval(() => bump(d, ++n > 8), 110);
      });
      const stop = () => clearInterval(timer);
      b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop);
    }
    k.addEventListener('wheel', (e) => { e.preventDefault(); bump(e.deltaY < 0 ? 1 : -1, e.shiftKey); }, { passive: false });
    k.querySelector('output').addEventListener('click', () => {
      if (!sim || key !== 'spd') return;
      const mcp = sim.ap.mcp;
      mcp.useMach = !mcp.useMach;
      if (mcp.useMach) mcp.mach = Math.round(sim.fm.d.mach * 100) / 100;
      else mcp.spd = Math.round(sim.fm.d.cas / KT);
      updatePanel(true);
    });
  }
  for (const b of document.querySelectorAll('#mcp button.mode')) {
    b.addEventListener('click', () => {
      if (!sim) return;
      const ap = sim.ap, fm = sim.fm, m = b.dataset.m;
      const takeover = () => { if (sim.fms.enabled) { sim.fms.stop(); flash('자동비행 해제 — 직접 설정 모드', 'warn'); } };
      switch (m) {
        case 'AP': onAction('ap'); break;
        case 'AUTO': onAction('auto'); break;
        case 'SPD': onAction('at'); break;
        case 'HDG': takeover(); ap.lat = 'HDG'; break;
        case 'NAV': takeover(); if (ap.wps.length || ap.dest) ap.lat = 'NAV'; else flash('설정된 경로가 없습니다', 'warn'); break;
        case 'FLCH': takeover(); if (!fm.onGround) ap.setVert('FLCH'); break;
        case 'ALT': takeover(); if (!fm.onGround) ap.setVert('ALT'); break;
        case 'VS': takeover(); if (!fm.onGround) ap.setVert('VS'); break;
        case 'APP': takeover(); armApp(); break;
      }
      updatePanel(true);
    });
  }
}

function updatePanel() {
  if (!sim) return;
  const ap = sim.ap, mcp = ap.mcp;
  $('mcp-spd').textContent = mcp.useMach ? '.' + Math.round(mcp.mach * 1000).toString().padStart(3, '0') : mcp.spd;
  $('mcp-hdg').textContent = String(Math.round(mcp.hdg) % 360).padStart(3, '0');
  $('mcp-alt').textContent = mcp.alt;
  $('mcp-vs').textContent = ap.vert === 'VS' ? (mcp.vs > 0 ? '+' : '') + mcp.vs : '-----';
  const on = { AP: ap.ap, SPD: ap.at, HDG: ap.lat === 'HDG', NAV: ap.lat === 'NAV', FLCH: ap.vert === 'FLCH', ALT: ap.vert === 'ALT', VS: ap.vert === 'VS', APP: ap.lat === 'LOC' || ap.vert === 'GS', AUTO: sim.fms.enabled };
  const arm = { APP: ap.armLoc || ap.armGs };
  for (const b of document.querySelectorAll('#mcp button.mode')) {
    b.classList.toggle('on', !!on[b.dataset.m]);
    b.classList.toggle('arm', !!arm[b.dataset.m] && !on[b.dataset.m]);
  }
}

// ======================= 메시지·콜아웃 =======================
let flashTimer = null;
function flash(text, cls = '', ms = 2600) {
  const el = $('msg');
  el.textContent = text; el.className = 'show ' + cls;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = cls; }, ms);
}
let coTimer = null;
function callout(text, bad) {
  const el = $('callout');
  el.textContent = text; el.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(coTimer);
  coTimer = setTimeout(() => { el.className = ''; }, 1400);
}

function callouts(fm) {
  const d = fm.d, ap = sim.ap;
  const P = calloutPrev;
  // 이륙
  if (fm.onGround && d.gs > 20) {
    const v = ap.takeoffSpeedsCache || (ap.takeoffSpeedsCache = ap.takeoffSpeeds());
    const a = d.cas;
    if (!P.v1 && a >= v.v1 && fm.lever > 0.5) { P.v1 = true; audio.say('V one'); callout('V1'); }
    if (!P.vr && a >= v.vr && fm.lever > 0.5) { P.vr = true; audio.say('Rotate'); callout('ROTATE'); }
  }
  if (!fm.onGround && d.ra > 30 && d.vs > 1 && !P.pos) { P.pos = true; audio.say('Positive rate'); }
  // 고도 콜아웃 (강하 중)
  const ra = d.ra / FT;
  if (!fm.onGround && d.vs < -0.5) {
    for (const [h, txt] of [[2500, 'Twenty five hundred'], [1000, 'One thousand'], [500, 'Five hundred'], [100, 'One hundred'], [50, 'Fifty'], [40, 'Forty'], [30, 'Thirty'], [20, 'Twenty'], [10, 'Ten']]) {
      if (P.lastRa > h && ra <= h && !P['c' + h]) { P['c' + h] = true; audio.say(txt, 'alt' + h, 0.5); }
    }
    if (fm.ac.family === 'airbus' && P.lastRa > 20 && ra <= 20 && fm.lever > 0.06 && !P.retard) { P.retard = true; audio.say('Retard', 'retard'); }
  }
  if (ra > 3000) { for (const k of Object.keys(P)) if (/^c\d+$/.test(k) || k === 'retard') delete P[k]; }
  P.lastRa = ra;
}

function alerts(fm) {
  const d = fm.d, ac = fm.ac, list = [];
  let warn = null;
  if (fm.crashed) return { list, warn };
  const airborne = !fm.onGround;
  const vmo = Math.min(ac.perf.vmo * KT, machToCas(ac.perf.mmo, d.atm));
  if (airborne && sim.fbw.shaker && d.ra > 5) { warn = { text: 'STALL', color: '#ff3b3b' }; audio.say('Stall, stall', 'stall', 2); }
  else if (d.cas > vmo + 3 * KT) { warn = { text: 'OVERSPEED', color: '#ff3b3b' }; if ((t * 2 | 0) % 2 === 0) audio.clacker(); }
  const F = ac.flaps[Math.ceil(fm.flapPos - 0.01)];
  if (F.vfe && d.cas > (F.vfe + 5) * KT) list.push({ text: 'FLAP OVERSPEED', color: '#ff3b3b' });
  if (airborne && fm.gearPos > 0.05 && d.cas > 275 * KT) list.push({ text: 'GEAR OVERSPEED', color: '#ffb020' });
  if (airborne && Math.abs(d.phi) > 35 * DEG) { list.push({ text: 'BANK ANGLE' }); audio.say('Bank angle', 'bank', 3); }
  if (airborne && d.ra < 2500 * FT) {
    const sink = -d.vs / FPM, ra = d.ra / FT;
    if (sink > 2000 && ra < 1000 || sink > 3500 && ra < 2500) { warn = warn || { text: 'PULL UP', color: '#ff3b3b' }; audio.say('Pull up', 'pullup', 2); }
    else if (sink > 1400 && ra < 1500 || sink > 2500) { list.push({ text: 'SINK RATE' }); audio.say('Sink rate', 'sink', 3); }
    if (ra < 500 && fm.gearPos < 0.9 && sink > 100 && d.cas < 190 * KT) { list.push({ text: 'TOO LOW GEAR', color: '#ff3b3b' }); audio.say('Too low, gear', 'lowgear', 3); }
    else if (ra < 245 && fm.flapIdx < ac.ldgFlap - 1 && fm.gearPos > 0.9 && sink > 100) { list.push({ text: 'TOO LOW FLAPS' }); audio.say('Too low, flaps', 'lowflap', 3); }
  }
  if (fm.onGround && fm.lever > 0.5 && fm.flapIdx === 0 && d.gs < 80 * KT) list.push({ text: 'CONFIG FLAPS', color: '#ff3b3b' });
  if (fm.onGround && fm.lever > 0.5 && fm.parking) list.push({ text: 'PARK BRAKE SET', color: '#ff3b3b' });
  if (fm.fuel < 2000) list.push({ text: 'FUEL LOW' });
  return { list, warn };
}

// ======================= 결과 =======================
function handleEvents(events) {
  const fm = sim.fm;
  for (const e of events) {
    if (e.type === 'touchdown') {
      const g = findRunwayAt(e.lat, e.lon) || sim.ap.dest;
      landing = { td: e, rwy: g };
      if (e.fpm > 600) flash(`강한 착지 ${Math.round(e.fpm)} ft/min`, 'warn');
    } else if (e.type === 'liftoff') {
      if (landing && !resultShown) { landing = null; flash('터치 앤 고'); }
    } else if (e.type === 'crash') {
      showCrash(e.reason);
    } else if (e.type === 'tailstrike') {
      flash('꼬리가 활주로에 닿았습니다 (TAIL STRIKE)', 'bad', 4000);
    } else if (e.type === 'apoff' && e.reason === 'stick') {
      audio.apOff(fm.ac.family); flash('조종간 입력 — 자동조종 해제', 'warn');
    } else if (e.type === 'afloor') {
      flash('A.FLOOR — 자동 최대추력', 'bad', 3000);
    }
  }
  if (landing && !resultShown && fm.onGround && fm.d.gs < 35 * KT) showLanding();
}

function findRunwayAt(lat, lon) {
  for (const g of Object.values(runways)) {
    const r = rwyRel(g, lat, lon);
    if (r.along > -g.disp - 100 && r.along < g.len && Math.abs(r.cross) < g.width / 2 + 10) return g;
  }
  return null;
}

function showLanding() {
  resultShown = true;
  const { td, rwy } = landing;
  if (!rwy) return;
  const vref = sim.ap.vref();
  const s = scoreLanding(td, rwy, vref, sim.fm.tailStruck);
  $('res-title').textContent = `착륙 — ${rwy.apt.name} ${rwy.name}`;
  $('res-score').innerHTML = `${s.total}<small>${s.grade}</small>`;
  $('res-table').innerHTML = s.items.map((i) => `<tr><td>${i[0]}</td><td>${i[1]}</td><td>${i[2]}/${i[3]}</td></tr>`).join('')
    + (s.notes.length ? `<tr><td colspan="3" style="color:#ffb020">${s.notes.join(' · ')}</td></tr>` : '');
  $('res-continue').hidden = false;
  $('result').hidden = false;
  audio.say(s.total >= 75 ? 'Nice landing' : 'Landing', 'land', 5);
}

function showCrash(reason) {
  $('res-title').textContent = '사고';
  $('res-score').innerHTML = `<span style="color:#ff4d4d;font-size:30px">${reason}</span>`;
  $('res-table').innerHTML = '';
  $('res-continue').hidden = true;
  $('result').hidden = false;
  controls.enabled = true;
}

// ======================= 루프 =======================
function frame() {
  const now = performance.now();
  const rawMs = now - last;
  let dt = Math.min(0.1, rawMs / 1000);
  last = now;
  if (!sim) return;
  view.adaptResolution(rawMs);
  const fm = sim.fm;
  if (!paused && $('menu').hidden) {
    const inp = controls.update(dt);
    sim.input.pitch = inp.pitch; sim.input.roll = inp.roll; sim.input.yaw = inp.yaw; sim.input.brake = inp.brake;
    // 낮은 고도 자동 감속
    if (timeScale > 4 && (fm.onGround || fm.d.ra < 2500 * FT)) { timeScale = 4; view.viewer.clock.multiplier = 4; $('btn-time').textContent = '×4'; }
    // 물리: 이번 프레임 시간만큼 정확히 진행 (1/120초 이하로 나눠서) → 화면 프레임과 어긋나 떨리는 현상 없음
    const simDt = dt * timeScale;
    const n = Math.max(1, Math.ceil(simDt * 120 - 1e-6));
    const h = simDt / n;
    const v0 = fm.d.cas;
    for (let i = 0; i < n; i++) { sim.step(h); t += h; }
    const a = ((fm.d.cas - v0) / KT) / Math.max(simDt, 1e-3);
    sim.accelKt = (sim.accelKt ?? 0) + (a - (sim.accelKt ?? 0)) * Math.min(1, dt * 4);
    handleEvents(sim.drainEvents());
    callouts(fm);
  }
  view.setShadows(fm.d.ra < 250 && view.mode !== 'cockpit');
  const sunEl = view.sunElevationCached(fm.d.lat, fm.d.lon);
  view.night = sunEl < -4 * DEG;
  if (view.rwyLights) view.rwyLights.show = sunEl < -1 * DEG;
  // 해가 지면 항공기 조명도 어둡게 (Cesium은 해가 지평선 아래여도 모델을 비추므로)
  const day = clamp((sunEl / DEG + 6) / 10, 0.06, 1);
  if (view.scene.light && 'intensity' in view.scene.light) view.scene.light.intensity = 2.0 * day;
  if (view.model && view.model.imageBasedLighting && Math.abs((view._day ?? -1) - day) > 0.01) {
    view._day = day;
    view.model.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(day, day);
  }
  view.updateAircraft(fm, sim, t);
  if (!window.__freeCam) view.updateCamera(dt, fm, tower());
  view.updatePapi();
  audio.update(fm, view.mode, paused || !$('menu').hidden);
  hudT += dt;
  if (hudT > 1 / 30) {
    hudT = 0;
    const al = alerts(fm);   // 경고음은 계기판을 숨겨도 계속
    if (!document.body.classList.contains('hide-panel')) {
      const vspd = fm.onGround || fm.d.ra < 500 * FT ? (sim.ap.takeoffSpeedsCache || sim.ap.takeoffSpeeds()) : null;
      hud.draw(sim, { fd, warn: al.warn, alerts: al.list, vspd, geoidN: geoidN(fm.d.lat, fm.d.lon), finalFix: sim.ap.dest ? finalFix(sim.ap.dest, 15 * NM) : null });
    }
  }
  uiT += dt;
  if (uiT > 0.15) {
    uiT = 0;
    if (!document.body.classList.contains('hide-panel')) { updatePanel(); updateInfo(); }
    controls.updateTouchUi && controls.updateTouchUi();
  }
}

function updateInfo() {
  const fm = sim.fm, d = fm.d, ap = sim.ap;
  const phase = sim.fms.enabled ? { PREFLIGHT: '출발 준비', TAKEOFF: '이륙', CLIMB: '상승', CRUISE: '순항', DESCENT: '강하', APPROACH: '접근', LANDING: '착륙', ROLLOUT: '착륙 활주', DONE: '도착' }[sim.fms.phase] : (fm.onGround ? '지상' : '수동/자동조종');
  const dtg = ap.dest ? `${(ap.distToGo() / NM).toFixed(0)} NM` : '';
  $('flight-info').innerHTML = `<b>${fm.ac.airline} ${fm.ac.type}</b> · ${scenario.label}<br>${phase}${dtg ? ' · 남은 거리 ' + dtg : ''} · 고도 ${Math.round(d.hMsl / FT).toLocaleString()} ft · ${Math.round(d.cas / KT)} kt${timeScale > 1 ? ` · <b>×${timeScale}</b>` : ''}`;
}

// ======================= 연결 =======================
function wire() {
  buildMenu();
  // 메뉴 옵션 기억 (터치 기기는 처음에 화질 '낮음')
  for (const id of ['opt-time', 'opt-bld', 'opt-q']) {
    const saved = store.get(id, id === 'opt-q' && isTouch() ? 'low' : null);
    if (saved != null) $(id).value = saved;
    $(id).addEventListener('change', () => store.set(id, $(id).value));
  }
  setupPanel();
  controls.setupTouch(() => (sim ? sim.fm.lever : 0));
  $('btn-start').onclick = () => startFlight();
  $('btn-view').onclick = () => onAction('view');
  $('btn-mcp').onclick = () => document.body.classList.toggle('mcp-open');
  $('btn-panel').onclick = () => togglePanel();
  togglePanel(store.get('hidePanel', false));
  $('btn-time').onclick = () => onAction('timescale', timeScale >= 16 ? -4 : 1);
  $('btn-sound').onclick = () => { audio.setOn(!audio.on); $('btn-sound').textContent = audio.on ? '🔊' : '🔈'; };
  $('btn-help').onclick = () => { $('help').hidden = false; };
  $('link-help').onclick = (e) => { e.preventDefault(); $('help').hidden = false; };
  $('help-close').onclick = () => { $('help').hidden = true; };
  $('btn-pause').onclick = () => togglePause();
  $('btn-resume').onclick = () => togglePause(false);
  $('btn-restart').onclick = () => { togglePause(false); startFlight(); };
  $('btn-menu').onclick = () => toMenu();
  $('res-continue').onclick = () => { $('result').hidden = true; };
  $('res-restart').onclick = () => { $('result').hidden = true; startFlight(); };
  $('res-menu').onclick = () => toMenu();
}

function toMenu() {
  paused = true;
  $('pause').hidden = true; $('result').hidden = true; $('hud').hidden = true;
  $('menu').hidden = false;
  controls.enabled = false;
  buildMenu();
}

wire();
if (store.get('autostart', false)) { store.set('autostart', false); startFlight(); }
// 브라우저는 사용자 조작 뒤에만 소리를 허용 → 첫 클릭·키 입력 때 소리 시작
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio.start(), { once: true });
// 디버그용 접근 (콘솔)
window.__sky = {
  get view() { return view; }, get sim() { return sim; }, get runways() { return runways; },
  // 테스트용: 시뮬레이션을 sec초 진행 (화면이 느리게 갱신되는 환경에서 검증할 때)
  advance(sec) {
    const h = 1 / 120;
    for (let i = 0; i < sec / h; i++) { sim.step(h); t += h; handleEvents(sim.drainEvents()); callouts(sim.fm); }
    return { phase: sim.fms.phase, alt: Math.round(sim.fm.d.hMsl / FT), cas: Math.round(sim.fm.d.cas / KT), ra: Math.round(sim.fm.d.ra / FT), lat: sim.ap.lat, vert: sim.ap.vert };
  },
  // 자유 카메라: 항공기 기준 거리·방위·높이 → 바라볼 방향·피치
  look(dist, brg, h, hdg, pitch) {
    window.__freeCam = true;
    const d = sim.fm.d, R = 6371000, b = brg * DEG;
    const lat = d.lat + dist * Math.cos(b) / R, lon = d.lon + dist * Math.sin(b) / (R * Math.cos(d.lat));
    view.camera.setView({ destination: Cesium.Cartesian3.fromRadians(lon, lat, sim.fm.groundH + h), orientation: { heading: hdg * DEG, pitch: pitch * DEG, roll: 0 } });
  },
};
