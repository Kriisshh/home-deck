// Air-conditioner controller on top of the Xiaomi cloud + the device's MIoT spec.

import { XiaomiCloud, acModelFromSpec, acReadList, loadSpec } from './xiaomi.js';

export class AirConditioner {
  constructor(cloud, did, model) {
    this.cloud = cloud;
    this.did = did;
    this.model = model;
    this.state = {};
    this.online = null;
  }

  static async fromSettings(settings) {
    if (!settings.acDid || !settings.acModel) throw new Error('Choose your AC in Settings');
    const cloud = new XiaomiCloud(settings.region);
    const model = acModelFromSpec(await loadSpec(settings.acModel));
    return new AirConditioner(cloud, settings.acDid, model);
  }

  async refresh() {
    const list = acReadList(this.model);
    const results = await this.cloud.getProps(this.did, list);
    const state = {};
    for (const r of results) {
      const item = list.find((l) => l.siid === r.siid && l.piid === r.piid);
      if (item && r.code === 0) state[item.key] = r.value;
    }
    this.online = results.some((r) => r.code === 0);
    this.state = state;
    return state;
  }

  /** changes: { key: value } where key is 'power' | 'mode' | ... | 'air-conditioner.eco' */
  async set(changes) {
    const props = Object.entries(changes).map(([key, value]) => {
      const prop = this.model[key] ?? this.model.toggles.find((t) => t.key === key)?.prop;
      if (!prop) throw new Error(`This AC has no ${key} control`);
      return { siid: prop.siid, piid: prop.piid, value };
    });
    await this.cloud.setProps(this.did, props);
    Object.assign(this.state, changes);
  }

  get tempStep() {
    return this.model.target?.range?.[2] || 0.5;
  }

  clampTemp(value) {
    const [min, max] = this.model.target?.range ?? [16, 31];
    const step = this.tempStep;
    return Math.min(max, Math.max(min, Math.round(value / step) * step));
  }

  togglePower() {
    return this.set({ power: !this.state.power });
  }

  nudgeTemp(direction) {
    return this.set({ target: this.clampTemp((this.state.target ?? 26) + direction * this.tempStep) });
  }

  fanOptions() {
    return this.model.fan?.options ?? [];
  }

  nudgeFan(direction) {
    const options = this.fanOptions();
    const idx = options.findIndex((o) => o.value === this.state.fan);
    const next = options[Math.min(options.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + direction))];
    return next ? this.set({ fan: next.value }) : Promise.resolve();
  }

  /** Selecting a mode while off also switches the AC on, like the remote does. */
  setMode(value) {
    return this.set(this.state.power ? { mode: value } : { power: true, mode: value });
  }
}
