// Shortcut editor: add, remove, reorder and group buttons; choose each button's icon, what it does,
// which F13-F24 key it sends and an optional Surface keyboard shortcut. Saves to the PC agent,
// which validates everything (see Actions.save in agent.py).

export const ICONS = [
  'mic', 'headphones', 'chat', 'keyboard', 'scissors', 'camera', 'video', 'record', 'desktop', 'app',
  'activity', 'calculator', 'globe', 'folder', 'gamepad', 'music', 'speaker-wave', 'text', 'terminal',
  'code', 'star', 'bolt', 'home', 'lock', 'moon', 'power', 'reload', 'layers',
];

const TYPE_ICON = {
  hotkey: 'keyboard', text: 'text', media: 'music', volume: 'speaker-wave', mic_mute: 'mic',
  screenshot: 'scissors', show_desktop: 'desktop', task_manager: 'activity', open: 'globe', lock: 'lock',
  sleep: 'moon', shutdown: 'power', restart: 'reload', run: 'app', shell: 'terminal', multi: 'layers',
};

export const iconFor = (a) => (ICONS.includes(a.icon) ? a.icon : TYPE_ICON[a.type] || 'bolt');

const TYPES = [
  ['hotkey', 'Keybind (F13–F24)'], ['media', 'Spotify control'], ['volume', 'Volume'], ['mic_mute', 'Mic mute'],
  ['screenshot', 'Screenshot'], ['show_desktop', 'Show desktop'], ['task_manager', 'Task Manager'],
  ['open', 'Open link'], ['text', 'Type text'], ['lock', 'Lock PC'], ['sleep', 'Sleep PC'],
  ['shutdown', 'Shut down PC'], ['restart', 'Restart PC'],
];
const MEDIA = [['play_pause', 'Play / Pause'], ['next', 'Next track'], ['previous', 'Previous track'], ['shuffle', 'Shuffle'], ['repeat', 'Repeat']];
const VOLUME = [
  ['app-up', 'Spotify volume up', { target: 'app', delta: 0.05 }], ['app-down', 'Spotify volume down', { target: 'app', delta: -0.05 }],
  ['app-mute', 'Spotify mute', { target: 'app', muted: 'toggle' }], ['system-up', 'PC volume up', { target: 'system', delta: 0.05 }],
  ['system-down', 'PC volume down', { target: 'system', delta: -0.05 }], ['system-mute', 'PC mute', { target: 'system', muted: 'toggle' }],
];
const FKEYS = Array.from({ length: 12 }, (_, i) => `f${13 + i}`);
const MODIFIERS = ['ctrl', 'shift', 'alt'];

const pretty = (keys) => keys.map((k) => (k.length <= 3 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+');
const volumeChoice = (a) => VOLUME.find(([, , v]) => v.target === (a.target || 'system') && v.delta === a.delta && v.muted === a.muted)?.[0] ?? 'system-up';

export function describe(a) {
  let text;
  if (a.locked) text = 'Runs a program (set on the PC)';
  else if (a.type === 'hotkey') text = `Sends ${pretty(a.keys || [])}`;
  else if (a.type === 'media') text = MEDIA.find(([v]) => v === a.command)?.[1] ?? 'Spotify control';
  else if (a.type === 'volume') text = VOLUME.find(([v]) => v === volumeChoice(a))?.[1] ?? 'Volume';
  else if (a.type === 'open') text = `Opens ${(a.target || '').replace(/^https?:\/\//, '').split('/')[0]}`;
  else if (a.type === 'text') text = `Types “${(a.text || '').slice(0, 24)}”`;
  else text = TYPES.find(([v]) => v === a.type)?.[1] ?? a.type;
  return a.key ? `${text} · Surface ${pretty(a.key.split('+'))}` : text;
}

export class DeckEditor {
  /** deps: { dialog, getActions, save(actions) → Promise<actions>, el, icon, toast, eventCombo } */
  constructor(deps) {
    Object.assign(this, deps);
    this.body = this.dialog.querySelector('.sheet-body');
    this.bar = this.dialog.querySelector('.sheet-bar');
    this.dialog.addEventListener('keydown', (e) => this.onRecordKey(e), true);
  }

  open() {
    this.draft = structuredClone(this.getActions());
    this.groups = [...new Set(this.draft.map((a) => a.group || ''))];
    if (!this.groups.length) this.groups = [''];
    this.error = '';
    this.showList();
    this.dialog.showModal();
  }

  // ------------------------------------------------------------------ helpers

  inGroup(g) { return this.draft.filter((a) => (a.group || '') === g); }

  flatten() {
    return this.groups.flatMap((g) => this.inGroup(g).map((a) => ({ ...a, group: g || undefined })));
  }

  freeFKey() {
    const used = new Set(this.draft.filter((a) => a.type === 'hotkey' && a.keys?.length === 1).map((a) => a.keys[0]));
    return FKEYS.find((k) => !used.has(k)) || 'f13';
  }

  conflicts(a) {
    const out = [];
    const same = (x, y) => x && y && x.join('+') === y.join('+');
    for (const b of this.draft) {
      if (b === a) continue;
      if (a.type === 'hotkey' && b.type === 'hotkey' && same(a.keys, b.keys)) out.push(`${pretty(a.keys)} is also sent by “${b.label}”`);
      if (a.key && a.key === b.key) out.push(`${pretty(a.key.split('+'))} on the Surface also triggers “${b.label}”`);
    }
    return out;
  }

  setBar(left, title, right) {
    const { el } = this;
    this.bar.replaceChildren(left ?? el('span'), el('h2', {}, title), right ?? el('span'));
  }

  move(list, item, dir) {
    const i = list.indexOf(item);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  }

  moveInGroup(a, dir) {
    const group = this.inGroup(a.group || '');
    const other = group[group.indexOf(a) + dir];
    if (!other) return;
    const i = this.draft.indexOf(a);
    const j = this.draft.indexOf(other);
    [this.draft[i], this.draft[j]] = [this.draft[j], this.draft[i]];
  }

  // ------------------------------------------------------------------ list view

  showList() {
    const { el, icon } = this;
    this.view = 'list';
    this.current = null;
    this.setBar(
      el('button', { type: 'button', class: 'bar-btn', onclick: () => this.dialog.close() }, 'Cancel'),
      'Edit Shortcuts',
      el('button', { type: 'button', class: 'bar-btn strong', onclick: () => this.saveAll() }, 'Save'),
    );
    const nodes = [];
    if (this.error) nodes.push(el('p', { class: 'group-foot err editor-error' }, this.error));

    this.groups.forEach((g, gi) => {
      const items = this.inGroup(g);
      const title = el('div', { class: 'group-title editor-group' },
        el('input', {
          class: 'group-name', value: g, placeholder: 'No group', 'aria-label': 'Group name',
          onchange: (e) => this.renameGroup(g, e.target.value),
        }),
        el('button', { type: 'button', class: 'mini-btn', title: 'Move group up', disabled: gi === 0, onclick: () => { this.move(this.groups, g, -1); this.showList(); } }, icon('up')),
        el('button', { type: 'button', class: 'mini-btn', title: 'Move group down', disabled: gi === this.groups.length - 1, onclick: () => { this.move(this.groups, g, 1); this.showList(); } }, icon('down')),
        el('button', { type: 'button', class: 'mini-btn danger', title: 'Delete group', onclick: (e) => this.deleteGroup(g, e.currentTarget) }, icon('trash')),
      );
      const rows = items.map((a, i) => el('div', { class: 'row editor-row' },
        el('button', { type: 'button', class: 'editor-open', onclick: () => this.showForm(a) },
          el('span', { class: 'editor-icon' }, icon(iconFor(a))),
          el('span', { class: 'editor-text' }, el('b', {}, a.label), el('small', {}, describe(a))),
          icon('chevron')),
        el('button', { type: 'button', class: 'mini-btn', title: 'Move up', disabled: i === 0, onclick: () => { this.moveInGroup(a, -1); this.showList(); } }, icon('up')),
        el('button', { type: 'button', class: 'mini-btn', title: 'Move down', disabled: i === items.length - 1, onclick: () => { this.moveInGroup(a, 1); this.showList(); } }, icon('down')),
      ));
      rows.push(el('button', { type: 'button', class: 'row row-action', onclick: () => this.addButton(g) }, '+ Add Button'));
      nodes.push(title, el('div', { class: 'group' }, ...rows));
    });
    nodes.push(el('div', { class: 'group editor-add-group' },
      el('button', { type: 'button', class: 'row row-action', onclick: () => this.addGroup() }, '+ Add Group')));

    // Function key overview
    const byCombo = new Map();
    for (const a of this.draft) {
      if (a.type !== 'hotkey' || !a.keys?.length) continue;
      const combo = a.keys.join('+');
      byCombo.set(combo, [...(byCombo.get(combo) || []), a]);
    }
    const combos = [...FKEYS, ...[...byCombo.keys()].filter((c) => !FKEYS.includes(c))];
    nodes.push(el('div', { class: 'group-title' }, 'Function Keys'));
    nodes.push(el('div', { class: 'group' }, ...combos.map((combo) => {
      const users = byCombo.get(combo) || [];
      return el('button', {
        type: 'button', class: 'row keys-row fkey-row',
        onclick: () => (users.length ? this.showForm(users[0]) : this.addButton(this.groups[0] ?? '', combo.split('+'))),
      },
      el('kbd', {}, pretty(combo.split('+'))),
      el('span', { class: users.length ? '' : 'muted' }, users.length ? users.map((u) => u.label).join(', ') : 'Unused - tap to add'),
      users.length > 1 ? el('span', { class: 'warn' }, 'Conflict') : null);
    })));
    nodes.push(el('p', { class: 'group-foot' },
      'F13–F24 exist in Windows but not on keyboards, so no game uses them. To bind one in an app (Discord, OBS…), start recording a keybind there and tap the button on the Surface. Buttons that run programs can be renamed, moved or deleted here, but only added in config.json on the PC.'));
    this.body.replaceChildren(...nodes);
  }

  renameGroup(oldName, value) {
    const name = value.trim().slice(0, 30);
    if (name !== oldName && this.groups.includes(name)) {
      this.toast('A group with that name already exists', true);
      return this.showList();
    }
    this.groups[this.groups.indexOf(oldName)] = name;
    for (const a of this.inGroup(oldName)) a.group = name;
    this.showList();
  }

  deleteGroup(g, button) {
    const count = this.inGroup(g).length;
    if (count && !button.classList.contains('armed')) {
      button.classList.add('armed');
      this.toast(`Tap delete again to remove the group and its ${count} button${count === 1 ? '' : 's'}`);
      setTimeout(() => button.classList.remove('armed'), 3000);
      return;
    }
    this.draft = this.draft.filter((a) => (a.group || '') !== g);
    this.groups = this.groups.filter((x) => x !== g);
    if (!this.groups.length) this.groups = [''];
    this.showList();
  }

  addGroup() {
    let name = 'New Group';
    for (let n = 2; this.groups.includes(name); n++) name = `New Group ${n}`;
    this.groups.push(name);
    this.showList();
    const inputs = this.body.querySelectorAll('.group-name');
    inputs[inputs.length - 1]?.select();
  }

  addButton(group, keys) {
    const a = { id: `b${Date.now().toString(36)}`, label: 'New Button', type: 'hotkey', keys: keys || [this.freeFKey()], icon: 'keyboard', group, isNew: true };
    this.draft.push(a);
    this.showForm(a);
  }

  // ------------------------------------------------------------------ button form

  showForm(a) {
    const { el, icon } = this;
    this.view = 'form';
    this.current = a;
    this.recording = false;
    this.setBar(
      el('button', { type: 'button', class: 'bar-btn', onclick: () => this.leaveForm() }, icon('back'), 'Shortcuts'),
      a.isNew ? 'New Button' : 'Edit Button',
      el('button', { type: 'button', class: 'bar-btn strong', onclick: () => this.leaveForm() }, 'Done'),
    );
    const row = (label, ...control) => el('div', { class: 'row' }, el('span', { class: 'row-label' }, label), ...control);
    const nodes = [];

    // Name + icon
    nodes.push(el('div', { class: 'group' },
      row('Name', el('input', { value: a.label, maxlength: 40, oninput: (e) => { a.label = e.target.value; } })),
      el('div', { class: 'row icon-grid' }, ...ICONS.map((name) => el('button', {
        type: 'button', class: 'icon-choice', 'aria-pressed': String(iconFor(a) === name), title: name,
        onclick: (e) => { a.icon = name; this.body.querySelectorAll('.icon-choice').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); },
      }, icon(name))))));

    // What it does
    nodes.push(el('div', { class: 'group-title' }, 'Action'));
    const params = el('div', { class: 'group' });
    if (a.locked) {
      params.append(row('Does', el('span', { class: 'row-value' }, 'Runs a program (set on the PC)')));
    } else {
      params.append(row('Does', el('select', { onchange: (e) => { this.changeType(a, e.target.value); this.showForm(a); } },
        ...TYPES.map(([v, label]) => el('option', { value: v, selected: a.type === v }, label)))));
      this.paramRows(a, params, row);
    }
    nodes.push(params);

    // Options
    nodes.push(el('div', { class: 'group-title' }, 'Options'));
    const keyLabel = el('kbd', {}, a.key ? pretty(a.key.split('+')) : 'None');
    this.keyLabel = keyLabel;
    nodes.push(el('div', { class: 'group' },
      row('Group', el('select', { onchange: (e) => { a.group = e.target.value; } },
        ...this.groups.map((g) => el('option', { value: g, selected: (a.group || '') === g }, g || 'No group')))),
      el('label', { class: 'row' }, el('span', { class: 'row-label' }, 'Ask Before Running'),
        el('input', { type: 'checkbox', class: 'switch', checked: !!a.confirm, onchange: (e) => { a.confirm = e.target.checked; } })),
      row('Surface Key', keyLabel,
        el('button', { type: 'button', class: 'link-btn', onclick: (e) => this.startRecording(e.currentTarget) }, 'Record'),
        a.key ? el('button', { type: 'button', class: 'link-btn danger', onclick: () => { delete a.key; this.showForm(a); } }, 'Clear') : null)));
    const warnings = this.conflicts(a);
    nodes.push(el('p', { class: `group-foot ${warnings.length ? 'err' : ''}` },
      warnings.length ? warnings.join('. ') : 'Surface Key is an optional keyboard shortcut on the Surface that presses this button. Use a combo like Ctrl+Shift+1 so it never fires by accident.'));

    nodes.push(el('div', { class: 'group' }, el('button', {
      type: 'button', class: 'row row-action destructive', onclick: () => { this.draft.splice(this.draft.indexOf(a), 1); this.showList(); },
    }, 'Delete Button')));
    this.body.replaceChildren(...nodes);
    this.body.scrollTop = 0;
  }

  paramRows(a, params, row) {
    const { el } = this;
    switch (a.type) {
      case 'hotkey': {
        const keys = a.keys || [];
        const main = keys.find((k) => !MODIFIERS.includes(k)) || 'f13';
        const isF = FKEYS.includes(main);
        const custom = el('input', {
          value: keys.join('+'), placeholder: 'e.g. ctrl+shift+m', spellcheck: 'false',
          onchange: (e) => { a.keys = e.target.value.toLowerCase().split('+').map((k) => k.trim()).filter(Boolean); this.showForm(a); },
        });
        params.append(
          row('Key', el('select', {
            onchange: (e) => {
              a.keys = e.target.value === 'custom' ? keys.filter((k) => MODIFIERS.includes(k)).concat('m') : [...keys.filter((k) => MODIFIERS.includes(k)), e.target.value];
              this.showForm(a);
            },
          }, ...FKEYS.map((k) => el('option', { value: k, selected: isF && main === k }, k.toUpperCase())),
          el('option', { value: 'custom', selected: !isF }, 'Other key…'))),
          row('With', el('div', { class: 'segmented small multi' }, ...MODIFIERS.map((m) => el('label', {},
            el('input', {
              type: 'checkbox', checked: keys.includes(m),
              onchange: (e) => { a.keys = e.target.checked ? [m, ...keys.filter((k) => k !== m)] : keys.filter((k) => k !== m); this.showForm(a); },
            }), el('span', {}, m[0].toUpperCase() + m.slice(1)))))),
        );
        if (!isF) params.append(row('Combo', custom));
        break;
      }
      case 'media':
        params.append(row('Control', el('select', { onchange: (e) => { a.command = e.target.value; } },
          ...MEDIA.map(([v, label]) => el('option', { value: v, selected: a.command === v }, label)))));
        break;
      case 'volume':
        params.append(row('Change', el('select', {
          onchange: (e) => {
            const [, , v] = VOLUME.find(([k]) => k === e.target.value);
            delete a.delta; delete a.muted; delete a.level;
            Object.assign(a, v);
          },
        }, ...VOLUME.map(([v, label]) => el('option', { value: v, selected: volumeChoice(a) === v }, label)))));
        break;
      case 'open':
        params.append(row('Link', el('input', { value: a.target || '', placeholder: 'https://… or steam://…', spellcheck: 'false', oninput: (e) => { a.target = e.target.value.trim(); } })));
        break;
      case 'text':
        params.append(row('Text', el('input', { value: a.text || '', placeholder: 'Text to type', oninput: (e) => { a.text = e.target.value; } })));
        break;
      default:
        break;
    }
  }

  changeType(a, type) {
    for (const k of ['keys', 'command', 'target', 'level', 'delta', 'muted', 'text', 'delay']) delete a[k];
    a.type = type;
    if (type === 'hotkey') a.keys = [this.freeFKey()];
    if (type === 'media') a.command = 'play_pause';
    if (type === 'volume') Object.assign(a, VOLUME[0][2]);
    if (type === 'open') a.target = 'https://';
    if (!a.icon || Object.values(TYPE_ICON).includes(a.icon)) a.icon = TYPE_ICON[type];
    if (a.label === 'New Button' || TYPES.some(([, label]) => label === a.label)) a.label = TYPES.find(([v]) => v === type)[1].replace(' (F13–F24)', '');
  }

  leaveForm() {
    const a = this.current;
    if (!a.label.trim()) return this.toast('Give the button a name', true);
    if (a.type === 'hotkey' && !a.keys?.length) return this.toast('Choose a key', true);
    delete a.isNew;
    this.showList();
  }

  // ------------------------------------------------------------------ Surface key recording

  startRecording(button) {
    this.recording = true;
    this.recordButton = button;
    button.textContent = 'Press keys…';
    this.keyLabel.textContent = '…';
  }

  onRecordKey(e) {
    if (!this.recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    this.recording = false;
    if (e.key === 'Escape') return this.showForm(this.current);
    const combo = this.eventCombo(e);
    const hasModifier = /^(ctrl|alt|meta)\+/.test(combo) || /^f([1-9]|1\d|2[0-4])$/.test(combo.split('+').pop()) || combo.startsWith('shift+f');
    if (!hasModifier) {
      this.toast('Use a combo with Ctrl or Alt (or an F-key) so it never fires by accident', true);
      return this.showForm(this.current);
    }
    this.current.key = combo;
    this.showForm(this.current);
  }

  // ------------------------------------------------------------------ save

  async saveAll() {
    const actions = this.flatten().map(({ isNew, ...a }) => a);
    try {
      await this.save(actions);
      this.dialog.close();
      this.toast('Shortcuts saved');
    } catch (err) {
      this.error = err.message;
      this.showList();
      this.body.scrollTop = 0;
    }
  }
}
