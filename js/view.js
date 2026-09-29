/* global Cesium */
// Cesium 화면: 지구·지형·건물, 항공기 모델, 조명, 카메라 시점, PAPI
import { CESIUM_TOKEN } from './config.js?v=202609291349';
import { v3, quat, enu, geodeticToEcef, ecefToGeodetic, DEG, clamp, angDiff, destPoint } from './geo.js?v=202609291349';
import { rwyRel } from './nav.js?v=202609291349';
import { FlatTerrainProvider, sampleRunway, buildAirportZone } from './flatten.js?v=202609291349';
import { AIRPORT_AREAS } from '../data/airport-areas.js?v=202609291349';

const C3 = (a) => new Cesium.Cartesian3(a[0], a[1], a[2]);

// 화질 단계: 해상도 배율(scale, 자동 조절 하한 minScale), MSAA, 지형 세밀도(sse), 그림자, 건물 세밀도, 안개
const QUALITY = {
  high: { retina: true, scale: 1, minScale: 0.6, msaa: 4, sse: 1.5, shadows: true, shadowSize: 2048, soft: true, bldSse: 8, fog: 1.6e-4, cache: 400 },
  mid: { retina: false, scale: 1, minScale: 0.6, msaa: 1, sse: 2, shadows: true, shadowSize: 1024, soft: false, bldSse: 16, fog: 2.0e-4, cache: 300 },
  low: { retina: false, scale: 0.8, minScale: 0.5, msaa: 1, sse: 3, shadows: false, bldSse: 32, fog: 2.6e-4, cache: 150 },
};
const gltfToBody = (p) => [p[2], -p[0], -p[1]];
const SQ = new Cesium.Quaternion(), SM3 = new Cesium.Matrix3(), SM4 = new Cesium.Matrix4();

export class View {
  // runways: 모든 활주로 끝 기하 (양방향). 지형 측정 → 평탄화 지형 제공자 생성 후 화면 생성
  async init(container, opts, runways, onMsg = () => {}) {
    Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;
    this.opts = opts;
    const q = opts.quality;
    const inner = await Cesium.createWorldTerrainAsync({ requestWaterMask: true, requestVertexNormals: true });
    onMsg('활주로·공항 부지 높이 측정 중…');
    // 물리적 활주로 1개당 한쪽 끝만 원본 높이 샘플링
    const samples = new Map();
    const seen = new Set();
    const phys = runways.filter((g) => { const k = g.icao + g.rwyId; if (seen.has(k)) return false; seen.add(k); return true; });
    await Promise.all(phys.map(async (g) => samples.set(g.icao + g.rwyId + g.name, await sampleRunway(inner, g))));
    const zones = [];
    for (const icao of new Set(runways.map((g) => g.icao))) {
      const list = runways.filter((g) => g.icao === icao);
      if (!AIRPORT_AREAS[icao]) continue;
      zones.push(buildAirportZone(list[0].apt, list, samples, AIRPORT_AREAS[icao]));
    }
    this.zones = zones;
    const terrainProvider = new FlatTerrainProvider(inner, zones);
    this.terrainProvider = terrainProvider;
    const Q = QUALITY[q] || QUALITY.mid;
    this.Q = Q;
    const viewer = new Cesium.Viewer(container, {
      terrainProvider,
      baseLayer: Cesium.ImageryLayer.fromWorldImagery({ style: Cesium.IonWorldImageryStyle.AERIAL }),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false, shouldAnimate: true,
      msaaSamples: Q.msaa,
      shadows: false,
      terrainShadows: Q.shadows ? Cesium.ShadowMode.RECEIVE_ONLY : Cesium.ShadowMode.DISABLED,
    });
    this.viewer = viewer;
    const scene = viewer.scene;
    this.scene = scene;
    this.camera = scene.camera;
    // 해상도: 보통·낮음은 화면(CSS) 해상도 기준, 높음만 레티나 해상도(최대 2배)
    //  (이전: 레티나 2배 × 1.5배 = 3배 해상도로 그려서 매우 느렸음)
    viewer.useBrowserRecommendedResolution = !Q.retina;
    this.baseScale = Q.retina ? Math.min(1, 2 / Math.max(1, window.devicePixelRatio)) : Q.scale;
    viewer.resolutionScale = this.baseScale;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.globe.enableLighting = true;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#5d6a5a');
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.maximumScreenSpaceError = Q.sse;
    scene.globe.tileCacheSize = Q.cache;
    scene.globe.preloadSiblings = false;
    scene.globe.preloadAncestors = true;
    scene.fog.enabled = true;
    scene.fog.density = Q.fog;
    scene.fog.screenSpaceErrorFactor = 3;
    if (scene.atmosphere && Cesium.DynamicAtmosphereLightingType) scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
    scene.postProcessStages.fxaa.enabled = Q.msaa <= 1;
    if (viewer.shadowMap) {
      viewer.shadowMap.maximumDistance = 400;
      viewer.shadowMap.size = Q.shadowSize || 1024;
      viewer.shadowMap.softShadows = !!Q.soft;
      viewer.shadowMap.darkness = 0.35;
    }
    if (/[?&]fps\b/.test(location.search)) scene.debugShowFramesPerSecond = true;
    this.camera.frustum.near = 0.3;

    // 건물
    try {
      if (opts.buildings === 'osm') {
        // 높이 자료가 잘못된 OSM 건물(수백 m 기둥) 숨김 — 국내 350m 넘는 건물은 롯데월드타워뿐
        this.tiles = await Cesium.createOsmBuildingsAsync({
          style: new Cesium.Cesium3DTileStyle({
            show: "${feature['cesium#estimatedHeight']} < 350 || ${feature['name']} === '롯데월드타워' || ${feature['name:en']} === 'Lotte World Tower'",
          }),
        });
        scene.primitives.add(this.tiles);
      } else if (opts.buildings === 'google') {
        this.tiles = await Cesium.createGooglePhotorealistic3DTileset();
        scene.primitives.add(this.tiles);
      }
      if (this.tiles) { this.tiles.maximumScreenSpaceError = Q.bldSse; this.tiles.cacheBytes = 256 * 1024 * 1024; }
    } catch (e) { console.warn('건물 불러오기 실패', e); }

    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.look = { h: 0, p: 0, r: 1, oh: 200 * DEG, op: 12 * DEG, or: 1 };
    this.mode = 'chase';
    this._carto = new Cesium.Cartographic();
    this._m4 = new Cesium.Matrix4();
    this.setupMouse();
    return this;
  }

  setTime(opt) {
    const clock = this.viewer.clock;
    let date = new Date();
    if (opt !== 'now') {
      const h = parseFloat(opt);
      // 한국 표준시(UTC+9) 기준 오늘 해당 시각
      const kst = new Date(Date.now() + 9 * 3600e3);
      date = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 0, 0, 0) + (h - 9) * 3600e3);
    }
    clock.currentTime = Cesium.JulianDate.fromDate(date);
    clock.shouldAnimate = true;
    clock.multiplier = 1;
  }

  // 성능: 해 위치 계산은 비싸므로 실시간 1초·위치 20km 단위로 재사용
  sunElevationCached(lat, lon) {
    const now = performance.now();
    const c = this._sunC;
    const simT = Cesium.JulianDate.toDate(this.viewer.clock.currentTime).getTime();
    if (c && now - c.t < 1000 && Math.abs(simT - c.simT) < 120e3 && Math.abs(lat - c.lat) < 0.003 && Math.abs(lon - c.lon) < 0.003) return c.v;
    const v = this.sunElevation(lat, lon);
    this._sunC = { t: now, simT, lat, lon, v };
    return v;
  }

  // 프레임 시간(ms)에 따라 렌더 해상도 자동 조절 (목표 약 40fps 이상)
  adaptResolution(frameMs) {
    const a = this._adapt || (this._adapt = { ema: 16, t: 0 });
    a.ema += (Math.min(frameMs, 200) - a.ema) * 0.05;
    const now = performance.now();
    if (now - a.t < 2500 || document.hidden) return;
    const v = this.viewer, g = this.scene.globe;
    const lo = this.Q.minScale * this.baseScale;
    let s = v.resolutionScale;
    if (a.ema > 30) {
      // 느리면: 해상도 먼저 낮추고, 최저에 닿으면 지형 세밀도를 낮춤
      if (s > lo + 1e-3) s = Math.max(lo, s - 0.1);
      else if (g.maximumScreenSpaceError < this.Q.sse * 2) g.maximumScreenSpaceError += 0.5;
      else return;
    } else if (a.ema < 19) {
      if (g.maximumScreenSpaceError > this.Q.sse) g.maximumScreenSpaceError = Math.max(this.Q.sse, g.maximumScreenSpaceError - 0.5);
      else if (s < this.baseScale - 1e-3) s = Math.min(this.baseScale, s + 0.1);
      else return;
    } else return;
    a.t = now;
    v.resolutionScale = Math.round(s * 100) / 100;
  }

  // 그림자: 화질이 허용하고 항공기가 지면 가까이 있을 때만 (멀면 보이지 않고 비용만 큼)
  setShadows(on) {
    const want = !!(on && this.Q.shadows);
    if (this.viewer.shadows !== want) this.viewer.shadows = want;
  }

  sunElevation(lat, lon) {
    const t = this.viewer.clock.currentTime;
    const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(t) || Cesium.Transforms.computeTemeToPseudoFixedMatrix(t);
    let sun = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t);
    sun = Cesium.Matrix3.multiplyByVector(icrfToFixed, sun, new Cesium.Cartesian3());
    const p = geodeticToEcef(lat, lon, 0);
    const { u } = enu(lat, lon);
    const dir = v3.norm(v3.sub([sun.x, sun.y, sun.z], p));
    return Math.asin(v3.dot(dir, u));
  }

  // ---------- 지형 ----------
  terrainHeight(lat, lon) {
    const c = this._carto;
    c.longitude = lon; c.latitude = lat; c.height = 0;
    return this.scene.globe.getHeight(c);
  }

  // ---------- 항공기 ----------
  async loadAircraft(url, meta) {
    if (this.model) { this.scene.primitives.remove(this.model); this.model = null; }
    const model = await Cesium.Model.fromGltfAsync({
      url, upAxis: Cesium.Axis.Z, forwardAxis: Cesium.Axis.X,
      shadows: this.opts.quality !== 'low' ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
      backFaceCulling: true,
    });
    this.scene.primitives.add(model);
    await new Promise((res) => { if (model.ready) res(); else model.readyEvent.addEventListener(res); });
    this.model = model;
    this._day = -1;
    this.meta = meta;
    this.anims = [];
    for (const a of meta?.animations || []) {
      try {
        const node = model.getNode(a.node);
        if (node) this.anims.push({ ...a, nodeName: a.node, node, orig: Cesium.Matrix4.clone(node.originalMatrix) });
      } catch (e) { /* 없는 노드 */ }
    }
    this.makeLights(meta);
    return model;
  }

  makeLights(meta) {
    this.points.removeAll();
    this.lights = [];
    const L = meta?.lights || {};
    const add = (key, color, size, kind) => {
      if (!L[key]) return;
      const pt = this.points.add({ position: Cesium.Cartesian3.ZERO, color, pixelSize: size, show: false,
        scaleByDistance: new Cesium.NearFarScalar(50, 1.4, 8000, 0.5) });
      this.lights.push({ pt, body: gltfToBody(L[key]), kind });
    };
    add('navL', Cesium.Color.fromCssColorString('#ff2a2a'), 5, 'nav');
    add('navR', Cesium.Color.fromCssColorString('#2aff5a'), 5, 'nav');
    add('tail', Cesium.Color.WHITE, 4, 'nav');
    add('beaconTop', Cesium.Color.fromCssColorString('#ff3030'), 6, 'beacon');
    add('beaconBottom', Cesium.Color.fromCssColorString('#ff3030'), 6, 'beacon');
    add('strobeL', Cesium.Color.WHITE, 8, 'strobe');
    add('strobeR', Cesium.Color.WHITE, 8, 'strobe');
    add('landingL', Cesium.Color.fromCssColorString('#fff6d8'), 9, 'landing');
    add('landingR', Cesium.Color.fromCssColorString('#fff6d8'), 9, 'landing');
  }

  bodyToWorld(fm, b) {
    const [bx, by, bz] = this._cols;
    return [
      fm.p[0] + bx[0] * b[0] + by[0] * b[1] + bz[0] * b[2],
      fm.p[1] + bx[1] * b[0] + by[1] * b[1] + bz[1] * b[2],
      fm.p[2] + bx[2] * b[0] + by[2] * b[1] + bz[2] * b[2],
    ];
  }

  updateAircraft(fm, sim, t) {
    this._cols = quat.toCols(fm.q);
    const [bx, by, bz] = this._cols;
    const p = fm.p;
    if (this.model) {
      const m = this._m4;
      // glTF 축(X 왼쪽, Y 위, Z 앞) → 몸체 (-y, -z, x)
      m[0] = -by[0]; m[1] = -by[1]; m[2] = -by[2]; m[3] = 0;
      m[4] = -bz[0]; m[5] = -bz[1]; m[6] = -bz[2]; m[7] = 0;
      m[8] = bx[0]; m[9] = bx[1]; m[10] = bx[2]; m[11] = 0;
      m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
      this.model.modelMatrix = m;
      this.animate(fm, sim);
    }
    // 조명
    const night = this.night;
    const low = fm.d.hMsl < 10000 * 0.3048;
    for (const l of this.lights || []) {
      let on = false;
      if (l.kind === 'nav') on = true;
      else if (l.kind === 'beacon') on = (t % 1.3) < 0.12;
      else if (l.kind === 'strobe') on = !fm.onGround || fm.lever > 0.5 ? (t % 1.2) < 0.06 || ((t % 1.2) > 0.16 && (t % 1.2) < 0.2) : false;
      else if (l.kind === 'landing') on = low && fm.gearDown && (night || fm.d.ra < 3000);
      l.pt.show = on && (night || l.kind !== 'nav');
      if (l.pt.show) l.pt.position = C3(this.bodyToWorld(fm, l.body));
    }
  }

  animate(fm, sim) {
    const ac = fm.ac;
    const maxDeg = ac.flaps[ac.flaps.length - 1].deg || 1;
    const i = Math.floor(fm.flapPos), f = fm.flapPos - i;
    const F = ac.flaps;
    const flapDeg = F[Math.min(i, F.length - 1)].deg * (1 - f) + (F[Math.min(i + 1, F.length - 1)].deg) * f;
    const inp = sim.input;
    const ap = sim.ap.ap;
    for (const a of this.anims) {
      let frac = 0;
      switch (a.kind) {
        case 'gear': frac = 1 - fm.gearPos; break;
        case 'flap': frac = flapDeg / maxDeg; break;
        case 'spoiler': frac = fm.spoiler; break;
        case 'aileron': {
          const right = /_R$/.test(a.nodeName || '');
          frac = clamp((fm.w[0] / (15 * DEG)) + (ap ? 0 : inp.roll * 0.4), -1, 1) * 0.6 * (right ? -1 : 1);
          break;
        }
        case 'elevator': frac = clamp(-(fm.w[1] / (6 * DEG)) - (ap ? 0 : inp.pitch * 0.6), -1, 1) * 0.5; break;
        case 'rudder': frac = clamp(-inp.yaw, -1, 1) * 0.6; break;
      }
      if (a.last != null && Math.abs(a.last - frac) < 0.002) continue;   // 변화 없으면 건너뜀
      a.last = frac;
      const ang = (a.angle * DEG) * frac;
      const q = Cesium.Quaternion.fromAxisAngle(a.axisC || (a.axisC = new Cesium.Cartesian3(a.axis[0], a.axis[1], a.axis[2])), ang, SQ);
      const r = Cesium.Matrix4.fromRotationTranslation(Cesium.Matrix3.fromQuaternion(q, SM3), Cesium.Cartesian3.ZERO, SM4);
      a.node.matrix = Cesium.Matrix4.multiply(a.orig, r, a.mat || (a.mat = new Cesium.Matrix4()));
      if (a.kind === 'gear') a.node.show = frac < 0.995;
    }
  }

  // ---------- 카메라 ----------
  setupMouse() {
    const el = this.viewer.canvas;
    let drag = null;
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      if (this.mode === 'cockpit') {
        this.look.h = clamp(this.look.h + dx * 0.25 * DEG, -150 * DEG, 150 * DEG);
        this.look.p = clamp(this.look.p - dy * 0.25 * DEG, -60 * DEG, 60 * DEG);
      } else if (this.mode === 'orbit') {
        this.look.oh += dx * 0.4 * DEG;
        this.look.op = clamp(this.look.op + dy * 0.3 * DEG, -10 * DEG, 85 * DEG);
      } else if (this.mode === 'chase') {
        this.look.h += dx * 0.4 * DEG;
        this.look.p = clamp(this.look.p + dy * 0.3 * DEG, -10 * DEG, 70 * DEG);
      }
    });
    const end = () => { drag = null; if (this.mode === 'cockpit') this.recenter = true; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = Math.exp(e.deltaY * 0.0012);
      if (this.mode === 'orbit') this.look.or = clamp(this.look.or * k, 0.25, 30);
      else if (this.mode === 'chase') this.look.r = clamp(this.look.r * k, 0.4, 8);
      else if (this.mode === 'tower') this.look.tz = clamp((this.look.tz || 1) / k, 0.3, 8);
    }, { passive: false });
    el.addEventListener('dblclick', () => { this.look.h = 0; this.look.p = 0; });
  }

  setMode(mode, fm) {
    this.mode = mode;
    this.look.h = 0; this.look.p = 0;
    if (mode === 'orbit') { this.look.oh = fm.d.psi + 200 * DEG; this.look.op = 14 * DEG; this.look.or = 1; }
    this.chaseHdg = fm.d.psi;
    this.camera.frustum.fov = (mode === 'cockpit' ? 72 : 60) * DEG;
    document.body.classList.toggle('cockpit', mode === 'cockpit');
    document.getElementById('cockpit-frame').hidden = mode !== 'cockpit';
  }

  updateCamera(dt, fm, tower) {
    const d = fm.d;
    const L = fm.ac.dims.length;
    const cam = this.camera;
    const { e, n, u } = enu(d.lat, d.lon);
    let pos, dir, up;
    if (this.mode === 'cockpit') {
      const eye = this.meta?.pilotEye ? gltfToBody(this.meta.pilotEye) : [L * 0.45, -0.5, -1.2];
      pos = this.bodyToWorld(fm, eye);
      const [bx, by, bz] = this._cols;
      if (this.recenter && Math.abs(this.look.h) + Math.abs(this.look.p) > 0.001) {
        this.look.h *= Math.exp(-dt * 0); this.look.p *= Math.exp(-dt * 0);
      }
      const ch = Math.cos(this.look.h), sh = Math.sin(this.look.h);
      const cp = Math.cos(this.look.p - 4 * DEG), sp = Math.sin(this.look.p - 4 * DEG);
      // 몸체 기준 시선: 앞(x) + 오른쪽(y) 회전, 위(-z) 올려보기
      const fwd = v3.add(v3.scale(bx, ch), v3.scale(by, sh));
      dir = v3.norm(v3.add(v3.scale(fwd, cp), v3.scale(bz, -sp)));
      up = v3.norm(v3.sub(v3.scale(bz, -1), v3.scale(dir, v3.dot(v3.scale(bz, -1), dir))));
    } else if (this.mode === 'tower' && tower) {
      pos = geodeticToEcef(tower.lat, tower.lon, tower.h);
      const target = fm.p;
      dir = v3.norm(v3.sub(target, pos));
      const tu = enu(tower.lat, tower.lon).u;
      up = v3.norm(v3.sub(tu, v3.scale(dir, v3.dot(tu, dir))));
      const dist = v3.len(v3.sub(target, pos));
      const fov = clamp(2 * Math.atan((L * 2.2) / dist) / (this.look.tz || 1), 1.2 * DEG, 60 * DEG);
      cam.frustum.fov = fov;
    } else {
      let hdg, pitch, range;
      if (this.mode === 'orbit') {
        hdg = this.look.oh; pitch = this.look.op; range = L * 1.6 * this.look.or;
      } else {
        const target = d.gs > 20 ? d.track : d.psi;
        this.chaseHdg = (this.chaseHdg ?? target) + angDiff(target, this.chaseHdg ?? target) * (1 - Math.exp(-dt * 1.8));
        hdg = this.chaseHdg + this.look.h; pitch = 9 * DEG + this.look.p; range = L * 1.55 * this.look.r;
      }
      const hv = v3.add(v3.scale(n, Math.cos(hdg)), v3.scale(e, Math.sin(hdg)));
      const tgt = v3.madd(fm.p, u, L * 0.06);
      pos = v3.add(tgt, v3.add(v3.scale(hv, -range * Math.cos(pitch)), v3.scale(u, range * Math.sin(pitch))));
      // 지형 아래로 들어가지 않게
      const g = ecefToGeodetic(pos);
      const gh = this.terrainHeight(g.lat, g.lon);
      if (gh != null && g.h < gh + 3) pos = geodeticToEcef(g.lat, g.lon, gh + 3);
      dir = v3.norm(v3.sub(tgt, pos));
      up = v3.norm(v3.sub(u, v3.scale(dir, v3.dot(u, dir))));
    }
    cam.setView({ destination: C3(pos), orientation: { direction: C3(dir), up: C3(up) } });
  }

  // ---------- 활주로 등화 (밤에만) ----------
  makeRunwayLights(runways) {
    if (this.rwyLights) return;
    const col = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.rwyLights = col;
    const done = new Set();
    const C = (css) => Cesium.Color.fromCssColorString(css);
    const white = C('#fff2cf'), green = C('#35ff6b'), red = C('#ff3030'), amber = C('#ffc34d');
    const sbd = new Cesium.NearFarScalar(300, 1.0, 20000, 0.35);
    const hAt = (g, s) => { const P = g.profile; return P[0].h + (P[1].h - P[0].h) * (s / g.len); };
    const put = (g, s, off, color, size = 3) => {
      const p = destPoint(g.endLat, g.endLon, g.crs, s);
      const q = off ? destPoint(p.lat, p.lon, g.crs + Math.PI / 2, off) : p;
      const h = hAt(g, Math.max(0, Math.min(g.len, s))) + 0.6;
      col.add({ position: C3(geodeticToEcef(q.lat, q.lon, h)), color, pixelSize: size, scaleByDistance: sbd });
    };
    for (const g of runways) {
      if (!g.profile) continue;
      const key = g.icao + g.rwyId;
      const half = g.width / 2 + 1.5;
      if (!done.has(key)) {
        done.add(key);
        for (let s = 0; s <= g.len; s += 60) { put(g, s, -half, g.len - s < 600 ? amber : white); put(g, s, half, s < 600 ? amber : white); }
        for (let s = 30; s < g.len; s += 30) put(g, s, 0, g.len - s < 300 || s < 300 ? red : white, 2.5);
      }
      // 시단(녹색)·끝(적색) — 끝 방향마다
      for (let o = -half; o <= half; o += 4) put(g, g.disp, o, green, 3);
      // 진입등 (900m, 30m 간격 막대)
      for (let s = 30; s <= 900; s += 30) for (const o of [-6, -3, 0, 3, 6]) put(g, -s, o, s % 300 === 0 ? white : C('#fff7e0'), s % 300 === 0 ? 3.5 : 2.5);
    }
    col.show = false;
  }

  // ---------- PAPI (진입각 지시등) ----------
  makePapi(g) {
    if (this.papi) for (const p of this.papi) this.points.remove(p.pt);
    this.papi = [];
    const side = -(g.width / 2 + 15);   // 왼쪽
    const along = 300;
    const angs = [3.5, 3.1667, 2.8333, 2.5]; // 활주로에 가까운 것부터
    for (let i = 0; i < 4; i++) {
      const off = side - i * 9;
      const a = destPoint(g.lat, g.lon, g.crs, along);
      const b = destPoint(a.lat, a.lon, g.crs + Math.PI / 2, off);
      const h = (g.profile ? g.h0 : 0) + 1.2;
      const pos = geodeticToEcef(b.lat, b.lon, h);
      const pt = this.points.add({ position: C3(pos), pixelSize: 7, color: Cesium.Color.WHITE,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.3, 15000, 0.6) });
      this.papi.push({ pt, pos, ang: angs[i] * DEG, lat: b.lat, lon: b.lon });
    }
  }

  updatePapi() {
    if (!this.papi) return;
    const c = this.camera.positionWC;
    const cp = [c.x, c.y, c.z];
    for (const p of this.papi) {
      const { u } = enu(p.lat, p.lon);
      const dv = v3.sub(cp, p.pos);
      const el = Math.asin(clamp(v3.dot(dv, u) / (v3.len(dv) || 1), -1, 1));
      p.pt.color = el > p.ang ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString('#ff2020');
    }
  }
}
