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
  runAction(id) { return this.request(`/api/actions/${encodeURIComponent(id)}`, { method: 'POST', timeout: 15000 }); }
}

/** Fire the user's configured wake request (ESPHome button, phone script, HA webhook, ...). */
export async function sendWake(settings) {
  if (!settings.wakeUrl) throw new Error('Set a Wake URL in Settings');
  const method = settings.wakeMethod || 'POST';
  const res = await fetch(settings.wakeUrl, {
    method,
    body: method === 'GET' ? undefined : (settings.wakeBody || undefined),
    headers: settings.wakeBody ? { 'Content-Type': 'application/json' } : undefined,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Wake request failed (HTTP ${res.status})`);
}
