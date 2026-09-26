// Client for the Home Deck agent running on the main PC (pc-agent/agent.py).

export class PcAgent {
  constructor(url, token) {
    this.url = (url || '').replace(/\/+$/, '');
    this.token = token || '';
  }

  get configured() {
    return !!(this.url && this.token);
  }

  async request(path, { method = 'GET', body, timeout = 4000, raw = false } = {}) {
    if (!this.configured) throw new Error('Set the PC agent URL and token in Settings');
    const res = await fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (raw) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `PC agent error (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  status() { return this.request('/api/status', { timeout: 2500 }); }
  media() { return this.request('/api/media'); }
  art() { return this.request('/api/media/art', { raw: true, timeout: 8000 }).then((r) => r.blob()); }
  mediaCommand(command, value) { return this.request(`/api/media/${command}`, { method: 'POST', body: value === undefined ? {} : { value } }); }
  setVolume(body) { return this.request('/api/volume', { method: 'POST', body }); }
  actions() { return this.request('/api/actions'); }
  saveActions(actions) { return this.request('/api/actions', { method: 'POST', body: { actions }, timeout: 8000 }); }
  wake(mac) { return this.request('/api/wake', { method: 'POST', body: { mac } }); }
  runAction(id) { return this.request(`/api/actions/${encodeURIComponent(id)}`, { method: 'POST', timeout: 15000 }); }
}

const safeJson = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };

/** "MSI Laptop = 00:D8:61:83:BD:59 @ 192.168.1.67" lines (IP optional) → [{ name, mac, ip }] */
export function parseWakeDevices(text) {
  return String(text || '').split('\n').map((line) => {
    const m = line.match(/^\s*(.+?)\s*[=:,]\s*((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})\s*(?:@\s*(\d{1,3}(?:\.\d{1,3}){3}))?\s*$/i);
    return m && { name: m[1], mac: m[2].toUpperCase().replace(/-/g, ':'), ip: m[3] || '' };
  }).filter(Boolean);
}

/** Fire the user's configured wake request (ESPHome button, phone script, HA webhook, ...). */
export async function sendWake(settings, mac, ip) {
  if (!settings.wakeUrl) throw new Error('Set a Wake URL in Settings');
  const method = settings.wakeMethod || 'POST';
  // Another device: same wake service, different MAC in the body.
  const body = mac ? JSON.stringify({ ...safeJson(settings.wakeBody), mac, ip: ip || undefined }) : settings.wakeBody;
  const attempt = (url) => fetch(url, {
    method,
    body: method === 'GET' ? undefined : (body || undefined),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    signal: AbortSignal.timeout(6000),
  });
  let res;
  try {
    res = await attempt(settings.wakeUrl).catch((err) => {
      // Chrome OS also forwards Linux container ports to localhost; use that if the hostname fails.
      if (!settings.wakeUrl.includes('penguin.linux.test')) throw err;
      return attempt(settings.wakeUrl.replace('penguin.linux.test', 'localhost'));
    });
  } catch {
    const host = (() => { try { return new URL(settings.wakeUrl).host; } catch { return settings.wakeUrl; } })();
    throw new Error(host.startsWith('penguin.linux.test')
      ? "Can't reach the wake service. Open the Linux Terminal on the Surface (and run the install command once)."
      : `Can't reach the wake device at ${host}`);
  }
  if (!res.ok) throw new Error(`Wake request failed (HTTP ${res.status})`);
}
