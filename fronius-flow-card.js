/*!
 * Fronius Flow Card — https://github.com/tsrz/fronius-flow-card
 * Energy flow card for Home Assistant: the inverter in the middle, linked to solar, home, grid and battery.
 * Auto-detects the entities of the Fronius (official), Fronius Modbus and Solcast integrations.
 * MIT License. Not affiliated with or endorsed by Fronius International GmbH; "Fronius" and its logo are trademarks of their owner.
 */
const CARD_VERSION = "1.0.6";

const I18N = {
  en: {
    solar: "Solar", home: "Home", grid: "Grid", grid_in: "Grid import", grid_out: "Solar surplus",
    battery: "Battery", no_battery: "No battery", charging: "Charging", discharging: "Discharging",
    today: "Produced today", left_today: "Forecast left today", remaining: "{v} kWh left", peak: "Expected solar peak", lux: "Brightness",
    aria: "Energy flow between solar, home, grid and battery",
    name: "Fronius Flow Card", desc: "Inverter in the middle, linked to solar, home, grid and battery.",
    ed_entities: "Entities (leave empty to use the detected ones)", ed_detected: "Detected: {v}", ed_none: "nothing detected",
    ed_options: "Options", ed_split: "Split sensors (optional)", ed_optional: "Optional", ed_home_calc: "Optional: computed from the other flows when empty",
    ed_choose: "Nothing detected: choose your sensor", ed_unused_grid: "Not needed: the single grid sensor is used",
    ed_unused_battery: "Not needed: the single battery sensor is used", ed_pair_grid: "Detected: separate drawn / fed-in sensors",
    ed_pair_battery: "Detected: separate charge / discharge sensors", ed_split_help: "Only if your grid or battery power comes as two sensors (one per direction).",
  },
  fr: {
    solar: "Solaire", home: "Maison", grid: "Réseau", grid_in: "Achat réseau", grid_out: "Surplus solaire",
    battery: "Batterie", no_battery: "Pas de batterie", charging: "Charge", discharging: "Décharge",
    today: "Produit aujourd'hui", left_today: "Reste à produire", remaining: "reste {v} kWh", peak: "Pic solaire prévu", lux: "Luminosité",
    aria: "Flux d'énergie entre le solaire, la maison, le réseau et la batterie",
    name: "Fronius Flow Card", desc: "Onduleur au centre, relié au solaire, à la maison, au réseau et à la batterie.",
    ed_entities: "Entités (laisser vide pour utiliser celles détectées)", ed_detected: "Détecté : {v}", ed_none: "rien de détecté",
    ed_options: "Options", ed_split: "Capteurs séparés (facultatif)", ed_optional: "Facultatif", ed_home_calc: "Facultatif : calculée à partir des autres flux si vide",
    ed_choose: "Rien de détecté : choisissez votre capteur", ed_unused_grid: "Inutile : le capteur réseau unique est utilisé",
    ed_unused_battery: "Inutile : le capteur batterie unique est utilisé", ed_pair_grid: "Détecté : capteurs soutirage / injection séparés",
    ed_pair_battery: "Détecté : capteurs charge / décharge séparés", ed_split_help: "Seulement si la puissance du réseau ou de la batterie arrive en deux capteurs (un par sens).",
  },
};
const lang = (hass) => ((hass?.locale?.language || hass?.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en");
const t = (hass, key, vars = {}) => (I18N[lang(hass)][key] || I18N.en[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

const DEFAULTS = {
  auto_detect: true,
  solar_max: 5000,
  home_max: 10000,
  grid_max: 10000,
  min_flow: 20, // W: below this it is measurement noise, no dot moves
  invert_grid: false,
  invert_battery: false,
  inverter_label: "",
  inverter_logo: true,
  show_missing_battery: true, // false: without a battery, 3-element layout with the grid at the bottom centre
};

// Entity roles. "sign" is the sign convention of the detected entity (the card works with:
// grid > 0 = import, battery > 0 = discharge, home > 0 = consumption).
const ROLES = [
  "solar_entity", "grid_entity", "grid_import_entity", "grid_export_entity",
  "battery_entity", "battery_charge_entity", "battery_discharge_entity", "soc_entity",
  "home_entity", "today_entity", "remaining_entity", "peak_time_entity", "peak_power_entity", "lux_entity",
];

// ---------- auto-detection ----------
// hass.entities (entity registry, display part) gives platform and translation_key for each entity.
function detectEntities(hass) {
  const found = {};
  if (!hass?.entities) return found;
  const all = Object.values(hass.entities).filter((e) => e.entity_id?.startsWith("sensor.") && !e.hidden);
  const byKey = (platform, key) => all.find((e) => e.platform === platform && e.translation_key === key)?.entity_id;
  const byId = (platform, re) => all.find((e) => e.platform === platform && re.test(e.entity_id))?.entity_id;
  const set = (role, id) => { if (id && !found[role]) found[role] = id; };

  // Official Fronius integration (Solar API), "power flow" device.
  set("solar_entity", byKey("fronius", "power_photovoltaics"));
  set("grid_entity", byKey("fronius", "power_grid"));
  if (!found.grid_entity) {
    set("grid_import_entity", byKey("fronius", "power_grid_import"));
    set("grid_export_entity", byKey("fronius", "power_grid_export"));
  }
  set("battery_entity", byKey("fronius", "power_battery"));
  if (!found.battery_entity) {
    set("battery_charge_entity", byKey("fronius", "power_battery_charge"));
    set("battery_discharge_entity", byKey("fronius", "power_battery_discharge"));
  }
  set("home_entity", byKey("fronius", "power_load_consumed") || byKey("fronius", "power_load"));
  set("soc_entity", byKey("fronius", "state_of_charge"));
  set("today_entity", byKey("fronius", "energy_day"));

  // Fronius Modbus integration (no translation keys: entity id suffixes).
  set("solar_entity", byId("fronius_modbus", /_pv_power$/));
  set("soc_entity", byId("fronius_modbus", /_(state_of_charge|soc)$/));

  // Solcast PV Forecast.
  set("remaining_entity", byKey("solcast_solar", "forecast_remaining_today"));
  set("peak_time_entity", byKey("solcast_solar", "peak_w_time_today"));
  set("peak_power_entity", byKey("solcast_solar", "peak_w_today"));
  return found;
}

// ---------- helpers ----------
const usable = (s) => s && s.state !== "unavailable" && s.state !== "unknown" && s.state !== "";
const toW = (s) => {
  if (!usable(s)) return null;
  const v = Number(s.state);
  if (!Number.isFinite(v)) return null;
  const u = String(s.attributes?.unit_of_measurement || "W");
  return u === "kW" ? v * 1000 : u === "MW" ? v * 1e6 : v;
};
const toKWh = (s) => {
  if (!usable(s)) return null;
  const v = Number(s.state);
  if (!Number.isFinite(v)) return null;
  const u = String(s.attributes?.unit_of_measurement || "kWh");
  return u === "Wh" ? v / 1000 : u === "MWh" ? v * 1000 : v;
};

const CENTER = { x: 200, y: 170, r: 60 };
const NODES = {
  solar: { x: 70, y: 62, dy: -8, color: "#f5b800", labelY: 136 },
  home: { x: 330, y: 62, dy: -8, color: "#5ba7d6", labelY: 136 },
  grid: { x: 70, y: 278, dy: 28, color: "#9aa3a7", labelY: 196 },
  battery: { x: 330, y: 278, dy: 28, color: "#66bb6a", labelY: 196 },
};
const RING_R = 49;
const SEGMENTS = 24;

const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [(cx + r * Math.cos(a)).toFixed(2), (cy + r * Math.sin(a)).toFixed(2)];
};
const ring = (n) =>
  Array.from({ length: SEGMENTS }, (_, i) => {
    const [x1, y1] = polar(n.x, n.y, RING_R, (i * 360) / SEGMENTS + 1.6);
    const [x2, y2] = polar(n.x, n.y, RING_R, ((i + 1) * 360) / SEGMENTS - 1.6);
    return `<path class="seg" d="M${x1} ${y1} A${RING_R} ${RING_R} 0 0 1 ${x2} ${y2}"/>`;
  }).join("");
const link = (n) => {
  const dx = CENTER.x - n.x, dy = CENTER.y - n.y, len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len, r = RING_R + 8;
  return `M${(n.x + ux * r).toFixed(1)} ${(n.y + uy * r).toFixed(1)} L${(CENTER.x - ux * (CENTER.r + 4)).toFixed(1)} ${(CENTER.y - uy * (CENTER.r + 4)).toFixed(1)}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Inverter drawn after a Fronius GEN24: grey front, fan, button, dark band with the logo and an optional label.
const inverter = (label, logo) => `
  <rect x="160" y="116" width="80" height="88" rx="10" fill="#f4f5f6" stroke="#aeb4b8" stroke-width=".7"/>
  <rect x="166" y="122" width="68" height="74" rx="6" fill="#dfe2e4"/>
  <circle cx="200" cy="146" r="16" fill="#2a2f33"/>
  <circle cx="200" cy="146" r="12.5" fill="none" stroke="#7d868b" stroke-width=".7"/>
  <circle cx="200" cy="146" r="9" fill="none" stroke="#7d868b" stroke-width=".7"/>
  <circle cx="200" cy="146" r="5.5" fill="none" stroke="#7d868b" stroke-width=".7"/>
  <path d="M184 146 H216 M200 130 V162 M188.7 134.7 L211.3 157.3 M211.3 134.7 L188.7 157.3" stroke="#7d868b" stroke-width=".5"/>
  <circle cx="200" cy="146" r="2.2" fill="#aab1b5"/>
  <circle cx="172" cy="162" r="4.4" fill="#2a2f33"/>
  <rect x="169" y="161.2" width="6" height="1.6" rx=".8" fill="#c7ccd0"/>
  <rect x="166" y="176" width="68" height="20" fill="#3b4145"/>
  ${logo ? `<ellipse cx="200" cy="186" rx="11.5" ry="4.2" fill="#d7141f"/>
  <text x="200" y="187.7" text-anchor="middle" font-size="4.6" font-weight="700" font-style="italic" fill="#fff" font-family="Arial, sans-serif">Fronius</text>` : ""}
  ${label ? `<text x="${logo ? 229 : 200}" y="188" text-anchor="${logo ? "end" : "middle"}" font-size="${logo ? 3.8 : 5}" font-weight="700" fill="#e4e6e8" font-family="Arial, sans-serif">${esc(label)}</text>` : ""}
  <rect x="178" y="204" width="5" height="3" rx=".8" fill="#2a2f33"/>
  <rect x="217" y="204" width="5" height="3" rx=".8" fill="#2a2f33"/>`;

// Generic stacked battery (no brand logo).
const BATTERY = (() => {
  const x = 314, w = 32;
  const modules = Array.from({ length: 6 }, (_, i) => {
    const y = 230 + i * 7.1;
    return `<rect x="${x}" y="${y.toFixed(1)}" width="${w}" height="7.1" fill="#f3f4f5" stroke="#b5babe" stroke-width=".35"/>
      <rect x="${x + w - 4.5}" y="${(y + 2.6).toFixed(1)}" width="2.8" height="1.9" fill="#b5babe"/>`;
  }).join("");
  return `<rect x="${x}" y="220" width="${w}" height="10" rx="1.5" fill="#3b4145"/>
    <circle cx="318" cy="225" r=".9" fill="#c7ccd0"/><circle cx="342" cy="225" r=".9" fill="#4caf50"/>
    ${modules}
    <rect x="${x}" y="272.6" width="${w}" height="3.4" fill="#3b4145"/>
    <rect x="${x + 2}" y="276" width="2.4" height="2.4" fill="#70787d"/><rect x="${x + w - 4.4}" y="276" width="2.4" height="2.4" fill="#70787d"/>`;
})();

const PANEL = `
  <circle cx="86" cy="50" r="7" fill="#f5b800"/>
  <path d="M86 38.5 V41 M86 59 V61.5 M74.5 50 H77 M95 50 H97.5 M77.9 41.9 L79.6 43.6 M92.4 56.4 L94.1 58.1 M94.1 41.9 L92.4 43.6 M79.6 56.4 L77.9 58.1" stroke="#f5b800" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M52 54 L84 54 L96 86 L44 86 Z" fill="#1d3f66" stroke="#cfd6da" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M61.5 54 L56.5 86 M71.5 54 L70 86 M78 54 L83 86 M49.3 64.7 L87.9 64.7 M46.7 75.3 L92 75.3" stroke="#7fa6cc" stroke-width=".7"/>
  <path d="M70 86 V92 M62 92 H78" stroke="#8a9196" stroke-width="2" stroke-linecap="round"/>`;
const HOME = `<g transform="translate(306 46) scale(2)"><path d="M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z" fill="#5ba7d6"/></g>`;
const TOWER = `<g transform="translate(46 226) scale(2)"><path d="M8.28,5.45L6.5,4.55L7.76,2H16.23L17.5,4.55L15.72,5.44L15,4H9L8.28,5.45M18.62,8H14.09L13.3,5H10.7L9.91,8H5.38L4.1,10.55L5.89,11.44L6.62,10H17.38L18.1,11.45L19.89,10.56L18.62,8M17.77,22H15.7L15.46,21.1L12,15.9L8.53,21.1L8.3,22H6.23L9.12,11H11.19L10.83,12.35L12,14.1L13.16,12.35L12.81,11H14.88L17.77,22M11.4,15L10.5,13.65L9.32,18.13L11.4,15M14.68,18.12L13.5,13.64L12.6,15L14.68,18.12Z" fill="#9aa3a7"/></g>`;

class FroniusFlowCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("fronius-flow-card-editor");
  }

  // Pre-filled with the detected entities when the card is added from the card picker.
  static getStubConfig(hass) {
    return { ...detectEntities(hass) };
  }

  setConfig(config) {
    this._raw = { ...(config || {}) };
    this._config = { ...DEFAULTS, ...this._raw };
    this._built = false;
    this._lastSig = null;
    if (this._hass) this._resolve();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first || !this._ent) this._resolve();
    if (!this._built) this._render();
    const sig = Object.values(this._ent || {}).map((id) => hass.states[id]?.state ?? "").join("|") + lang(hass);
    if (sig !== this._lastSig) {
      this._lastSig = sig;
      this._update();
    }
  }

  getCardSize() { return 6; }
  getGridOptions() { return { columns: 12, rows: 6, min_columns: 6, min_rows: 5 }; }

  // Configured entities win; the detected ones fill the gaps (unless auto_detect: false).
  _resolve() {
    const c = this._config;
    const det = c.auto_detect === false ? {} : detectEntities(this._hass);
    const ent = {};
    for (const role of ROLES) {
      const v = c[role] !== undefined ? c[role] : det[role];
      if (v) ent[role] = v;
    }
    // A configured single entity replaces a detected pair (and vice versa).
    if (c.grid_entity) { delete ent.grid_import_entity; delete ent.grid_export_entity; }
    if (c.grid_import_entity || c.grid_export_entity) delete ent.grid_entity;
    if (c.battery_entity) { delete ent.battery_charge_entity; delete ent.battery_discharge_entity; }
    if (c.battery_charge_entity || c.battery_discharge_entity) delete ent.battery_entity;
    this._ent = ent;
    this._hasBattery = !!(ent.battery_entity || ent.battery_charge_entity || ent.battery_discharge_entity || ent.soc_entity);
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._hass) return;
    // Compact layout: no battery and show_missing_battery: false -> the grid moves to the bottom centre.
    const compact = this._config.show_missing_battery === false && !this._hasBattery;
    this._compact = compact;
    const layout = compact
      // Same centre-to-centre distance as solar and home (hypot(130, 108) ≈ 169), so the link has the same length.
      ? { solar: NODES.solar, home: NODES.home, grid: { ...NODES.grid, x: 200, y: CENTER.y + Math.round(Math.hypot(130, 108)), labelX: 92, labelY: 331 } }
      : NODES;
    const nodes = Object.entries(layout)
      .map(([key, n]) => `<g class="node" data-node="${key}" style="--c:${n.color}" tabindex="0" role="button">
          <circle class="hit" cx="${n.x}" cy="${n.y}" r="${RING_R + 7}"/>
          <circle class="outer" cx="${n.x}" cy="${n.y}" r="${RING_R + 6}"/>
          ${ring(n)}
          <circle class="inner" cx="${n.x}" cy="${n.y}" r="${RING_R - 8}"/>
          <g transform="translate(${n.x - NODES[key].x} ${n.y - NODES[key].y + n.dy})">${{ solar: PANEL, home: HOME, grid: TOWER, battery: BATTERY }[key]}</g>
          <text class="val" x="${n.labelX ?? n.x}" y="${n.labelY}" text-anchor="middle"></text>
          <text class="lab" x="${n.labelX ?? n.x}" y="${n.labelY + 15}" text-anchor="middle"></text>
        </g>`)
      .join("");
    const links = Object.entries(layout)
      .map(([key, n]) => `<g class="lk" data-link="${key}" style="--c:${n.color}"><path class="line" d="${link(n)}"/><path class="flow" data-flow="${key}" d="${link(n)}"/></g>`)
      .join("");
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; }
        ha-card { padding: 8px; box-sizing: border-box; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        svg { width: 100%; height: 100%; max-height: 100%; display: block; font-family: var(--paper-font-body1_-_font-family, Roboto, Arial, sans-serif); }
        .line { fill: none; stroke: var(--divider-color, rgba(127,127,127,.3)); stroke-width: 1; }
        .flow { fill: none; stroke: var(--c); stroke-width: 6; stroke-linecap: round; stroke-dasharray: .01 18; opacity: 0; }
        .flow.in, .flow.out { opacity: 1; animation: run var(--dur, 2s) linear infinite; }
        .flow.out { animation-direction: reverse; }
        @keyframes run { to { stroke-dashoffset: -18.01; } }
        @media (prefers-reduced-motion: reduce) { .flow.in, .flow.out { animation: none; } }
        .outer { fill: none; stroke: var(--c); stroke-width: .8; opacity: .55; }
        .inner { fill: var(--card-background-color, #1c1c1c); stroke: var(--c); stroke-width: .8; opacity: .95; }
        .hit { fill: transparent; }
        .seg { fill: none; stroke: var(--c); stroke-width: 9; opacity: .2; transition: opacity .4s; }
        .seg.on { opacity: 1; }
        .node, .today, .extra { cursor: pointer; outline: none; }
        .node:focus-visible .outer { stroke-width: 2; opacity: 1; }
        .val { font-size: 18px; font-weight: 600; fill: var(--primary-text-color); }
        .lab { font-size: 13px; fill: var(--secondary-text-color); }
        .today .big { font-size: 22px; font-weight: 600; fill: #f5b800; }
        .extra .mid { font-size: 15px; font-weight: 600; fill: var(--primary-text-color); }
        .today:focus-visible .big, .extra:focus-visible .mid { text-decoration: underline; }
        .hub { fill: var(--card-background-color, #1c1c1c); stroke: var(--divider-color, rgba(127,127,127,.4)); stroke-width: 1; }
        .hidden { display: none; }
        .dim { opacity: .3; filter: grayscale(1); }
      </style>
      <ha-card>
        <svg viewBox="0 0 400 ${compact ? 404 : 340}" role="img" aria-label="${esc(t(this._hass, "aria"))}">
          ${links}
          <circle class="hub" cx="${CENTER.x}" cy="${CENTER.y}" r="${CENTER.r}"/>
          <g transform="translate(0 10)">${inverter(this._config.inverter_label, this._config.inverter_logo !== false)}</g>
          ${nodes}
          <g class="extra" data-role="peak_time_entity" tabindex="0" role="button" transform="${compact ? "translate(112 52)" : ""}">
            <rect x="132" y="244" width="136" height="42" fill="transparent"/>
            <text class="lab" x="200" y="259" text-anchor="middle">${esc(t(this._hass, "peak"))}</text>
            <text class="mid peak" x="200" y="277" text-anchor="middle"></text>
          </g>
          <g class="extra" data-role="lux_entity" tabindex="0" role="button" transform="${compact ? "translate(112 50)" : ""}">
            <rect x="132" y="288" width="136" height="42" fill="transparent"/>
            <text class="lab" x="200" y="302" text-anchor="middle">${esc(t(this._hass, "lux"))}</text>
            <text class="mid lux" x="200" y="320" text-anchor="middle"></text>
          </g>
          <g class="today" data-role="today_entity" tabindex="0" role="button">
            <rect x="130" y="10" width="140" height="78" fill="transparent"/>
            <text class="lab ttl" x="200" y="26" text-anchor="middle">${esc(t(this._hass, "today"))}</text>
            <text class="big" x="200" y="51" text-anchor="middle"></text>
            <text class="lab rest" x="200" y="71" text-anchor="middle"></text>
          </g>
        </svg>
      </ha-card>`;
    const nodeRole = { solar: "solar_entity", home: "home_entity", grid: "grid_entity", battery: "soc_entity" };
    const bind = (el, roleFn) => {
      const open = () => {
        const id = roleFn();
        if (id) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: id }, bubbles: true, composed: true }));
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    };
    this.shadowRoot.querySelectorAll("[data-role]").forEach((g) => bind(g, () => this._ent?.[g.dataset.role]));
    this.shadowRoot.querySelectorAll(".node").forEach((g) =>
      bind(g, () => {
        const e = this._ent || {};
        const k = g.dataset.node;
        if (k === "grid") return e.grid_entity || e.grid_import_entity;
        if (k === "battery") return e.soc_entity || e.battery_entity || e.battery_discharge_entity;
        return e[nodeRole[k]] || (k === "home" ? e.grid_entity : undefined);
      })
    );
    this._built = true;
    this._update();
  }

  _node(key, fraction, value, label) {
    const g = this.shadowRoot.querySelector(`[data-node="${key}"]`);
    const lit = Math.ceil(Math.max(0, Math.min(1, fraction)) * SEGMENTS);
    g.querySelectorAll(".seg").forEach((seg, i) => seg.classList.toggle("on", i < lit));
    g.querySelector(".val").textContent = value;
    g.querySelector(".lab").textContent = label;
  }

  // direction: "in" towards the inverter, "out" towards the device. Faster when the power is higher.
  _flow(key, w, direction) {
    const path = this.shadowRoot.querySelector(`[data-flow="${key}"]`);
    const active = Math.abs(w) >= this._config.min_flow;
    path.classList.toggle("in", active && direction === "in");
    path.classList.toggle("out", active && direction === "out");
    path.style.setProperty("--dur", `${Math.round(Math.max(0.5, 2.5 - Math.abs(w) / 2000) * 2) / 2}s`);
  }

  _fmt(v, d) {
    return Number(v).toLocaleString(this._hass?.locale?.language || undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  _power(w) {
    const a = Math.abs(w);
    return a < 1000 ? `${this._fmt(a, 0)} W` : `${this._fmt(a / 1000, 2)} kW`;
  }

  _update() {
    if (!this._hass || !this._built || !this._ent) return;
    const c = this._config, e = this._ent, st = this._hass.states, h = this._hass;
    if ((c.show_missing_battery === false && !this._hasBattery) !== !!this._compact) return this._render();
    const w = (id) => (id ? toW(st[id]) : null);

    const solar = Math.max(0, w(e.solar_entity) ?? 0);
    let grid = e.grid_entity ? w(e.grid_entity) ?? 0 : (w(e.grid_import_entity) ?? 0) - (w(e.grid_export_entity) ?? 0);
    if (c.invert_grid) grid = -grid;
    let battery = e.battery_entity ? w(e.battery_entity) ?? 0 : (w(e.battery_discharge_entity) ?? 0) - (w(e.battery_charge_entity) ?? 0);
    if (c.invert_battery) battery = -battery;
    // Home: its own sensor (Fronius "load" is negative, hence abs), otherwise the balance of the other flows.
    const homeOwn = w(e.home_entity);
    const home = homeOwn != null ? Math.abs(homeOwn) : Math.max(0, solar + grid + battery);

    const share = (v, max) => (Math.abs(v) < c.min_flow ? 0 : Math.abs(v) / max);
    this._node("solar", share(solar, c.solar_max), this._power(solar), t(h, "solar"));
    this._node("home", share(home, c.home_max), this._power(home), t(h, "home"));
    const gridActive = Math.abs(grid) >= c.min_flow;
    this._node("grid", share(grid, c.grid_max), this._power(grid), !gridActive ? t(h, "grid") : grid > 0 ? t(h, "grid_in") : t(h, "grid_out"));

    // Without a battery, the battery stays drawn but greyed out, with no flow.
    const showBat = this._hasBattery;
    if (!this._compact) {
      this.shadowRoot.querySelector('[data-node="battery"]').classList.toggle("dim", !showBat);
      this.shadowRoot.querySelector('[data-link="battery"]').classList.toggle("dim", !showBat);
      if (!showBat) this._node("battery", 0, "–", t(h, "no_battery"));
    }
    if (showBat) {
      const soc = e.soc_entity ? st[e.soc_entity] : null;
      const batActive = Math.abs(battery) >= c.min_flow;
      const socText = usable(soc) ? ` · ${this._fmt(soc.state, 0)} %` : "";
      const state = !batActive ? t(h, "battery") : battery > 0 ? t(h, "discharging") : t(h, "charging");
      this._node("battery", usable(soc) ? Number(soc.state) / 100 : share(battery, c.grid_max), this._power(battery), `${state}${socText}`);
    }

    // Top: energy produced today and Solcast remaining forecast.
    const todayG = this.shadowRoot.querySelector(".today");
    const produced = e.today_entity ? toKWh(st[e.today_entity]) : null;
    const left = e.remaining_entity ? toKWh(st[e.remaining_entity]) : null;
    todayG.classList.toggle("hidden", produced == null && left == null);
    // Without a "produced today" sensor, the forecast left today takes the big line.
    const onlyLeft = produced == null && left != null;
    todayG.querySelector(".ttl").textContent = t(h, onlyLeft ? "left_today" : "today");
    todayG.querySelector(".big").textContent = `${this._fmt(onlyLeft ? left : produced ?? 0, 1)} kWh`;
    todayG.querySelector(".rest").textContent = !onlyLeft && left != null ? t(h, "remaining", { v: this._fmt(left, 1) }) : "";

    // Bottom: Solcast peak and an optional brightness sensor.
    const peakG = this.shadowRoot.querySelector('[data-role="peak_time_entity"]');
    const pt = e.peak_time_entity ? st[e.peak_time_entity] : null;
    const pp = e.peak_power_entity ? w(e.peak_power_entity) : null;
    const hour = usable(pt) && !Number.isNaN(new Date(pt.state).getTime())
      ? new Date(pt.state).toLocaleTimeString(h.locale?.language || undefined, { hour: "2-digit", minute: "2-digit" })
      : null;
    peakG.classList.toggle("hidden", hour == null && pp == null);
    peakG.querySelector(".peak").textContent = [hour, pp != null ? this._power(pp) : null].filter(Boolean).join(" · ");

    const luxG = this.shadowRoot.querySelector('[data-role="lux_entity"]');
    const lux = e.lux_entity ? st[e.lux_entity] : null;
    luxG.classList.toggle("hidden", !e.lux_entity);
    luxG.querySelector(".lux").textContent = usable(lux) ? `${this._fmt(lux.state, 0)} lx` : "–";

    this._flow("solar", solar, "in");
    this._flow("home", home, "out");
    this._flow("grid", grid, grid > 0 ? "in" : "out");
    if (!this._compact) this._flow("battery", showBat ? battery : 0, battery > 0 ? "in" : "out");
  }
}

// ---------- visual editor ----------
const EDITOR_LABELS = {
  en: {
    solar_entity: "Solar power", grid_entity: "Grid power (+ drawn / − fed in)", grid_import_entity: "Power drawn from the grid (import)",
    grid_export_entity: "Power fed into the grid (export)", battery_entity: "Battery power (+ discharge / − charge)",
    battery_charge_entity: "Battery charging power", battery_discharge_entity: "Battery discharging power",
    soc_entity: "Battery state of charge (%)", home_entity: "Home consumption (empty = computed)",
    today_entity: "Energy produced today", remaining_entity: "Forecast remaining today (Solcast)",
    peak_time_entity: "Expected peak time (Solcast)", peak_power_entity: "Expected peak power (Solcast)",
    lux_entity: "Brightness sensor", auto_detect: "Auto-detect missing entities", invert_grid: "Invert grid sign",
    invert_battery: "Invert battery sign", show_missing_battery: "Without a battery, show it greyed out (off: grid at the bottom centre)", inverter_logo: "Show the Fronius logo on the inverter", inverter_label: "Text on the inverter (e.g. PRIMO)", solar_max: "Solar ring max (W)",
    home_max: "Home ring max (W)", grid_max: "Grid ring max (W)", min_flow: "Minimum flow shown (W)",
  },
  fr: {
    solar_entity: "Puissance solaire", grid_entity: "Puissance réseau (+ soutirage / − injection)", grid_import_entity: "Puissance soutirée du réseau (achat)",
    grid_export_entity: "Puissance injectée dans le réseau (vente)", battery_entity: "Puissance batterie (+ décharge / − charge)",
    battery_charge_entity: "Puissance de charge de la batterie", battery_discharge_entity: "Puissance de décharge de la batterie",
    soc_entity: "Charge de la batterie (%)", home_entity: "Consommation maison (vide = calculée)",
    today_entity: "Énergie produite aujourd'hui", remaining_entity: "Prévision restante aujourd'hui (Solcast)",
    peak_time_entity: "Heure du pic prévu (Solcast)", peak_power_entity: "Puissance du pic prévu (Solcast)",
    lux_entity: "Capteur de luminosité", auto_detect: "Détecter automatiquement les entités manquantes", invert_grid: "Inverser le signe du réseau",
    invert_battery: "Inverser le signe de la batterie", show_missing_battery: "Sans batterie, l'afficher en grisé (sinon : réseau en bas au centre)", inverter_logo: "Afficher le logo Fronius sur l'onduleur", inverter_label: "Texte sur l'onduleur (ex. PRIMO)", solar_max: "Maximum de l'anneau solaire (W)",
    home_max: "Maximum de l'anneau maison (W)", grid_max: "Maximum de l'anneau réseau (W)", min_flow: "Flux minimum affiché (W)",
  },
};

class FroniusFlowCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._draw();
  }
  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass; else this._draw();
  }
  _schema() {
    const ent = (name) => ({ name, selector: { entity: { domain: "sensor" } } });
    return [
      { type: "expandable", name: "", title: t(this._hass, "ed_entities"), expanded: true, schema: [
        ent("solar_entity"), ent("grid_entity"), ent("battery_entity"), ent("soc_entity"),
        ent("home_entity"), ent("today_entity"), ent("remaining_entity"), ent("peak_time_entity"),
        ent("peak_power_entity"), ent("lux_entity"),
      ] },
      { type: "expandable", name: "", title: t(this._hass, "ed_split"), schema: [
        { type: "constant", name: "split_help", value: t(this._hass, "ed_split_help") },
        ent("grid_import_entity"), ent("grid_export_entity"),
        ent("battery_charge_entity"), ent("battery_discharge_entity"),
      ] },
      { type: "expandable", name: "", title: t(this._hass, "ed_options"), schema: [
        { name: "auto_detect", selector: { boolean: {} } },
        { name: "invert_grid", selector: { boolean: {} } },
        { name: "invert_battery", selector: { boolean: {} } },
        { name: "show_missing_battery", selector: { boolean: {} } },
        { name: "inverter_logo", selector: { boolean: {} } },
        { name: "inverter_label", selector: { text: {} } },
        { type: "grid", name: "", schema: [
          { name: "solar_max", selector: { number: { min: 500, max: 100000, step: 100, mode: "box" } } },
          { name: "home_max", selector: { number: { min: 500, max: 100000, step: 100, mode: "box" } } },
          { name: "grid_max", selector: { number: { min: 500, max: 100000, step: 100, mode: "box" } } },
          { name: "min_flow", selector: { number: { min: 0, max: 1000, step: 1, mode: "box" } } },
        ] },
      ] },
    ];
  }
  // Text under each entity field: what is detected, or why the field can stay empty.
  _helper(name) {
    if (!ROLES.includes(name) || this._config[name]) return undefined;
    const c = this._config;
    const det = c.auto_detect === false ? {} : detectEntities(this._hass);
    const has = (k) => !!(c[k] || det[k]);
    const h = (k, vars) => t(this._hass, k, vars);
    if (name === "grid_import_entity" || name === "grid_export_entity") {
      if (c.grid_entity || (!c.grid_import_entity && !c.grid_export_entity && det.grid_entity)) return h("ed_unused_grid");
      return det[name] ? h("ed_detected", { v: det[name] }) : h("ed_optional");
    }
    if (name === "battery_charge_entity" || name === "battery_discharge_entity") {
      if (c.battery_entity || (!c.battery_charge_entity && !c.battery_discharge_entity && det.battery_entity)) return h("ed_unused_battery");
      return det[name] ? h("ed_detected", { v: det[name] }) : h("ed_optional");
    }
    if (det[name]) return h("ed_detected", { v: det[name] });
    if (name === "grid_entity" && (has("grid_import_entity") || has("grid_export_entity"))) return h("ed_pair_grid");
    if (name === "battery_entity" && (has("battery_charge_entity") || has("battery_discharge_entity"))) return h("ed_pair_battery");
    if (name === "home_entity") return h("ed_home_calc");
    if (name === "solar_entity" || name === "grid_entity") return h("ed_choose");
    return h("ed_optional");
  }

  _draw() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[lang(this._hass)][s.name] || EDITOR_LABELS.en[s.name] || s.name;
      this._form.computeHelper = (s) => this._helper(s.name);
      this._form.addEventListener("value-changed", (ev) => {
        const cfg = { ...ev.detail.value };
        // Keep the YAML short: drop empty values and values equal to the defaults.
        for (const k of Object.keys(cfg)) {
          if (cfg[k] === "" || cfg[k] === undefined || cfg[k] === null || cfg[k] === DEFAULTS[k] || k === "split_help") delete cfg[k];
        }
        this._config = cfg;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = { ...DEFAULTS, ...this._config };
    this._form.schema = this._schema();
  }
}

if (!customElements.get("fronius-flow-card")) customElements.define("fronius-flow-card", FroniusFlowCard);
if (!customElements.get("fronius-flow-card-editor")) customElements.define("fronius-flow-card-editor", FroniusFlowCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "fronius-flow-card")) {
  window.customCards.push({
    type: "fronius-flow-card",
    name: "Fronius Flow Card",
    description: "Energy flow: inverter in the middle, linked to solar, home, grid and battery.",
    preview: true,
    documentationURL: "https://github.com/tsrz/fronius-flow-card",
  });
}
console.info(`%c FRONIUS-FLOW-CARD %c ${CARD_VERSION} `, "color:#fff;background:#d7141f;font-weight:700", "color:#d7141f;background:#fff");
