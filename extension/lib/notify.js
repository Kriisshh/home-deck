// Phone notifications, kept by the always-on phone's wake service (linux/wol-server.py): the main
// phone forwards each notification there (MacroDroid), and Home Deck reads the list.

import { load, save } from './store.js';

const ICON_SIZE = 64;

/** Server base URL: the Notifications Server setting, else the Wake URL's server. */
export function notifyBase(settings) {
  for (const raw of [settings.notifyUrl, settings.wakeUrl]) {
    try {
      if (raw) return new URL(raw).origin;
    } catch { /* not a URL */ }
  }
  return '';
}

export class PhoneNotifications {
  constructor(base, key) {
    this.base = base;
    this.key = key;
  }

  async _req(path, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'X-Key': this.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000), // the always-on phone's Wi-Fi can be slow to wake
    });
    if (res.status === 401) throw Object.assign(new Error('Wrong notification key - check Settings'), { status: 401 });
    if (!res.ok) throw new Error(`Notifications: HTTP ${res.status}`);
    return res;
  }

  /** Newest first. */
  async list() {
    const data = await (await this._req('/notifications')).json();
    return (data.items ?? []).slice().reverse();
  }

  dismiss(ids) {
    return this._req('/notifications/dismiss', { method: 'POST', body: { ids } });
  }

  /** The app's icon in black and white, as a small data URL. Made once per app, then kept in storage. */
  async monoIcon(pkg) {
    if (!pkg) return null;
    const cacheKey = `nt.icon.${pkg}`;
    const cached = await load(cacheKey, null);
    if (cached?.url) return cached.url;
    if (cached && Date.now() - cached.missedAt < 86400000) return null; // no icon found; retry tomorrow
    try {
      const blob = await (await this._req(`/icon?pkg=${encodeURIComponent(pkg)}`)).blob();
      const url = toMono(await createImageBitmap(blob));
      await save(cacheKey, { url });
      return url;
    } catch {
      await save(cacheKey, { missedAt: Date.now() });
      return null;
    }
  }
}

/** Grayscale with a little extra contrast, so colored icons read as clean black-and-white marks. */
function toMono(bitmap) {
  const canvas = Object.assign(document.createElement('canvas'), { width: ICON_SIZE, height: ICON_SIZE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, ICON_SIZE, ICON_SIZE);
  const img = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, (y - 128) * 1.35 + 128));
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
