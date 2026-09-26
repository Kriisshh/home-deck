import { AirConditioner } from './lib/ac.js';
import { PcAgent, parseWakeDevices, sendWake } from './lib/agent.js';
import { load, loadSettings, onChange, save, saveSettings } from './lib/store.js';
import * as updater from './lib/updater.js';
import { DeckEditor, iconFor } from './lib/deck-editor.js';
import { NotSignedIn, XiaomiCloud, acModelFromSpec } from './lib/xiaomi.js';

const $ = (id) => document.getElementById(id);
const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const DEMO = new URLSearchParams(location.search).has('demo');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let settings;
let agent = new PcAgent();
let ac = null;

// ======================================================================= helpers

// Idle mode: after a minute without touching the panel, check the PC and AC less often.
let lastInteraction = Date.now();
const isIdle = () => Date.now() - lastInteraction > 60000;
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    const wasIdle = isIdle();
    lastInteraction = Date.now();
    if (wasIdle && typeof pollPc === 'function') { pollPc(); pollAc(); } // refresh right away on wake
  }, { capture: true, passive: true });
}

let toastTimer = 0;
function toast(message, isError = false) {
  const el = $('toast');
  $('toast-text').textContent = message;
  el.querySelector('use').setAttribute('href', isError ? '#i-alert' : '#i-check');
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4000 : 2000);
}

const setPill = (id, state) => { if ($(id).dataset.state !== state) $(id).dataset.state = state; };

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtTemp = (t) => (t == null ? '--' : (Math.round(t * 10) / 10).toString());

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function tickClock() {
  const now = new Date();
  $('time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function applyAppearance() {
  const root = document.documentElement;
  if (settings.appearance === 'light' || settings.appearance === 'dark') root.dataset.theme = settings.appearance;
  else delete root.dataset.theme;
  root.toggleAttribute('data-solid', !!settings.reduceTransparency);
}

/** Control Center style horizontal slider (drag or tap anywhere; arrow keys when focused). */
function makeSlider(node, { min = 0, max = 100, step = 1, onInput, onChange } = {}) {
  let value = min;
  let dragging = false;
  const show = (v) => {
    value = clamp(Math.round(v / step) * step, min, max);
    node.style.setProperty('--val', max > min ? (value - min) / (max - min) : 0);
    node.setAttribute('aria-valuenow', value);
  };
  const fromEvent = (e) => {
    const r = node.getBoundingClientRect();
    return min + clamp((e.clientX - r.left) / r.width, 0, 1) * (max - min);
  };
  const disabled = () => node.getAttribute('aria-disabled') === 'true';
  node.addEventListener('pointerdown', (e) => {
    if (disabled()) return;
    dragging = true;
    node.setPointerCapture(e.pointerId);
    node.classList.add('active');
    show(fromEvent(e));
    onInput?.(value);
  });
  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const before = value;
    show(fromEvent(e));
    if (value !== before) onInput?.(value);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('active');
    onChange?.(value);
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('keydown', (e) => {
    const delta = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step }[e.key];
    if (delta === undefined || disabled()) return;
    e.preventDefault();
    e.stopPropagation(); // keep global shortcuts out of it
    show(value + delta);
    onInput?.(value);
    onChange?.(value);
  });
  return {
    get dragging() { return dragging; },
    set(v) { if (!dragging) show(v); },
    range(lo, hi, st = step) { min = lo; max = hi; step = st; node.setAttribute('aria-valuemin', lo); node.setAttribute('aria-valuemax', hi); show(value); },
  };
}

// ======================================================================= air conditioner

const AC = { pendingTarget: null, pendingUntil: 0, pendingTimer: 0, pollTimer: 0, error: null, fanSlider: null };
const TOGGLE_ICONS = {
  vswing: 'swing', hswing: 'swing', 'air-conditioner.eco': 'leaf', 'air-conditioner.sleep-mode': 'moon',
  'air-conditioner.heater': 'flame', 'air-conditioner.dryer': 'sparkles', 'air-conditioner.un-straight-blowing': 'fan_only',
  'indicator-light.on': 'bulb', 'alarm.alarm': 'bell',
};

function modeKey(label = '') {
  const l = label.toLowerCase();
  if (l.includes('cool')) return 'cool';
  if (l.includes('heat')) return 'heat';
  if (l.includes('dry') || l.includes('dehumid')) return 'dry';
  if (l.includes('fan') || l.includes('wind') || l.includes('vent')) return 'fan_only';
  return 'auto';
}
const MODE_WORD = { cool: 'Cooling', heat: 'Heating', dry: 'Drying', fan_only: 'Fan only', auto: 'Auto' };

async function initAc() {
  clearTimeout(AC.pollTimer);
  ac = null;
  AC.error = null;
  if (DEMO) {
    ac = demoAirConditioner();
  } else if (settings.acDid && settings.acModel) {
    try {
      ac = await AirConditioner.fromSettings(settings);
    } catch (err) {
      AC.error = err.message;
    }
  }
  buildAcControls();
  pollAc();
}

function scheduleAcPoll(ms) {
  clearTimeout(AC.pollTimer);
  AC.pollTimer = setTimeout(pollAc, ms);
}

async function pollAc() {
  clearTimeout(AC.pollTimer);
  if (!ac) {
    setPill('pill-mi', AC.error ? 'error' : 'off');
    renderAc();
    return;
  }
  if (document.hidden) return; // resumes on visibilitychange
  try {
    await ac.refresh();
    AC.error = ac.online ? null : 'Offline in Mi Home';
    setPill('pill-mi', ac.online ? 'on' : 'error');
  } catch (err) {
    AC.error = err.message;
    setPill('pill-mi', 'error');
  }
  renderAc();
  scheduleAcPoll(AC.error ? 20000 : isIdle() ? 30000 : 10000);
}

function setFanLabel(text) {
  $('ac-fan-label').textContent = text;
  $('ac-fan-label-fill').textContent = text;
}

function fanLevels() {
  return ac ? ac.fanOptions().filter((o) => !/auto/i.test(o.label)) : [];
}

function buildAcControls() {
  $('climate').dataset.ready = String(!!ac);
  $('ac-name').textContent = settings.acName || 'Air Conditioner';
  const modes = $('ac-modes');
  const extras = $('ac-extras');
  modes.replaceChildren();
  extras.replaceChildren();
  if (!ac) return;
  const m = ac.model;

  for (const opt of m.mode?.options ?? []) {
    const key = modeKey(opt.label);
    modes.append(el('button', {
      type: 'button', 'aria-pressed': 'false', dataset: { value: opt.value },
      onclick: () => acDo(() => ac.setMode(opt.value)),
    }, icon(key), opt.label));
  }
  modes.hidden = !m.mode;

  const levels = fanLevels();
  $('ac-fan-row').hidden = !m.fan;
  $('ac-fan-auto').hidden = levels.length === ac.fanOptions().length;
  AC.fanSlider.range(0, Math.max(1, levels.length), 1); // 0 = Auto

  const toggle = (key, label) => el('div', { class: 'toggle' },
    el('button', {
      type: 'button', class: 'cc-toggle', 'aria-pressed': 'false', 'aria-label': label, dataset: { key },
      onclick: () => acDo(() => ac.set({ [key]: !ac.state[key] })),
    }, icon(TOGGLE_ICONS[key] || 'power')), label);
  if (m.vswing?.writable) extras.append(toggle('vswing', 'Swing'));
  if (m.hswing?.writable) extras.append(toggle('hswing', 'Side Swing'));
  for (const t of m.toggles) extras.append(toggle(t.key, t.label));
}

function renderAc() {
  const card = $('climate');
  card.dataset.ready = String(!!ac);
  if (!ac) {
    $('ac-sub').textContent = AC.error || 'Not set up';
    return;
  }
  const s = ac.state;
  const m = ac.model;
  const on = !!s.power;
  const modeOpt = m.mode?.options?.find((o) => o.value === s.mode);
  const mode = modeOpt ? modeKey(modeOpt.label) : 'auto';
  card.dataset.power = on ? 'on' : 'off';
  card.dataset.mode = mode;
  $('ac-head-icon').querySelector('use').setAttribute('href', `#i-${mode}`);
  $('ac-power').setAttribute('aria-pressed', String(on));

  // Target temperature: a value being dialled in wins over the last reported one
  if (AC.pendingTarget != null && (s.target === AC.pendingTarget || Date.now() > AC.pendingUntil)) AC.pendingTarget = null;
  const target = AC.pendingTarget ?? s.target;
  $('ac-sub').textContent = AC.error || (on ? `${MODE_WORD[mode]} to ${fmtTemp(target)}°` : 'Off');
  $('ac-action').textContent = on ? (modeOpt?.label ?? 'On') : 'Off';
  $('ac-target').textContent = fmtTemp(target);
  $('ac-target').parentElement.classList.toggle('pending', AC.pendingTarget != null);
  drawDial(target);
  $('ac-room').textContent = s.room != null ? `Indoor ${fmtTemp(s.room)}°` : 'Indoor --';
  const [min, max] = m.target?.range ?? [16, 31];
  $('ac-down').disabled = !on || (target != null && target <= min);
  $('ac-up').disabled = !on || (target != null && target >= max);
  $('ac-dial').setAttribute('aria-disabled', String(!on));
  $('ac-fan').setAttribute('aria-disabled', String(!on));
  $('ac-fan-auto').disabled = !on;

  // Fan
  const levels = fanLevels();
  const isAuto = ac.fanOptions().some((o) => o.value === s.fan && /auto/i.test(o.label));
  const levelIdx = levels.findIndex((o) => o.value === s.fan);
  if (!AC.fanSlider.dragging) AC.fanSlider.set(isAuto ? 0 : levelIdx + 1);
  setFanLabel(isAuto ? 'Fan · Auto' : levelIdx >= 0 ? `Fan · ${levelIdx + 1} of ${levels.length}` : 'Fan');
  $('ac-fan-auto').setAttribute('aria-pressed', String(isAuto));

  for (const b of $('ac-modes').children) b.setAttribute('aria-pressed', String(Number(b.dataset.value) === s.mode));
  for (const b of $('ac-extras').querySelectorAll('.cc-toggle')) b.setAttribute('aria-pressed', String(!!s[b.dataset.key]));

  const stats = [];
  if (s.humidity != null) stats.push(['Humidity', `${s.humidity}%`]);
  if (s.watts != null) stats.push(['Power', `${Math.round(s.watts)} W`]);
  if (s.energy != null) stats.push(['Used', `${(Math.round(s.energy * 100) / 100).toFixed(2)} kWh`]);
  $('ac-stats').replaceChildren(...stats.map(([k, v]) => el('span', {}, `${k} `, el('b', {}, v))));
}

const DIAL = { R: 100, C: 120, ARC: 471.24, CIRC: 628.32 };

function tempRange() {
  return ac?.model.target?.range ?? [16, 31, 0.5];
}

function drawDial(target) {
  const [min, max] = tempRange();
  const frac = target == null ? 0 : clamp((target - min) / (max - min), 0, 1);
  $('ac-arc').style.strokeDasharray = `${(frac * DIAL.ARC).toFixed(1)} ${DIAL.CIRC}`;
  const angle = ((135 + frac * 270) * Math.PI) / 180;
  $('ac-knob').setAttribute('cx', (DIAL.C + DIAL.R * Math.cos(angle)).toFixed(1));
  $('ac-knob').setAttribute('cy', (DIAL.C + DIAL.R * Math.sin(angle)).toFixed(1));
}

function setPendingTarget(value, commitDelay) {
  AC.pendingTarget = ac.clampTemp(value);
  AC.pendingUntil = Date.now() + 10000;
  renderAc();
  clearTimeout(AC.pendingTimer);
  clearTimeout(AC.pollTimer); // don't let a poll overwrite the value being dialled in
  if (commitDelay == null) return;
  AC.pendingTimer = setTimeout(async () => {
    const value = AC.pendingTarget;
    if (value == null) return;
    try {
      await ac.set({ target: value });
      AC.pendingUntil = Date.now() + 4000;
    } catch (err) {
      AC.pendingTarget = null;
      toast(`AC: ${err.message}`, true);
    }
    renderAc();
    scheduleAcPoll(2000);
  }, commitDelay);
}

function nudgeTemp(direction) {
  if (!ac) return openSettings();
  if (!ac.state.power) return toast('The AC is off - turn it on first', true);
  setPendingTarget((AC.pendingTarget ?? ac.state.target ?? 26) + direction * ac.tempStep, 650);
}

/** Drag the knob around the ring (Home app thermostat). */
function wireDial() {
  const dial = $('ac-dial');
  let dragging = false;
  const valueAt = (e) => {
    const r = dial.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    let rel = ((Math.atan2(y, x) * 180) / Math.PI - 135 + 720) % 360;
    if (rel > 270) rel = rel > 315 ? 0 : 270;
    const [min, max] = tempRange();
    return { temp: min + (rel / 270) * (max - min), dist: Math.hypot(x, y) / (r.width / 2) };
  };
  dial.addEventListener('pointerdown', (e) => {
    if (!ac || !ac.state.power) return;
    const { temp, dist } = valueAt(e);
    if (dist < 0.6) return; // taps on the number in the middle don't move the setpoint
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    dial.classList.add('dragging');
    setPendingTarget(temp);
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const next = ac.clampTemp(valueAt(e).temp);
    if (next !== AC.pendingTarget) setPendingTarget(next);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    dial.classList.remove('dragging');
    setPendingTarget(AC.pendingTarget, 100);
  };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('keydown', (e) => {
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    nudgeTemp(dir);
  });
}

function wireFan() {
  const optionAt = (v) => (v === 0 ? ac.fanOptions().find((o) => /auto/i.test(o.label)) ?? fanLevels()[0] : fanLevels()[v - 1]);
  AC.fanSlider = makeSlider($('ac-fan'), {
    min: 0, max: 7, step: 1,
    onInput: (v) => {
      if (!ac) return;
      const opt = optionAt(v);
      setFanLabel(/auto/i.test(opt?.label ?? '') ? 'Fan · Auto' : `Fan · ${Math.max(1, v)} of ${fanLevels().length}`);
    },
    onChange: (v) => {
      const opt = ac && optionAt(v);
      if (opt && opt.value !== ac.state.fan) acDo(() => ac.set({ fan: opt.value }));
    },
  });
  $('ac-fan-auto').addEventListener('click', () => {
    if (!ac) return;
    const auto = ac.fanOptions().find((o) => /auto/i.test(o.label));
    const isAuto = auto && ac.state.fan === auto.value;
    const next = isAuto ? fanLevels()[Math.floor(fanLevels().length / 2)] : auto;
    if (next) acDo(() => ac.set({ fan: next.value }));
  });
}

async function acDo(fn) {
  if (!ac) return openSettings();
  try {
    await fn();
  } catch (err) {
    toast(err instanceof NotSignedIn ? err.message : `AC: ${err.message}`, true);
  }
  renderAc();
  scheduleAcPoll(1500);
}

function demoAirConditioner() {
  const spec = { services: [
    { iid: 2, type: 'urn:miot-spec-v2:service:air-conditioner:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:on:1', format: 'bool', access: ['read', 'write'] },
      { iid: 2, type: 'urn:miot-spec-v2:property:mode:1', format: 'uint8', access: ['read', 'write'], 'value-list': [
        { value: 2, description: 'Cool' }, { value: 3, description: 'Dry' }, { value: 4, description: 'Fan' }, { value: 5, description: 'Heat' }] },
      { iid: 4, type: 'urn:miot-spec-v2:property:target-temperature:1', format: 'float', access: ['read', 'write'], 'value-range': [16, 31, 0.5] },
      { iid: 7, type: 'urn:miot-spec-v2:property:eco:1', format: 'bool', access: ['read', 'write'] },
      { iid: 11, type: 'urn:miot-spec-v2:property:sleep-mode:1', format: 'bool', access: ['read', 'write'] },
      { iid: 10, type: 'urn:miot-spec-v2:property:dryer:1', format: 'bool', access: ['read', 'write'] },
      { iid: 15, type: 'urn:miot-spec-v2:property:un-straight-blowing:1', format: 'bool', access: ['read', 'write'] }] },
    { iid: 3, type: 'urn:miot-spec-v2:service:fan-control:1', properties: [
      { iid: 2, type: 'urn:miot-spec-v2:property:fan-level:1', format: 'uint8', access: ['read', 'write'], 'value-list': [
        { value: 0, description: 'Auto' }, ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, description: `Level${n}` }))] },
      { iid: 4, type: 'urn:miot-spec-v2:property:vertical-swing:1', format: 'bool', access: ['read', 'write'] }] },
    { iid: 4, type: 'urn:miot-spec-v2:service:environment:1', properties: [
      { iid: 7, type: 'urn:miot-spec-v2:property:temperature:1', format: 'float', access: ['read'] },
      { iid: 9, type: 'urn:miot-spec-v2:property:relative-humidity:1', format: 'uint8', access: ['read'] }] },
    { iid: 6, type: 'urn:miot-spec-v2:service:indicator-light:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:on:1', format: 'bool', access: ['read', 'write'] }] },
    { iid: 20, type: 'urn:miot-spec-v2:service:power-consumption:1', properties: [
      { iid: 1, type: 'urn:miot-spec-v2:property:power-consumption:1', format: 'float', access: ['read'] }] },
  ] };
  const fake = new AirConditioner(null, 'demo', acModelFromSpec(spec));
  const state = { power: true, mode: 2, target: 24, fan: 3, vswing: true, room: 28.6, humidity: 58, energy: 12.37,
    'air-conditioner.eco': false, 'indicator-light.on': true };
  fake.refresh = async () => { fake.online = true; fake.state = { ...state }; return fake.state; };
  fake.set = async (changes) => { await new Promise((r) => setTimeout(r, 150)); Object.assign(state, changes); Object.assign(fake.state, changes); };
  if (!settings.acName) settings.acName = 'Bedroom AC';
  return fake;
}

// ======================================================================= PC: now playing, volume, shortcuts

const PC = {
  online: false, failures: 0, pollTimer: 0, media: null, receivedAt: 0, artKey: undefined, artUrl: null,
  volTarget: 'app', volHoldUntil: 0, volSlider: null, volSendTimer: 0, progressTimer: 0,
  actions: [], actionsAt: 0, wakingUntil: 0, name: null, offlineReason: '',
};

function initPc() {
  clearTimeout(PC.pollTimer);
  agent = new PcAgent(settings.agentUrl, settings.agentToken);
  PC.online = false;
  PC.failures = 0;
  PC.actionsAt = 0;
  renderPc();
  pollPc();
}

async function pollPc() {
  clearTimeout(PC.pollTimer);
  if (!agent.configured) {
    setPcOffline('Not set up');
    return;
  }
  if (document.hidden) return;
  try {
    const media = await agent.media();
    PC.failures = 0;
    PC.blocked = false;
    if (!PC.online) {
      PC.online = true;
      PC.wakingUntil = 0;
      agent.status().then((s) => { PC.name = s.name; renderPc(); }).catch(() => {});
    }
    PC.media = media;
    PC.receivedAt = performance.now();
    if (Date.now() - PC.actionsAt > 30000) refreshActions();
    loadArt();
    setPill('pill-pc', 'on');
  } catch (err) {
    PC.failures += 1;
    PC.blocked = !(await hasAgentAccess());
    if (PC.blocked) setPcOffline('Chrome needs access to the PC', 'error');
    else if (err.status === 401) setPcOffline('Wrong token - check it in Settings', 'error');
    else if (PC.failures >= 2 || !PC.online) setPcOffline(PC.wakingUntil > Date.now() ? 'Waking up…' : 'Offline');
  }
  renderPc();
  renderPlayer();
  PC.pollTimer = setTimeout(pollPc, PC.online ? (isIdle() ? 5000 : 2000) : PC.wakingUntil > Date.now() ? 2000 : 6000);
}

function setPcOffline(reason, pill = 'off') {
  const wasOnline = PC.online;
  PC.online = false;
  PC.media = null;
  PC.offlineReason = reason;
  setPill('pill-pc', PC.wakingUntil > Date.now() ? 'busy' : pill);
  loadArt();
  if (wasOnline || !$('deck-grid').children.length) renderDeck();
  renderPc();
  renderPlayer();
}

let pcSig = '';
function renderPc() {
  const waking = !PC.online && PC.wakingUntil > Date.now();
  const sig = JSON.stringify([PC.online, waking, PC.blocked, PC.name, PC.offlineReason, PC.actions.length]);
  if (sig === pcSig) return;
  pcSig = sig;
  $('pc').dataset.state = PC.online ? 'online' : PC.blocked ? 'blocked' : waking ? 'waking' : 'offline';
  $('pc-allow').hidden = PC.online || !PC.blocked;
  $('pc-name').textContent = PC.name || 'Main PC';
  $('pc-sub').textContent = PC.online ? 'Connected' : waking ? 'Waking up…' : (PC.offlineReason || 'Offline');
  $('pc-wake').disabled = waking;
  for (const b of $('deck-grid').querySelectorAll('.shortcut')) b.disabled = !PC.online;
}

let playerSig = '';
function renderPlayer() {
  const card = $('player');
  const m = PC.media;
  const active = PC.online && m?.active;
  // Polls arrive every 2 s; only touch the DOM when something on screen actually changes.
  const sig = JSON.stringify([PC.online, PC.offlineReason, PC.name, active && [m.app, m.title, m.artist, m.album,
    m.playing, m.shuffle, m.repeat, m.can, m.playing ? 0 : Math.floor(m.position)]]);
  syncProgressTimer();
  renderVolume();
  if (sig === playerSig) return;
  playerSig = sig;
  card.dataset.state = PC.online ? 'online' : 'offline';
  card.dataset.playing = String(!!(active && m.playing));
  $('np-app').textContent = active ? m.app : 'Spotify';
  $('np-sub').textContent = !PC.online ? (PC.offlineReason === 'Not set up' ? 'PC agent not set up' : 'PC offline')
    : !m?.active ? 'Nothing playing' : `${m.playing ? 'Playing' : 'Paused'} on ${PC.name || 'PC'}`;
  $('np-title').textContent = active ? (m.title || 'Unknown Title') : 'Not Playing';
  $('np-artist').textContent = active ? [m.artist, m.album].filter(Boolean).join(' — ') || ' ' : ' ';
  $('np-play').querySelector('use').setAttribute('href', active && m.playing ? '#i-pause' : '#i-play');
  $('np-play').setAttribute('aria-label', active && m.playing ? 'Pause' : 'Play');
  $('np-shuffle').classList.toggle('on', !!(active && m.shuffle));
  $('np-shuffle').disabled = !(active && m.can?.shuffle);
  $('np-repeat').classList.toggle('on', !!(active && m.repeat && m.repeat !== 'off'));
  $('np-repeat').dataset.mode = active ? m.repeat || 'off' : 'off';
  $('np-repeat').disabled = !(active && m.can?.repeat);
  $('np-prev').disabled = !(active && m.can?.previous);
  $('np-next').disabled = !(active && m.can?.next);
  renderProgress();
}

// Progress: 4 updates a second while playing (smoothed by a CSS transition), none otherwise.
function syncProgressTimer() {
  const playing = PC.online && PC.media?.active && PC.media.playing && !document.hidden;
  if (playing && !PC.progressTimer) PC.progressTimer = setInterval(renderProgress, 1000);
  if (!playing && PC.progressTimer) { clearInterval(PC.progressTimer); PC.progressTimer = 0; }
}

function renderProgress() {
  const m = PC.media;
  const fill = $('np-fill');
  if (PC.online && m?.active && m.duration) {
    const elapsed = m.playing ? (performance.now() - PC.receivedAt) / 1000 : 0;
    const pos = Math.min(m.duration, m.position + elapsed);
    fill.style.transform = `scaleX(${pos / m.duration})`;
    $('np-pos').textContent = fmtTime(pos);
    $('np-dur').textContent = `-${fmtTime(m.duration - pos)}`;
  } else {
    fill.style.transform = 'scaleX(0)';
    $('np-pos').textContent = '0:00';
    $('np-dur').textContent = '-0:00';
  }
}

function volumeInfo() {
  const v = PC.media?.volume;
  if (!v) return null;
  const target = PC.volTarget === 'app' && v.app ? 'app' : 'system';
  return { target, ...v[target], appAvailable: !!v.app };
}

let volumeSig = '';
function renderVolume() {
  const info = volumeInfo();
  const sig = JSON.stringify([info, PC.volTarget, PC.online, Date.now() > PC.volHoldUntil]);
  if (sig === volumeSig) return;
  volumeSig = sig;
  for (const b of $('vol-target').children) {
    b.setAttribute('aria-pressed', String(b.dataset.target === (info?.target ?? PC.volTarget)));
    if (b.dataset.target === 'app') b.disabled = !!(PC.online && info && !info.appAvailable);
  }
  $('vol-slider').setAttribute('aria-disabled', String(!info));
  if (!info) { $('vol-val').textContent = ''; return; }
  if (Date.now() > PC.volHoldUntil) PC.volSlider.set(Math.round(info.level * 100));
  $('vol-val').textContent = info.muted ? 'Muted' : `${Math.round(info.level * 100)}%`;
  $('vol-mute').querySelector('use').setAttribute('href', info.muted ? '#i-speaker-off' : '#i-speaker');
}

async function loadArt() {
  const key = PC.online && PC.media?.active ? PC.media.art_key ?? null : null;
  if (key === PC.artKey) return;
  PC.artKey = key;
  let url = null;
  if (key) {
    try {
      url = URL.createObjectURL(await agent.art());
    } catch { /* no artwork */ }
    if (PC.artKey !== key) { if (url) URL.revokeObjectURL(url); return; }
  }
  if (PC.artUrl) URL.revokeObjectURL(PC.artUrl);
  PC.artUrl = url;
  $('np-art').hidden = !url;
  if (url) $('np-art').src = url;
  setWallpaper(url);
}

/** Blurred album art behind everything. Drawn from a 24px thumbnail, so it costs almost nothing. */
let wallLayer = 'wp-a';
async function setWallpaper(url) {
  const next = wallLayer === 'wp-a' ? 'wp-b' : 'wp-a';
  if (!url) {
    $('wp-a').classList.remove('show');
    $('wp-b').classList.remove('show');
    return;
  }
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const small = document.createElement('canvas');
    small.width = small.height = 16;
    small.getContext('2d').drawImage(img, 0, 0, 16, 16);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.filter = 'blur(4px) saturate(160%)';
    ctx.drawImage(small, -8, -8, 80, 80);
    $(next).style.backgroundImage = `url(${canvas.toDataURL()})`;
    $(next).classList.add('show');
    $(wallLayer).classList.remove('show');
    wallLayer = next;
  } catch { /* keep the previous wallpaper */ }
}

async function media(command, value) {
  if (!PC.online) return toast('The PC is offline', true);
  try {
    await agent.mediaCommand(command, value);
    setTimeout(pollPc, 250);
  } catch (err) {
    toast(err.message, true);
  }
}

function sendVolume(body) {
  const info = volumeInfo();
  if (!PC.online || !info) return;
  PC.volHoldUntil = Date.now() + 1500;
  agent.setVolume({ target: info.target, ...body })
    .then((v) => { if (PC.media) PC.media.volume = v; renderVolume(); })
    .catch((err) => toast(err.message, true));
}

function wireVolume() {
  PC.volSlider = makeSlider($('vol-slider'), {
    min: 0, max: 100, step: 1,
    onInput: (v) => {
      PC.volHoldUntil = Date.now() + 1500;
      $('vol-val').textContent = `${v}%`;
      clearTimeout(PC.volSendTimer);
      PC.volSendTimer = setTimeout(() => sendVolume({ level: v / 100 }), 60);
    },
    onChange: (v) => sendVolume({ level: v / 100 }),
  });
  $('vol-mute').addEventListener('click', () => sendVolume({ muted: 'toggle' }));
  for (const b of $('vol-target').children) {
    b.addEventListener('click', () => { PC.volTarget = b.dataset.target; save('ui.volTarget', PC.volTarget); renderVolume(); });
  }
}

function wireSeek() {
  $('np-progress').addEventListener('pointerdown', (e) => {
    const m = PC.media;
    if (!PC.online || !m?.active || !m.duration || !m.can?.seek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = clamp((e.clientX - rect.left) / rect.width, 0, 1) * m.duration;
    m.position = pos;
    PC.receivedAt = performance.now();
    renderProgress();
    media('seek', pos);
  });
}

// ---------------------------------------------------------------- shortcuts (deck)

async function refreshActions() {
  PC.actionsAt = Date.now();
  try {
    const actions = (await agent.actions()).actions ?? [];
    const changed = JSON.stringify(actions) !== JSON.stringify(PC.actions);
    PC.actions = actions;
    if (changed) { save('pc.actions', actions); renderDeck(); }
  } catch { /* keep the last list */ }
}

function renderDeck() {
  const groups = new Map();
  PC.actions.forEach((a, i) => {
    const g = a.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([a, i]);
  });
  const nodes = [];
  for (const [group, items] of groups) {
    if (group && groups.size > 1) nodes.push(el('div', { class: 'deck-group' }, group));
    for (const [a, i] of items) {
      const key = deckKey(a);
      const btn = el('button', {
        type: 'button', class: 'shortcut', disabled: !PC.online,
        title: key ? `${a.label} (${prettyCombo(key)})` : a.label, dataset: { id: a.id },
        onclick: () => runAction(a, btn),
      }, icon(iconFor(a)), el('span', { class: 'lbl' }, a.label), key ? el('kbd', {}, prettyCombo(key)) : null);
      nodes.push(btn);
    }
  }
  $('deck-grid').replaceChildren(...nodes);
  $('deck').dataset.empty = String(!PC.actions.length);
  $('deck-empty').textContent = agent.configured ? 'Buttons appear here when the PC agent is online.' : 'Set up the PC agent in Settings to add buttons.';
}

async function runAction(action, btn = document.querySelector(`.shortcut[data-id="${CSS.escape(action.id)}"]`)) {
  if (!PC.online) return toast('The PC is offline', true);
  if (action.confirm && btn && !btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    setTimeout(() => btn.classList.remove('confirm'), 3000);
    return;
  }
  btn?.classList.remove('confirm');
  btn?.classList.add('busy');
  try {
    const res = await agent.runAction(action.id);
    if (res.result?.muted !== undefined) toast(`${action.label}: ${res.result.muted ? 'Muted' : 'Unmuted'}`);
    flash(btn, 'ok', 500);
  } catch (err) {
    flash(btn, 'err', 400);
    toast(`${action.label}: ${err.message}`, true);
  } finally {
    btn?.classList.remove('busy');
  }
}

function flash(btn, cls, ms) {
  if (!btn) return;
  btn.classList.add(cls);
  setTimeout(() => btn.classList.remove(cls), ms);
}

// ---------------------------------------------------------------- wake

async function wakePc() {
  if (PC.online) return;
  if (!settings.wakeUrl) {
    toast('Add a wake device in Settings first', true);
    return openSettings('wakeUrl');
  }
  try {
    await sendWake(settings);
    PC.wakingUntil = Date.now() + 120000;
    toast('Wake signal sent');
    setPill('pill-pc', 'busy');
    renderPc();
    pollPc();
  } catch (err) {
    toast(err.message, true);
  }
}

/** Extra wake-only devices (e.g. the MSI laptop) shown under the PC card. */
function renderWakeDevices() {
  const devices = parseWakeDevices(settings.wakeDevices);
  const box = $('other-devices');
  box.hidden = !devices.length || !settings.wakeUrl;
  box.replaceChildren(...devices.map((d) => el('button', {
    type: 'button', class: 'device-btn', title: `Wake ${d.name} (${d.mac})`,
    onclick: async () => {
      try {
        await sendWake(settings, d.mac);
        toast(`Wake signal sent to ${d.name}`);
      } catch (err) {
        toast(err.message, true);
      }
    },
  }, icon('bolt'), `Wake ${d.name}`)));
}

// ======================================================================= self-update

const UPDATE = { latest: null, sha: null, checkedAt: 0, busy: false };

/** Runs on every start: installs silently when folder access is already granted, otherwise shows the Update button. */
async function checkForUpdate({ manual = false } = {}) {
  if (!isExtension || DEMO || UPDATE.busy) return;
  UPDATE.checkedAt = Date.now();
  try {
    const latest = await updater.latestVersion();
    UPDATE.latest = latest.version;
    UPDATE.sha = latest.sha;
  } catch (err) {
    if (manual) toast(`Couldn't check for updates: ${err.message}`, true);
    return;
  }
  const current = updater.currentVersion();
  if (!updater.isNewer(UPDATE.latest, current)) {
    $('btn-update').hidden = true;
    if (manual) toast(`Home Deck ${current} is up to date`);
    return;
  }
  const { state } = await updater.folderStatus();
  if (state === 'granted') return runUpdate();
  $('update-text').textContent = `Update to ${UPDATE.latest}`;
  $('btn-update').hidden = false;
  toast(`Home Deck ${UPDATE.latest} is available - tap Update at the top`);
}

async function runUpdate() {
  if (UPDATE.busy) return;
  const { state } = await updater.folderStatus();
  if (state === 'none') {
    // First update: ask for the folder right here (this tap counts as the user gesture).
    try {
      await updater.linkFolder();
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, true);
      return;
    }
  }
  UPDATE.busy = true;
  $('btn-update').disabled = true;
  try {
    await updater.installUpdate({ sha: UPDATE.sha, onStatus: (text) => toast(text) }); // reloads Home Deck when done
  } catch (err) {
    toast(err.message, true);
  } finally {
    UPDATE.busy = false;
    $('btn-update').disabled = false;
  }
}

async function renderUpdateSettings() {
  if (!isExtension) {
    $('upd-version').textContent = 'Preview';
    $('upd-status').textContent = 'Extension only';
    $('upd-link').disabled = true;
    $('upd-check').disabled = true;
    return;
  }
  $('upd-version').textContent = updater.currentVersion();
  const { state, name } = await updater.folderStatus();
  $('upd-status').textContent = state === 'none' ? 'Off' : state === 'granted' ? `On · ${name}` : `On · ${name} (tap Update to allow)`;
  $('upd-link').textContent = state === 'none' ? 'Choose Extension Folder…' : 'Change Extension Folder…';
}

function wireUpdates() {
  $('btn-update').addEventListener('click', runUpdate);
  $('upd-check').addEventListener('click', () => checkForUpdate({ manual: true }));
  $('upd-link').addEventListener('click', async () => {
    try {
      const name = await updater.linkFolder();
      toast(`Automatic updates on (${name})`);
      await renderUpdateSettings();
      checkForUpdate();
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, true);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - UPDATE.checkedAt > 6 * 3600 * 1000) checkForUpdate();
  });
}

async function announceUpdate() {
  if (!isExtension) return;
  const { 'update.justInstalled': version } = await chrome.storage.local.get('update.justInstalled');
  if (!version) return;
  await chrome.storage.local.remove('update.justInstalled');
  if (version === updater.currentVersion()) toast(`Updated to Home Deck ${version}`);
}

// ======================================================================= settings sheet

const cloudFor = () => new XiaomiCloud($('settings-form').elements.region.value || settings.region);
let qrAbort = null;

async function openSettings(focusField) {
  const form = $('settings-form');
  for (const [k, v] of Object.entries(settings)) {
    const field = form.elements[k];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = !!v; else field.value = v ?? '';
  }
  setAgentNote('Shown by <code>setup.ps1</code> on the PC.');
  $('agent-token').type = 'password';
  $('token-eye').querySelector('use').setAttribute('href', '#i-eye');
  $('qr-box').hidden = true;
  $('settings').showModal();
  if (focusField) form.elements[focusField]?.focus();
  renderUpdateSettings();
  await renderAccount();
  await fillDevices(await load('mi.devices', []));
}

function setAgentNote(html, cls = '') {
  $('agent-test').innerHTML = html;
  $('agent-test').className = `group-foot ${cls}`;
}

async function renderAccount() {
  if (DEMO || !isExtension) {
    $('mi-account').textContent = 'Extension only';
    $('mi-signin').disabled = true;
    return;
  }
  const session = await cloudFor().session();
  $('mi-account').textContent = session ? `Signed in · ${session.userId}` : 'Not signed in';
  $('mi-signin').textContent = session ? 'Sign In Again' : 'Sign In with QR Code';
  $('mi-signout').hidden = !session;
}

async function fillDevices(devices) {
  const select = $('ac-select');
  const current = select.value || settings.acDid;
  const acs = devices.filter((d) => /aircondition|airrtc|acpartner/.test(d.model));
  const list = acs.length ? acs : devices;
  select.replaceChildren(el('option', { value: '' }, devices.length ? 'Choose…' : 'Sign in first'),
    ...list.map((d) => el('option', { value: d.did, dataset: { model: d.model, name: d.name } },
      `${d.name}${d.online === false ? ' (offline)' : ''}`)));
  if (current && !list.some((d) => d.did === current) && settings.acDid === current) {
    select.append(el('option', { value: current, dataset: { model: settings.acModel, name: settings.acName } }, settings.acName || current));
  }
  select.value = current || '';
}

async function reloadDevices() {
  const button = $('ac-reload');
  button.disabled = true;
  try {
    const devices = await cloudFor().devices();
    await save('mi.devices', devices);
    await fillDevices(devices);
    if (!devices.length) toast('No devices on this Xiaomi region', true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

async function startQrSignIn() {
  qrAbort?.abort();
  qrAbort = new AbortController();
  const cloud = cloudFor();
  const status = $('qr-status');
  $('qr-box').hidden = false;
  status.textContent = 'Getting a QR code…';
  status.className = 'qr-status';
  try {
    const login = await cloud.startQrLogin();
    $('qr-img').src = login.qr;
    status.textContent = 'Waiting for scan…';
    await cloud.waitForQrLogin(login, qrAbort.signal);
    $('qr-box').hidden = true;
    toast('Signed in to Mi Home');
    await renderAccount();
    await reloadDevices();
  } catch (err) {
    if (err.name === 'AbortError') return;
    status.textContent = err.message;
    status.className = 'qr-status err';
  }
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

async function onSaveSettings(event) {
  event.preventDefault();
  const form = $('settings-form');
  const next = { ...settings };
  for (const k of Object.keys(settings)) {
    const field = form.elements[k];
    if (!field) continue;
    next[k] = field.type === 'checkbox' ? field.checked : String(field.value).trim();
  }
  next.agentUrl = normaliseUrl(next.agentUrl);
  next.wakeUrl = normaliseUrl(next.wakeUrl);
  const opt = $('ac-select').selectedOptions[0];
  next.acModel = opt?.dataset.model || (next.acDid === settings.acDid ? settings.acModel : '');
  next.acName = opt?.dataset.name || (next.acDid === settings.acDid ? settings.acName : '');

  // Chrome needs explicit permission to reach LAN devices (the PC agent, the wake device).
  // If it's refused, settings are still saved and the PC card offers an "Allow Access" button.
  let allowed = true;
  if (isExtension) {
    const origins = [originPattern(next.agentUrl), originPattern(next.wakeUrl)].filter(Boolean);
    if (origins.length) allowed = await chrome.permissions.request({ origins }).catch(() => false);
  }

  qrAbort?.abort();
  const changedAgent = next.agentUrl !== settings.agentUrl || next.agentToken !== settings.agentToken;
  await saveSettings(next);
  await applySettings(next);
  if (allowed && next.agentUrl && next.agentToken && changedAgent) {
    setAgentNote('Checking the PC agent…');
    try {
      const status = await new PcAgent(next.agentUrl, next.agentToken).status();
      toast(`Connected to ${status.name}`);
    } catch (err) {
      setAgentNote(explainAgentError(err, next.agentUrl), 'err');
      toast(err.status === 401 ? 'Saved, but the token is wrong' : "Saved, but the PC didn't answer", true);
      return; // keep the sheet open so the reason stays visible
    }
  }

  $('settings').close();
  if (!allowed) toast('Saved. Tap "Allow Access" on the PC card so Chrome can reach it', true);
}

/** Turn a failed agent request into something actionable. */
function explainAgentError(err, url) {
  const where = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (err.status === 401) return "The token doesn't match the PC's. Tap the eye to check it: l/I/1 and O/0 are easy to mix up.";
  if (err.name === 'TimeoutError') return `No reply from ${where}. Make sure the Surface is on the same Wi-Fi as the PC (not a guest network or the PC's hotspot) and the PC is awake.`;
  if (err.name === 'TypeError') return `Couldn't connect to ${where}. Check the address, and that the Home Deck agent is running on the PC.`;
  return err.message;
}

/** "192.168.1.94:8765" → "http://192.168.1.94:8765"; trims spaces and trailing slashes. */
function normaliseUrl(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^[a-z]+:\/\//i.test(v) ? v : `http://${v}`;
}

async function hasAgentAccess() {
  if (!isExtension) return true;
  const origin = originPattern(settings.agentUrl);
  return !origin || chrome.permissions.contains({ origins: [origin] });
}

async function allowAgentAccess() {
  const origins = [originPattern(settings.agentUrl), originPattern(settings.wakeUrl)].filter(Boolean);
  if (!(await chrome.permissions.request({ origins }).catch(() => false))) return toast('Access was not allowed', true);
  PC.blocked = false;
  pcSig = '';
  pollPc();
}

function wireSettings() {
  $('btn-settings').addEventListener('click', () => openSettings());
  document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', () => openSettings()));
  $('settings-form').addEventListener('submit', onSaveSettings); // Done, or Enter in any field
  $('settings-cancel').addEventListener('click', () => $('settings').close());
  $('pc-allow').addEventListener('click', allowAgentAccess);
  $('token-eye').addEventListener('click', () => {
    const field = $('agent-token');
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    $('token-eye').querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    $('token-eye').setAttribute('aria-label', show ? 'Hide token' : 'Show token');
    $('token-eye').title = show ? 'Hide token' : 'Show token';
  });
  $('agent-test-btn').addEventListener('click', async () => {
    const form = $('settings-form');
    const url = normaliseUrl(form.elements.agentUrl.value);
    const token = form.elements.agentToken.value.trim();
    if (!url || !token) return setAgentNote('Enter the Agent URL and token first.', 'err');
    setAgentNote('Testing…');
    try {
      const status = await new PcAgent(url, token).status();
      setAgentNote(`Connected to ${status.name}. Tap Done to save.`, 'ok');
    } catch (err) {
      setAgentNote(explainAgentError(err, url), 'err');
    }
  });
  $('settings').addEventListener('close', () => qrAbort?.abort());
  $('mi-signin').addEventListener('click', startQrSignIn);
  $('qr-cancel').addEventListener('click', () => { qrAbort?.abort(); $('qr-box').hidden = true; });
  $('mi-signout').addEventListener('click', async () => {
    await cloudFor().signOut();
    await save('mi.devices', []);
    await renderAccount();
    await fillDevices([]);
  });
  $('ac-reload').addEventListener('click', reloadDevices);
  $('wake-linux').addEventListener('click', () => {
    const f = $('settings-form').elements;
    f.wakeUrl.value = 'http://penguin.linux.test:9009/wake';
    f.wakeMethod.value = 'POST';
    f.wakeBody.value = JSON.stringify({ mac: '04:7C:16:48:3D:E8' });
    if (!f.wakeDevices.value.trim()) f.wakeDevices.value = 'MSI Laptop = 00:D8:61:83:BD:59';
    toast('Filled in - tap Done to save');
  });
  $('add-to-shelf').addEventListener('click', () => {
    if (isExtension) chrome.tabs.create({ url: `https://kriisshh.github.io/home-deck/#id=${chrome.runtime.id}` });
  });
  $('open-shortcuts').addEventListener('click', () => {
    if (isExtension) chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  // Live preview of appearance choices while the sheet is open
  $('settings-form').addEventListener('change', (e) => {
    if (e.target.name !== 'appearance' && e.target.name !== 'reduceTransparency') return;
    const form = $('settings-form');
    const saved = settings;
    settings = { ...settings, appearance: form.elements.appearance.value, reduceTransparency: form.elements.reduceTransparency.checked };
    applyAppearance();
    settings = saved;
  });
  $('settings').addEventListener('close', () => applyAppearance());
}

async function applySettings(next) {
  const prev = settings;
  settings = next;
  applyAppearance();
  if (!prev || prev.acDid !== next.acDid || prev.acModel !== next.acModel || prev.region !== next.region) {
    await initAc();
  } else {
    buildAcControls();
    renderAc();
  }
  if (!prev || prev.agentUrl !== next.agentUrl || prev.agentToken !== next.agentToken) initPc();
  renderWakeDevices();
  renderDeck();
}

// ======================================================================= keyboard

// Nothing on the panel fires from a plain key press any more, so a stray key can't touch the PC or
// the AC. Spotify follows the keyboard's media keys, shortcut buttons fire only on the combos set in
// config.json, and the Chrome-wide shortcuts live at chrome://extensions/shortcuts.

const MEDIA_KEYS = {
  MediaPlayPause: () => media('play_pause'),
  MediaTrackNext: () => media('next'),
  MediaTrackPrevious: () => media('previous'),
};

// Harmless UI keys only (no actions).
const UI_KEYS = { '?': () => showKeys(), ',': () => openSettings() };

function eventCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.metaKey) parts.push('meta');
  const key = e.key.toLowerCase();
  if (e.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) parts.push('shift');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

const deckKey = (action) => action.key?.toLowerCase() || null;

function onKeyDown(e) {
  if (MEDIA_KEYS[e.key]) { // when the panel is focused and Chrome passes media keys through
    e.preventDefault();
    MEDIA_KEYS[e.key]();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, select, textarea')) return;
  const combo = eventCombo(e);
  const action = PC.actions.find((a) => deckKey(a) === combo);
  if (action) {
    e.preventDefault();
    runAction(action);
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && UI_KEYS[e.key]) {
    e.preventDefault();
    UI_KEYS[e.key]();
  }
}

const prettyCombo = (combo) => combo.split('+').map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(' + ');

async function showKeys() {
  const nodes = [];
  const section = (title, rows, foot) => {
    if (!rows.length) return;
    nodes.push(el('div', { class: 'group-title' }, title));
    nodes.push(el('div', { class: 'group' }, ...rows.map(([key, desc]) => el('div', { class: 'row keys-row' }, el('span', {}, desc), el('kbd', {}, key)))));
    if (foot) nodes.push(el('p', { class: 'group-foot' }, foot));
  };
  if (isExtension && chrome.commands) {
    const commands = (await chrome.commands.getAll()).filter((c) => c.description);
    const pretty = (s) => s.replace('MediaPlayPause', 'Play/Pause key').replace('MediaNextTrack', 'Next key').replace('MediaPrevTrack', 'Previous key');
    section('Anywhere in Chrome', commands.map((c) => [c.shortcut ? pretty(c.shortcut) : 'Not set', c.description]),
      'Change or add these at chrome://extensions/shortcuts (Settings › Chrome-Wide Shortcuts).');
  }
  section('Shortcut Buttons', PC.actions.filter(deckKey).map((a) => [prettyCombo(deckKey(a)), a.label]),
    'Only buttons with a "key" set in config.json on the PC have a shortcut, e.g. "key": "ctrl+shift+1".');
  section('Panel', [['?', 'This list'], [',', 'Settings']]);
  $('keys-body').replaceChildren(...nodes);
  $('keys').showModal();
}

// ======================================================================= wiring

function wireControls() {
  $('ac-power').addEventListener('click', () => acDo(() => ac.togglePower()));
  $('ac-up').addEventListener('click', () => nudgeTemp(1));
  $('ac-down').addEventListener('click', () => nudgeTemp(-1));
  $('np-play').addEventListener('click', () => media('play_pause'));
  $('np-next').addEventListener('click', () => media('next'));
  $('np-prev').addEventListener('click', () => media('previous'));
  $('np-shuffle').addEventListener('click', () => media('shuffle'));
  $('np-repeat').addEventListener('click', () => media('repeat'));
  $('pc-wake').addEventListener('click', wakePc);
  $('btn-keys').addEventListener('click', showKeys);
  $('keys-close').addEventListener('click', () => $('keys').close());
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', () => {
    syncProgressTimer();
    if (document.hidden) return;
    pollAc();
    pollPc();
  });
  wireDial();
  wireFan();
  wireVolume();
  wireSeek();
  wireSettings();
  wireUpdates();
  const editor = new DeckEditor({
    dialog: $('deck-editor'), el, icon, toast, eventCombo,
    getActions: () => PC.actions,
    save: async (actions) => {
      const res = await agent.saveActions(actions);
      PC.actions = res.actions;
      save('pc.actions', PC.actions);
      renderDeck();
    },
  });
  $('deck-edit').addEventListener('click', () => {
    if (!PC.online) return toast('Connect to the PC to edit shortcuts', true);
    editor.open();
  });
}

async function main() {
  tickClock();
  const everyMinute = () => { tickClock(); setTimeout(everyMinute, 60000 - (Date.now() % 60000) + 50); };
  setTimeout(everyMinute, 60000 - (Date.now() % 60000) + 50);
  PC.volTarget = await load('ui.volTarget', 'app');
  PC.actions = await load('pc.actions', []);
  wireControls();
  await applySettings(await loadSettings());
  onChange((changes) => {
    if (changes.settings) applySettings({ ...settings, ...changes.settings.newValue });
  });
  if (!DEMO && !settings.acDid && !settings.agentUrl) openSettings();
  announceUpdate();
  checkForUpdate();
}

main();
