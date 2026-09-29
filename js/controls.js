// 조작 입력: 키보드 · 게임패드 · 터치
import { clamp } from './geo.js?v=202609291314';

export class Controls {
  constructor(onAction) {
    this.onAction = onAction;        // (name, arg) => void
    this.keys = new Set();
    this.inp = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
    this.touch = { pitch: 0, roll: 0, active: false };
    this.enabled = false;
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.padPrev = {};
  }

  keydown(e) {
    if (!this.enabled) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const k = e.code;
    const flight = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'PageUp', 'PageDown', 'Slash', 'F1'];
    if (flight.includes(k)) e.preventDefault();
    if (e.repeat && !['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'PageUp', 'PageDown'].includes(k)) { this.keys.add(k); return; }
    this.keys.add(k);
    const A = this.onAction;
    switch (k) {
      case 'KeyF': case 'BracketRight': A('flaps', 1); break;
      case 'KeyV': case 'BracketLeft': A('flaps', -1); break;
      case 'KeyG': A('gear'); break;
      case 'KeyP': A('parking'); break;
      case 'KeyR': A('reverse'); break;
      case 'Slash': A('speedbrake'); break;
      case 'KeyZ': A('ap'); break;
      case 'KeyX': A('at'); break;
      case 'KeyY': A('auto'); break;
      case 'KeyL': A('app'); break;
      case 'KeyK': A('autobrake'); break;
      case 'KeyC': A('view'); break;
      case 'Digit1': A('view', 'cockpit'); break;
      case 'Digit2': A('view', 'chase'); break;
      case 'Digit3': A('view', 'orbit'); break;
      case 'Digit4': A('view', 'tower'); break;
      case 'KeyT': A('timescale', e.shiftKey ? -1 : 1); break;
      case 'KeyH': A('hidepanel'); break;
      case 'Escape': A('pause'); break;
      case 'F1': A('help'); break;
      case 'Equal': case 'NumpadAdd': case 'PageUp': A('throttle', 0.04); break;
      case 'Minus': case 'NumpadSubtract': case 'PageDown': A('throttle', -0.04); break;
      case 'Home': A('lever', 1); break;
      case 'End': A('lever', 0); break;
    }
  }

  // 매 프레임: 키 누름을 부드러운 조종간 값으로
  update(dt) {
    const K = this.keys;
    const fine = K.has('ShiftLeft') || K.has('ShiftRight') ? 0.35 : 1;
    const axis = (neg, pos) => (pos.some((c) => K.has(c)) ? 1 : 0) - (neg.some((c) => K.has(c)) ? 1 : 0);
    const ramp = (cur, target, up, down) => {
      const r = target === 0 ? down : Math.sign(target) !== Math.sign(cur) && cur !== 0 ? down : up;
      const d = target - cur;
      return cur + clamp(d, -r * dt, r * dt);
    };
    const kp = axis(['ArrowUp', 'KeyW'], ['ArrowDown', 'KeyS']) * fine;
    const kr = axis(['ArrowLeft', 'KeyA'], ['ArrowRight', 'KeyD']) * fine;
    const ky = axis(['KeyQ'], ['KeyE']);
    const i = this.inp;
    i.pitch = ramp(i.pitch, kp, 2.2, 6);
    i.roll = ramp(i.roll, kr, 3, 7);
    i.yaw = ramp(i.yaw, ky, 2.5, 5);
    i.brake = K.has('KeyB') || K.has('Period') ? 1 : 0;

    // 게임패드
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const ax = p.axes;
      if (Math.abs(ax[0]) > 0.08 || Math.abs(ax[1]) > 0.08) { i.roll = dz(ax[0]); i.pitch = dz(ax[1]); }
      if (ax.length > 2 && Math.abs(ax[2]) > 0.1) i.yaw = dz(ax[2]);
      const b = (n) => p.buttons[n] && p.buttons[n].pressed;
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      if (rt > 0.05) this.onAction('throttle', rt * 0.5 * dt);
      if (lt > 0.05) this.onAction('throttle', -lt * 0.5 * dt);
      const edge = (n, name, arg) => { if (b(n) && !this.padPrev[n]) this.onAction(name, arg); this.padPrev[n] = b(n); };
      edge(0, 'gear'); edge(2, 'flaps', -1); edge(3, 'flaps', 1); edge(4, 'view'); edge(5, 'ap'); edge(9, 'pause');
      if (b(1)) i.brake = 1;
      break;
    }
    // 터치
    if (this.touch.active) { i.pitch = this.touch.pitch; i.roll = this.touch.roll; }
    return i;
  }

  // 터치 조종간·추력 슬라이더
  setupTouch(getLever) {
    const stick = document.getElementById('stick'), knob = document.getElementById('stick-knob');
    const move = (e) => {
      const r = stick.getBoundingClientRect();
      const x = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
      const y = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
      knob.style.transform = `translate(${x * 45}px, ${y * 45}px)`;
      this.touch.roll = x; this.touch.pitch = y;
    };
    stick.addEventListener('pointerdown', (e) => { this.touch.active = true; stick.setPointerCapture(e.pointerId); move(e); });
    stick.addEventListener('pointermove', (e) => { if (this.touch.active) move(e); });
    const up = () => { this.touch.active = false; this.touch.pitch = 0; this.touch.roll = 0; knob.style.transform = ''; };
    stick.addEventListener('pointerup', up); stick.addEventListener('pointercancel', up);

    const sl = document.getElementById('thr-slider');
    let dragging = false;
    const set = (e) => {
      const r = sl.getBoundingClientRect();
      const v = clamp(1 - (e.clientY - r.top - 13) / (r.height - 26), 0, 1);
      this.onAction('lever', v);
    };
    sl.addEventListener('pointerdown', (e) => { dragging = true; sl.setPointerCapture(e.pointerId); set(e); });
    sl.addEventListener('pointermove', (e) => { if (dragging) set(e); });
    sl.addEventListener('pointerup', () => { dragging = false; });
    this.updateTouchUi = () => {
      const v = getLever();
      document.getElementById('thr-handle').style.bottom = `calc(${v * 100}% - ${v * 26}px)`;
      document.getElementById('thr-fill').style.height = `${v * 100}%`;
    };
    for (const b of document.querySelectorAll('#touch-btns button')) {
      const a = b.dataset.a;
      if (a === 'brake') {
        b.addEventListener('pointerdown', () => this.keys.add('KeyB'));
        b.addEventListener('pointerup', () => this.keys.delete('KeyB'));
        b.addEventListener('pointerleave', () => this.keys.delete('KeyB'));
      } else {
        b.addEventListener('click', () => {
          if (a === 'gear') this.onAction('gear');
          else if (a === 'flaps+') this.onAction('flaps', 1);
          else if (a === 'flaps-') this.onAction('flaps', -1);
          else if (a === 'rev') this.onAction('reverse');
          else if (a === 'auto') this.onAction('auto');
        });
      }
    }
  }
}
