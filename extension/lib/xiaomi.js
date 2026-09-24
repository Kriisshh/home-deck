// Xiaomi (Mi Home) cloud client - the same protocol the Mi Home app and Home Assistant's
// xiaomi_miot integration use. Sign-in is by scanning a QR code with the Mi Home app, so no
// password ever passes through this extension.

import { b64decode, b64encode, concat, rc4, sha1, sha256, utf8, utf8d } from './crypto.js';
import { load, remove, save } from './store.js';

const SESSION_KEY = 'mi.session';
const SPEC_KEY = (model) => `mi.spec.${model}`;
const COOKIE_DOMAIN = '.io.mi.com';
const USER_AGENT = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-HOMEDECK APP/xiaomi.smarthome APPV/62830';

export class NotSignedIn extends Error {
  constructor(message = 'Sign in to Xiaomi in Settings') { super(message); this.name = 'NotSignedIn'; }
}

const parseMi = (text) => JSON.parse(text.replace('&&&START&&&', ''));
const typeName = (urn) => urn.split(':')[3];

export function apiBase(region) {
  return `https://${region === 'cn' ? '' : `${region}.`}api.io.mi.com/app`;
}

async function signedNonce(ssecurity, nonce) {
  return b64encode(await sha256(concat(b64decode(ssecurity), b64decode(nonce))));
}

function makeNonce() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes.subarray(0, 8));
  new DataView(bytes.buffer).setUint32(8, Math.floor(Date.now() / 60000));
  return b64encode(bytes);
}

async function encSignature(path, method, nonceKey, params) {
  const parts = [method.toUpperCase(), path.replace('/app/', '/'),
    ...Object.entries(params).map(([k, v]) => `${k}=${v}`), nonceKey];
  return b64encode(await sha1(utf8.encode(parts.join('&'))));
}

/** Build the encrypted query parameters for one API call (mirrors micloud's generate_enc_params). */
export async function encryptParams(url, method, nonce, ssecurity, params) {
  const nonceKey = await signedNonce(ssecurity, nonce);
  const key = b64decode(nonceKey);
  const path = new URL(url).pathname;
  const fields = { ...params };
  fields.rc4_hash__ = await encSignature(path, method, nonceKey, fields);
  for (const k of Object.keys(fields)) fields[k] = b64encode(rc4(key, utf8.encode(fields[k])));
  fields.signature = await encSignature(path, method, nonceKey, fields);
  fields.ssecurity = ssecurity;
  fields._nonce = nonce;
  return { fields, key };
}

export function decryptResponse(key, text) {
  return utf8d.decode(rc4(key, b64decode(text.trim())));
}

async function setCookie(url, domain, name, value) {
  await chrome.cookies.set({
    url, domain, name, value: String(value), path: '/', secure: true, sameSite: 'no_restriction',
    expirationDate: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
  });
}

async function readCookie(name) {
  for (const url of ['https://sts.api.io.mi.com/', 'https://api.io.mi.com/']) {
    const c = await chrome.cookies.get({ url, name });
    if (c?.value) return c.value;
  }
  const all = await chrome.cookies.getAll({ name });
  return all.find((c) => c.domain.endsWith('mi.com'))?.value ?? null;
}

/** Make the extension's own requests to Xiaomi look like the Mi Home app (some endpoints check). */
export async function installHeaderRules() {
  if (!chrome.declarativeNetRequest) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'user-agent', operation: 'set', value: USER_AGENT }] },
      condition: {
        requestDomains: ['api.io.mi.com', 'sts.api.io.mi.com'],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    }],
  });
}

export class XiaomiCloud {
  constructor(region = 'cn') {
    this.region = region;
    this._session = undefined;
    this._cookiesFor = null;
  }

  async session() {
    if (this._session === undefined) this._session = await load(SESSION_KEY, null);
    return this._session;
  }

  async signedIn() {
    return !!(await this.session())?.serviceToken;
  }

  async signOut() {
    this._session = null;
    this._cookiesFor = null;
    await remove(SESSION_KEY);
  }

  // ------------------------------------------------------------------ QR sign-in

  /** Step 1: ask Xiaomi for a login QR code. Returns { qr, loginUrl, lp, timeout }. */
  async startQrLogin() {
    const params = new URLSearchParams({
      _qrsize: '480',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts',
      _hasLogo: 'false',
      sid: 'xiaomiio',
      serviceParam: '',
      _locale: 'en_GB',
      _dc: String(Date.now()),
    });
    const res = await fetch(`https://account.xiaomi.com/longPolling/loginUrl?${params}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Xiaomi login page returned HTTP ${res.status}`);
    const data = parseMi(await res.text());
    if (!data.qr || !data.lp) throw new Error(data.desc || 'Xiaomi did not return a QR code');
    return { qr: data.qr, loginUrl: data.loginUrl, lp: data.lp, timeout: Number(data.timeout) || 300 };
  }

  /** Step 2: long-poll until the QR code is scanned and confirmed in the Mi Home app. */
  async waitForQrLogin({ lp, timeout }, signal) {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let res;
      try {
        res = await fetch(lp, { credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)].filter(Boolean)) });
      } catch (err) {
        if (signal?.aborted) throw err;
        continue; // long-poll timed out without a scan - ask again
      }
      if (res.ok) {
        const data = parseMi(await res.text());
        if (data.ssecurity && data.location) return this._finishLogin(data);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('The QR code expired - try again');
  }

  async _finishLogin(data) {
    await fetch(data.location, { credentials: 'include' }); // sets the serviceToken cookie
    const serviceToken = await readCookie('serviceToken');
    if (!serviceToken) throw new Error('Signed in, but Xiaomi did not hand out a service token');
    this._session = {
      userId: String(data.userId),
      cUserId: data.cUserId,
      ssecurity: data.ssecurity,
      passToken: data.passToken,
      serviceToken,
      savedAt: Date.now(),
    };
    this._cookiesFor = null;
    await save(SESSION_KEY, this._session);
    return this._session;
  }

  /** Renew an expired service token using the long-lived passToken from the QR sign-in. */
  async _refresh() {
    const s = await this.session();
    if (!s?.passToken) throw new NotSignedIn();
    await setCookie('https://account.xiaomi.com/', 'account.xiaomi.com', 'userId', s.userId);
    await setCookie('https://account.xiaomi.com/', 'account.xiaomi.com', 'passToken', s.passToken);
    const res = await fetch('https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true', { credentials: 'include' });
    const data = parseMi(await res.text());
    if (!data.ssecurity || !data.location) throw new NotSignedIn('Xiaomi session expired - sign in again in Settings');
    const clientSign = b64encode(await sha1(utf8.encode(`nonce=${data.nonce}&${data.ssecurity}`)));
    return this._finishLogin({
      ...s, ...data,
      location: `${data.location}&clientSign=${encodeURIComponent(clientSign)}`,
      passToken: data.passToken || s.passToken,
    });
  }

  async _installApiCookies(s) {
    if (this._cookiesFor === s.serviceToken) return;
    const url = `${new URL(apiBase(this.region)).origin}/`;
    for (const [name, value] of [['userId', s.userId], ['serviceToken', s.serviceToken],
      ['yetAnotherServiceToken', s.serviceToken], ['locale', 'en_GB'], ['channel', 'MI_APP_STORE']]) {
      await setCookie(url, COOKIE_DOMAIN, name, value);
    }
    this._cookiesFor = s.serviceToken;
  }

  // ------------------------------------------------------------------ API

  async call(path, data, retry = true) {
    const s = await this.session();
    if (!s?.serviceToken) throw new NotSignedIn();
    await this._installApiCookies(s);

    const url = apiBase(this.region) + path;
    const { fields, key } = await encryptParams(url, 'POST', makeNonce(), s.ssecurity, { data: JSON.stringify(data) });
    const res = await fetch(`${url}?${new URLSearchParams(fields)}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
      },
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      if (retry) { await this._refresh(); return this.call(path, data, false); }
      throw new NotSignedIn('Xiaomi session expired - sign in again in Settings');
    }
    if (!res.ok) throw new Error(`Xiaomi cloud error (HTTP ${res.status})`);
    const json = JSON.parse(text.trimStart().startsWith('{') ? text : decryptResponse(key, text));
    if (json.code !== 0) throw new Error(`Xiaomi cloud: ${json.message || `code ${json.code}`}`);
    return json.result;
  }

  async devices() {
    const result = await this.call('/home/device_list', { getVirtualModel: false, getHuamiDevices: 0 });
    return (result?.list ?? []).map((d) => ({ did: d.did, name: d.name, model: d.model, online: d.isOnline }));
  }

  async getProps(did, props) {
    const result = await this.call('/miotspec/prop/get', { params: props.map((p) => ({ did, siid: p.siid, piid: p.piid })) });
    return result ?? [];
  }

  async setProps(did, props) {
    const result = await this.call('/miotspec/prop/set', { params: props.map((p) => ({ did, siid: p.siid, piid: p.piid, value: p.value })) });
    const failed = (result ?? []).find((r) => r.code !== 0);
    if (failed) throw new Error(failed.code === -704042011 ? 'The AC is offline' : `The AC rejected the change (code ${failed.code})`);
    return result;
  }
}

// ------------------------------------------------------------------ MIoT spec

/** Download (once, then cached) the MIoT spec describing a device model's services and properties. */
export async function loadSpec(model) {
  const cached = await load(SPEC_KEY(model), null);
  if (cached) return cached;
  const list = await (await fetch('https://miot-spec.org/miot-spec-v2/instances?status=released')).json();
  const match = list.instances.filter((i) => i.model === model).sort((a, b) => b.version - a.version)[0];
  if (!match) throw new Error(`No MIoT spec published for ${model}`);
  const spec = await (await fetch(`https://miot-spec.org/miot-spec-v2/instance?type=${match.type}`)).json();
  await save(SPEC_KEY(model), spec);
  return spec;
}

const TOGGLES = [
  ['air-conditioner', 'eco', 'Eco'],
  ['air-conditioner', 'sleep-mode', 'Sleep'],
  ['air-conditioner', 'heater', 'Aux heat'],
  ['air-conditioner', 'dryer', 'Self-clean dry'],
  ['air-conditioner', 'un-straight-blowing', 'No direct wind'],
  ['indicator-light', 'on', 'Display'],
  ['alarm', 'alarm', 'Beep'],
];

/** Pick out the properties the AC card needs from a spec. */
export function acModelFromSpec(spec) {
  const find = (service, property) => {
    for (const s of spec.services.filter((sv) => typeName(sv.type) === service)) {
      const p = (s.properties ?? []).find((pr) => typeName(pr.type) === property);
      if (p) {
        return {
          siid: s.iid, piid: p.iid, format: p.format, unit: p.unit,
          writable: p.access.includes('write'),
          range: p['value-range'], options: p['value-list']?.map((v) => ({ value: v.value, label: v.description.trim() })),
        };
      }
    }
    return null;
  };
  const model = {
    power: find('air-conditioner', 'on'),
    mode: find('air-conditioner', 'mode'),
    target: find('air-conditioner', 'target-temperature'),
    fan: find('fan-control', 'fan-level'),
    vswing: find('fan-control', 'vertical-swing'),
    hswing: find('fan-control', 'horizontal-swing'),
    room: find('environment', 'temperature'),
    humidity: find('environment', 'relative-humidity'),
    energy: find('power-consumption', 'power-consumption'),
    watts: find('electricity', 'electric-power'),
    toggles: TOGGLES.map(([s, p, label]) => ({ key: `${s}.${p}`, label, prop: find(s, p) }))
      .filter((t) => t.prop?.writable && t.prop.format === 'bool'),
  };
  if (!model.power) throw new Error('This device does not look like an air conditioner');
  return model;
}

/** All readable props of the model, flattened for one prop/get call. */
export function acReadList(model) {
  const list = [];
  for (const key of ['power', 'mode', 'target', 'fan', 'vswing', 'hswing', 'room', 'humidity', 'energy', 'watts']) {
    if (model[key]) list.push({ key, ...model[key] });
  }
  for (const t of model.toggles) list.push({ key: t.key, ...t.prop });
  return list;
}
