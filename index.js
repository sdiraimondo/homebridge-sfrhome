// homebridge-sfrhome / index.js
// v0.3.5 — Fusion "Nom" + "Nom Battery" (suffixe EXACT), priorité au % réel depuis le module Battery.
// - Pas d'heuristiques agressives : on fusionne seulement " ... Battery" → " ... "
// - Si un % est trouvé dans le module Battery, on l'utilise.
// - Si pas de %, on ne met pas de BatteryLevel "inventé", sauf si low flag explicite (alors 15% / 100%).
// - Anti-warnings: on n'écrit une caractéristique que si supportée.
// - Écriture optionnelle via API locale, port configurable (controlPort).

let hap;
const PLUGIN_NAME = "homebridge-sfrhome";
const PLATFORM_NAME = "SFRHomePlatform";

module.exports = (api) => {
  hap = api.hap;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SFRHomePlatform);
};

class SFRHomePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.name = this.config.name || "SFR Home";
    this.devicesPath = this.config.devicesPath || "/path/vers/devices.json";
    this.refreshSeconds = Number(this.config.refreshSeconds || 60);

    // Fusion basique activée par défaut
    this.mergeBattery = this.config.mergeBattery !== false; // true par défaut
    this.suppressOrphanBattery = this.config.suppressOrphanBattery !== false; // true par défaut
    this.debugBatteryMerge = !!this.config.debugBatteryMerge;

    // Écriture (facultative)
    this.enableWrite = !!this.config.enableWrite;
    const base = this.config.controlBaseUrl || "http://127.0.0.1";
    const port = this.config.controlPort || 5000;
    this.controlBaseUrl = `${base.replace(/\/$/, "")}:${port}`;

    this.accessories = new Map();

    if (!this.devicesPath) {
      this.log.error("devicesPath manquant — configurez-le dans config.json");
      return;
    }

    this.api.on("didFinishLaunching", () => {
      this.log.info(`Plateforme prête. Lecture: ${this.devicesPath}, refresh: ${this.refreshSeconds}s, write=${this.enableWrite ? "ON" : "OFF"}, control=${this.controlBaseUrl}`);
      this._tick();
      this._interval = setInterval(() => this._tick(), this.refreshSeconds * 1000);
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  _tick() {
    const fs = require("fs");
    fs.readFile(this.devicesPath, "utf8", (err, data) => {
      if (err) { this.log.warn(`Impossible de lire ${this.devicesPath}: ${err.message}`); return; }
      let list;
      try { list = JSON.parse(data); } catch (e) { this.log.error(`JSON invalide: ${e.message}`); return; }
      if (!Array.isArray(list)) { this.log.warn("devices.json n'est pas une liste."); return; }
      this._reconcile(list);
    });
  }

  // ---------- Helpers ----------
  _categoryFor(d) {
    const c = hap.Categories;
    switch ((d.deviceType || "").toUpperCase()) {
      case "ALARM_PANEL": return c.SECURITY_SYSTEM;
      case "MAGNETIC": return c.SENSOR;
      case "PIR_DETECTOR": return c.SENSOR;
      case "SMOKE": return c.SENSOR;
      case "TEMP_HUM": return c.SENSOR;
      case "LED_BULB_DIMMER":
      case "LED_BULB_HUE":
      case "LED_BULB_COLOR":
      case "ON_OFF_PLUG": return c.LIGHTBULB;
      default: return c.OTHER;
    }
  }
  _maybeSet(svc, Char, value) {
    try {
      if (!svc || !Char) return;
      if (typeof svc.testCharacteristic === "function" && !svc.testCharacteristic(Char)) return;
      svc.updateCharacteristic(Char, value);
    } catch (_) {}
  }
  _boolFromValue(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "on" || s === "true" || s === "yes";
  }
  _stableIdOf(d) {
    return (d.id && String(d.id)) || (d.rrd_id && String(d.rrd_id)) || `${d.deviceType || "DEVICE"}-${d.name || "unknown"}`;
  }

  // ---------- ON/OFF lecture depuis sensorValues ----------
  _findOnOffInSensorValues(d) {
    const sv = d.sensorValues || {};
    const candidates = ["state","power","on","switch","relay","onoff","status"];
    for (const name of Object.keys(sv)) {
      const low = name.toLowerCase();
      if (candidates.includes(low)) {
        const val = sv[name].value;
        if (typeof val === "string" && /^(on|off|true|false|0|1)$/i.test(val.trim())) {
          return this._boolFromValue(val);
        }
        return this._boolFromValue(val);
      }
    }
    return null;
  }

  // ---------- Batterie : extraction ----------
  _extractPercentFromString(str) {
    if (typeof str !== "string") return null;
    const m = str.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n >= 0 && n <= 100) return n;
    }
    const m2 = str.match(/^\s*([0-9]{1,3})\s*$/);
    if (m2) {
      const n2 = parseInt(m2[1], 10);
      if (!isNaN(n2) && n2 >= 0 && n2 <= 100) return n2;
    }
    return null;
  }
  _extractBatteryPercentFromSV(sv) {
    if (!sv) return null;
    for (const k of Object.keys(sv)) {
      const v = sv[k]?.value;
      const n = this._extractPercentFromString(String(v ?? ""));
      if (n !== null) return n;
    }
    return null;
  }
  _extractBatteryLowFlagFromSV(sv) {
    if (!sv) return null;
    for (const k of Object.keys(sv)) {
      if (/statuslowbattery|lowbattery|batterylow/i.test(k)) {
        const s = String(sv[k].value).trim().toLowerCase();
        if (["1","true","yes","low"].includes(s)) return true;
        if (["0","false","no","ok","normal"].includes(s)) return false;
      }
    }
    return null;
  }
  _extractBatteryTop(d) {
    const top = parseInt(String(d.batteryLevel ?? ""), 10);
    return (!isNaN(top) && top >= 0 && top <= 100) ? top : null;
  }
  _extractBattery(d) {
    // Ancienne logique 0.3.1 : top-level puis SV
    const top = this._extractBatteryTop(d);
    if (top !== null) return { level: top, low: null };

    const svPercent = this._extractBatteryPercentFromSV(d.sensorValues);
    if (svPercent !== null) return { level: svPercent, low: null };

    const low = this._extractBatteryLowFlagFromSV(d.sensorValues);
    if (low !== null) return { level: null, low };

    return { level: null, low: null };
  }

  // ---------- Fusion "Nom" + "Nom Battery" (suffixe EXACT) ----------
  _mergeBatteryExactSuffix(devices) {
    if (!this.mergeBattery) return devices.slice();

    const byName = new Map();
    devices.forEach(d => byName.set(d.name || "", d));

    const merged = [];
    const consumed = new Set();

    for (const d of devices) {
      const name = d.name || "";
      if (consumed.has(d)) continue;

      if (/\sBattery$/i.test(name)) {
        // C'est un module "Battery"
        const base = name.replace(/\sBattery$/i, "").trim();
        const main = byName.get(base);

        if (main) {
          // extraire le % réel du module Battery
          const batteryInfo = this._extractBattery(d); // {level, low}
          const mainInfo = this._extractBattery(main);

          let finalLevel = mainInfo.level;
          let finalLow = mainInfo.low;

          // prioriser le % du module Battery s'il existe
          if (batteryInfo.level !== null) finalLevel = batteryInfo.level;
          if (finalLevel === null && batteryInfo.low !== null) finalLow = batteryInfo.low;

          // injecter dans le main
          const mainMerged = { ...main };
          if (finalLevel !== null) mainMerged.batteryLevel = finalLevel;
          else if (finalLow !== null) mainMerged.batteryLowFlag = finalLow;

          merged.push(mainMerged);
          consumed.add(d);
          consumed.add(main);

          if (this.debugBatteryMerge) {
            this.log.info(`[merge] "${name}" fusionné dans "${base}"${finalLevel !== null ? ` (BatteryLevel=${finalLevel}%)` : (finalLow !== null ? ` (BatteryLow=${finalLow})` : " (aucun niveau)")}`);
          }
        } else {
          // pas de parent → selon config, masquer ou garder
          if (this.suppressOrphanBattery) {
            consumed.add(d);
            if (this.debugBatteryMerge) this.log.warn(`[merge] Orphelin masqué: "${name}" (pas de parent "${name.replace(/\sBattery$/i, "")}")`);
          } else {
            merged.push(d);
            consumed.add(d);
          }
        }
      } else {
        // C'est un device normal ; s'il n'a pas déjà été fusionné, on le garde
        if (!consumed.has(d)) {
          merged.push(d);
          consumed.add(d);
        }
      }
    }

    return merged;
  }

  // ---------- Cycle principal ----------
  _reconcile(devices) {
    // 1) Fusion clean : seulement " ... Battery" → " ..."
    const devicesMerged = this._mergeBatteryExactSuffix(devices);

    // 2) Créer / MAJ accessoires
    const seen = new Set();
    for (const d of devicesMerged) {
      const id = this._stableIdOf(d);
      const name = d.name || `${d.deviceType || "Device"} ${id}`;
      const uuid = this.api.hap.uuid.generate(`sfrhome:${id}`);

      seen.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.category = this._categoryFor(d);
        this._setupServices(accessory, d);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info(`+ Accessoire créé: ${name} (${d.deviceType})`);
      } else {
        accessory.displayName = name;
        this._setupServices(accessory, d);
      }

      this._updateValues(accessory, d);
    }

    // 3) Supprimer accessoires disparus
    const toRemove = [];
    for (const [uuid, acc] of this.accessories.entries()) {
      if (!seen.has(uuid)) {
        toRemove.push(acc);
        this.accessories.delete(uuid);
      }
    }
    if (toRemove.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
      toRemove.forEach((acc) => this.log.info(`- Accessoire supprimé: ${acc.displayName}`));
    }
  }

  _setupServices(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    // Nettoyer services (sauf AccessoryInformation)
    accessory.services
      .filter((s) => !(s instanceof Service.AccessoryInformation))
      .forEach((s) => accessory.removeService(s));

    // AccessoryInformation
    const info = accessory.getService(Service.AccessoryInformation);
    const serialRaw = this._stableIdOf(d);
    const serial = serialRaw.length > 1 ? serialRaw : `${(d.deviceType || "DEV")}-sn`;
    info
      .setCharacteristic(Characteristic.Manufacturer, d.brand || "SFR HOME")
      .setCharacteristic(Characteristic.Model, d.deviceModel || d.deviceType || "Unknown")
      .setCharacteristic(Characteristic.SerialNumber, serial);

    // Service principal
    switch ((d.deviceType || "").toUpperCase()) {
      case "ALARM_PANEL": {
        accessory.addService(Service.SecuritySystem, accessory.displayName);
        break;
      }
      case "MAGNETIC": {
        accessory.addService(Service.ContactSensor, accessory.displayName);
        break;
      }
      case "PIR_DETECTOR": {
        accessory.addService(Service.MotionSensor, accessory.displayName);
        break;
      }
      case "SMOKE": {
        accessory.addService(Service.SmokeSensor, accessory.displayName);
        break;
      }
      case "TEMP_HUM": {
        accessory.addService(Service.TemperatureSensor, accessory.displayName + " Temp");
        accessory.addService(Service.HumiditySensor, accessory.displayName + " Hum");
        break;
      }
      case "LED_BULB_DIMMER":
      case "LED_BULB_HUE":
      case "LED_BULB_COLOR":
      case "ON_OFF_PLUG": {
        const svc = accessory.addService(Service.Lightbulb, accessory.displayName);
        // Écriture optionnelle via API
        svc.getCharacteristic(Characteristic.On)
          .onSet(async (value) => {
            if (!this.enableWrite) { this.log.warn(`(lecture seule) ${accessory.displayName} -> On=${value}`); return; }
            try {
              const id = this._stableIdOf(d);
              const resp = await fetch(`${this.controlBaseUrl}/api/device/${encodeURIComponent(id)}/set`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ on: !!value })
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            } catch (e) {
              this.log.error(`Échec commande ON/OFF pour ${accessory.displayName}: ${e.message}`);
            }
          });
        break;
      }
      default: {
        accessory.addService(Service.MotionSensor, accessory.displayName);
      }
    }

    // BatteryService si info dispo (level ou low)
    const b = this._extractBattery(d);
    if (b.level !== null || b.low !== null) {
      const batt = accessory.addService(Service.BatteryService, accessory.displayName + " Battery");
      // BatteryLevel obligatoire → si pas de %, on met 100% ou 15% selon low flag, sinon 100 par défaut.
      const level = (b.level !== null) ? b.level : (b.low === true ? 15 : 100);
      this._maybeSet(batt, Characteristic.BatteryLevel, Math.max(0, Math.min(100, level)));
      this._maybeSet(batt, Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING);
      const low = (b.low !== null) ? b.low : (level <= 20);
      this._maybeSet(batt, Characteristic.StatusLowBattery,
        low ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }

  _updateValues(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    const getSV = (name) =>
      d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;

    for (const svc of accessory.services) {
      this._maybeSet(svc, Characteristic.StatusActive, true);
      this._maybeSet(svc, Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    }

    const status = (d.status || "").toUpperCase();

    if ((d.deviceType || "").toUpperCase() === "ALARM_PANEL") {
      const svc = accessory.getService(Service.SecuritySystem);
      if (svc) {
        const modeRaw = ((status || getSV("AlarmMode") || "") + "").toUpperCase();
        const curMap = {
          "OFF": Characteristic.SecuritySystemCurrentState.DISARMED,
          "CUSTOM": Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
          "ON": Characteristic.SecuritySystemCurrentState.AWAY_ARM
        };
        const cur = curMap[modeRaw] ?? Characteristic.SecuritySystemCurrentState.DISARMED;
        this._maybeSet(svc, Characteristic.SecuritySystemCurrentState, cur);
        let target;
        switch (cur) {
          case Characteristic.SecuritySystemCurrentState.AWAY_ARM: target = Characteristic.SecuritySystemTargetState.AWAY_ARM; break;
          case Characteristic.SecuritySystemCurrentState.NIGHT_ARM: target = Characteristic.SecuritySystemTargetState.NIGHT_ARM; break;
          case Characteristic.SecuritySystemCurrentState.STAY_ARM:  target = Characteristic.SecuritySystemTargetState.STAY_ARM;  break;
          default:                                                  target = Characteristic.SecuritySystemTargetState.DISARM;
        }
        this._maybeSet(svc, Characteristic.SecuritySystemTargetState, target);
      }
    }

    if ((d.deviceType || "").toUpperCase() === "MAGNETIC") {
      const svc = accessory.getService(Service.ContactSensor);
      if (svc) {
        const isOpen = status === "TRIGGERED" || status === "OPEN";
        this._maybeSet(
          svc,
          Characteristic.ContactSensorState,
          isOpen ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                 : Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }
    }

    if ((d.deviceType || "").toUpperCase() === "PIR_DETECTOR") {
      const svc = accessory.getService(Service.MotionSensor);
      if (svc) {
        const motion = status === "TRIGGERED";
        this._maybeSet(svc, Characteristic.MotionDetected, motion);
      }
    }

    if ((d.deviceType || "").toUpperCase() === "SMOKE") {
      const svc = accessory.getService(Service.SmokeSensor);
      if (svc) {
        const smoke = status === "TRIGGERED" || status === "ALARM";
        this._maybeSet(
          svc,
          Characteristic.SmokeDetected,
          smoke ? Characteristic.SmokeDetected.SMOKE_DETECTED
                : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
        );
        const bl = this._extractBattery(d);
        if (bl.low !== null) {
          this._maybeSet(
            svc,
            Characteristic.StatusLowBattery,
            bl.low ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                   : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
          );
        }
      }
    }

    if (["LED_BULB_DIMMER","LED_BULB_HUE","LED_BULB_COLOR","ON_OFF_PLUG"].includes((d.deviceType || "").toUpperCase())) {
      const svc = accessory.getService(Service.Lightbulb);
      if (svc) {
        const reachable = status !== "UNREACHABLE";
        const onFromSV = this._findOnOffInSensorValues(d);
        const on = (onFromSV === null) ? reachable : !!onFromSV;
        this._maybeSet(svc, hap.Characteristic.StatusActive, reachable);
        this._maybeSet(svc, hap.Characteristic.On, on);
      }
    }
  }
}
