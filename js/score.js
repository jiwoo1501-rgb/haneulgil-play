// 착륙 평가 (100점)
import { DEG, KT } from './geo.js?v=202609291314';
import { rwyRel } from './nav.js?v=202609291314';

const band = (v, steps) => { for (const [lim, pts] of steps) if (v <= lim) return pts; return 0; };

export function scoreLanding(td, rwy, vref, tailStruck) {
  const r = rwyRel(rwy, td.lat, td.lon);
  const fpm = td.fpm;
  const items = [];
  const sink = band(fpm, [[120, 40], [240, 36], [360, 30], [480, 22], [600, 14], [800, 6]]);
  items.push(['침하율', `${Math.round(fpm)} ft/min`, sink, 40]);
  const along = r.along;
  const pos = along >= 250 && along <= 650 ? 20 : along >= 150 && along <= 900 ? 14 : along >= 0 && along <= 1200 ? 7 : 0;
  items.push(['접지 위치 (시단 후)', `${Math.round(along)} m`, pos, 20]);
  const cl = band(Math.abs(r.cross), [[1.5, 20], [4, 16], [8, 10], [15, 4]]);
  items.push(['중심선 이탈', `${Math.abs(r.cross).toFixed(1)} m`, cl, 20]);
  const dv = td.cas / KT - vref / KT;
  const spd = band(Math.abs(dv - 3), [[6, 10], [11, 7], [16, 4]]);
  items.push(['속도 (VREF 대비)', `${dv >= 0 ? '+' : ''}${Math.round(dv)} kt`, spd, 10]);
  const th = td.theta / DEG, ph = Math.abs(td.phi / DEG);
  let att = th >= 2 && th <= 7.5 && ph < 2 ? 10 : th >= 0 && th <= 9 && ph < 4 ? 6 : 2;
  if (tailStruck || td.noseFirst) att = 0;
  items.push(['자세 (피치/경사)', `${th.toFixed(1)}° / ${ph.toFixed(1)}°`, att, 10]);
  let total = items.reduce((a, b) => a + b[2], 0);
  const notes = [];
  if (tailStruck) { total = Math.max(0, total - 15); notes.push('꼬리 긁힘 (−15)'); }
  if (td.noseFirst) notes.push('앞바퀴 먼저 닿음');
  if (td.surface !== 'runway') notes.push('활주로 밖 접지');
  const grade = total >= 90 ? '완벽' : total >= 75 ? '훌륭함' : total >= 60 ? '좋음' : total >= 40 ? '보통' : '거친 착륙';
  return { total, grade, items, notes, along, cross: r.cross };
}
