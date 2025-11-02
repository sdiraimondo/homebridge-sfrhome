// homebridge-sfrhome / index.js
// v0.3.1-p1 — Base 0.3.1 avec patch minimal :
// - Pré-indexe les devices nommés "* Battery" pour récupérer un % réel
// - Ajoute BatteryService au device parent
// - N'ENREGISTRE PAS les accessoires "* Battery" (plus de doublon)
// - Aucune heuristique complexe : suffixe exact " Battery" uniquement
// - Reste du comportement identique à 0.3.1

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

    // Écriture (facultative) — API locale
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
      if (err) {
        this.log.warn(`Impossible de lire ${this.devicesPath}: ${err.message}`);
        return;
      }
      let list;
      try {
        list = JSON.parse(data);
      } catch (e) {
        this.log.error(`JSON invalide: ${e.message}`);
        return;
      }
      if (!Array.isArray(list)) {
        this.log.warn("devices.json n'est pas une liste.");
        return;
      }
      this._reconcile(list);
    });
  }

  // ---------- Helpers 0.3.1 ----------
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

  _stableIdOf(d) {
    return (d.id && String(d.id)) || (d.rrd_id && String(d.rrd_id)) || `${d.deviceType || "DEVICE"}-${d.name || "unknown"}`;
  }

  _boolFromValue(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "on" || s === "true" || s === "yes";
  }

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

  _extractBattery(d) {
    // 0.3.1 : d'abord top-level, sinon SV
    const top = parseInt(String(d.batteryLevel ?? ""), 10);
    if (!isNaN(top) && top >= 0 && top <= 100) return top;
    const svPercent = this._extractBatteryPercentFromSV(d.sensorValues);
    if (svPercent !== null) return svPercent;
    return null;
  }

  // ---------- Patch minimal : lire les % depuis "* Battery" ----------
  _buildBatteryMap(devices) {
    // { "Cuisine" : 87, "Salon" : 52, ... } à partir des entrées "Cuisine Battery"
    const map = new Map();
    for (const d of devices) {
      const name = (d.name || "").trim();
      if (!name) continue;
      const m = name.match(/\sBattery$/i);
      if (!m) continue;
      const base = name.replace(/\sBattery$/i, "").trim();
      const percent = this._extractBattery(d);
      if (percent !== null) {
        // garde la meilleure valeur si plusieurs (par prudence)
        const prev = map.has(base) ? map.get(base) : null;
        map.set(base, prev === null ? percent : Math.max(prev, percent));
      }
    }
    return map;
  }

  _reconcile(devices) {
    // 1) Construire la map des % à partir des devices "* Battery"
    const batteryMap = this._buildBatteryMap(devices);

    // 2) Créer / MAJ accessoires pour TOUS sauf "* Battery"
    const seen = new Set();
    for (const d of devices) {
      const name = (d.name || "").trim();
      if (/\sBattery$/i.test(name)) {
        // PATCH : on n’enregistre pas l’accessoire "* Battery"
        continue;
      }

      const id = this._stableIdOf(d);
      const display = name || `${d.deviceType || "Device"} ${id}`;
      const uuid = this.api.hap.uuid.generate(`sfrhome:${id}`);

      seen.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(display, uuid);
        accessory.category = this._categoryFor(d);
        this._setupServices(accessory, d, batteryMap);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info(`+ Accessoire créé: ${display} (${d.deviceType})`);
      } else {
        accessory.displayName = display;
        this._setupServices(accessory, d, batteryMap);
      }

      this._updateValues(accessory, d, batteryMap);
    }

    // 3) Supprimer accessoires disparus (y compris anciens "* Battery")
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

  _setupServices(accessory, d, batteryMap) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    // Nettoyer services (sauf AccessoryInformation)
    accessory.services
      .filter((s) => !(s instanceof Service.AccessoryInformation))
      .forEach((s) => accessory.removeService(s));

    // AccessoryInformation (0.3.1)
    const info = accessory.getService(Service.AccessoryInformation);
    const serialRaw = this._stableIdOf(d);
    const serial = serialRaw.length > 1 ? serialRaw : `${(d.deviceType || "DEV")}-sn`;
    info
      .setCharacteristic(Characteristic.Manufacturer, d.brand || "SFR HOME")
      .setCharacteristic(Characteristic.Model, d.deviceModel || d.deviceType || "Unknown")
      .setCharacteristic(Characteristic.SerialNumber, serial);

    // Service principal (0.3.1)
    switch ((d.deviceType || "").toUpperCase()) {
      case "ALARM_PANEL":
        accessory.addService(Service.SecuritySystem, accessory.displayName);
        break;
      case "MAGNETIC":
        accessory.addService(Service.ContactSensor, accessory.displayName);
        break;
      case "PIR_DETECTOR":
        accessory.addService(Service.MotionSensor, accessory.displayName);
        break;
      case "SMOKE":
        accessory.addService(Service.SmokeSensor, accessory.displayName);
        break;
      case "TEMP_HUM":
        accessory.addService(Service.TemperatureSensor, accessory.displayName + " Temp");
        accessory.addService(Service.HumiditySensor, accessory.displayName + " Hum");
        break;
      case "LED_BULB_DIMMER":
      case "LED_BULB_HUE":
      case "LED_BULB_COLOR":
      case "ON_OFF_PLUG": {
        const svc = accessory.addService(Service.Lightbulb, accessory.displayName);
        // ÉCRITURE optionnelle via API locale (0.3.1)
        svc.getCharacteristic(Characteristic.On)
          .onSet(async (value) => {
            if (!this.enableWrite) {
              this.log.warn(`(lecture seule) ${accessory.displayName} -> On=${value}`);
              return;
            }
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
      default:
        accessory.addService(Service.MotionSensor, accessory.displayName);
    }

    // PATCH : BatteryService sur le parent si on a un % pour son nom
    const baseName = (d.name || "").trim();
    const levelFromBattery = batteryMap.has(baseName) ? batteryMap.get(baseName) : null;
    const levelSelf = this._extractBattery(d); // au cas où le parent a lui-même un %
    const finalLevel = levelFromBattery !== null ? levelFromBattery : levelSelf;

    if (finalLevel !== null) {
      const batt = accessory.addService(Service.BatteryService, accessory.displayName + " Battery");
      batt.setCharacteristic(Characteristic.BatteryLevel, Math.max(0, Math.min(100, finalLevel)));
      batt.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING);
      batt.setCharacteristic(
        Characteristic.StatusLowBattery,
        finalLevel <= 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                         : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }

  _updateValues(accessory, d /*, batteryMap */) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    const getSV = (name) =>
      d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;

    // 0.3.1 : pas d'écriture de caractéristiques "exotiques" (on reste simple)

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
        svc.updateCharacteristic(Characteristic.SecuritySystemCurrentState, cur);
        let target;
        switch (cur) {
          case Characteristic.SecuritySystemCurrentState.AWAY_ARM: target = Characteristic.SecuritySystemTargetState.AWAY_ARM; break;
          case Characteristic.SecuritySystemCurrentState.NIGHT_ARM: target = Characteristic.SecuritySystemTargetState.NIGHT_ARM; break;
          case Characteristic.SecuritySystemCurrentState.STAY_ARM:  target = Characteristic.SecuritySystemTargetState.STAY_ARM;  break;
          default:                                                  target = Characteristic.SecuritySystemTargetState.DISARM;
        }
        svc.updateCharacteristic(Characteristic.SecuritySystemTargetState, target);
      }
    }

    if ((d.deviceType || "").toUpperCase() === "MAGNETIC") {
      const svc = accessory.getService(Service.ContactSensor);
      if (svc) {
        const isOpen = status === "TRIGGERED" || status === "OPEN";
        svc.updateCharacteristic(
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
        svc.updateCharacteristic(Characteristic.MotionDetected, motion);
      }
    }

    if ((d.deviceType || "").toUpperCase() === "SMOKE") {
      const svc = accessory.getService(Service.SmokeSensor);
      if (svc) {
        const smoke = status === "TRIGGERED" || status === "ALARM";
        svc.updateCharacteristic(
          Characteristic.SmokeDetected,
          smoke ? Characteristic.SmokeDetected.SMOKE_DETECTED
                : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
        );
      }
    }

    if ((d.deviceType || "").toUpperCase() === "TEMP_HUM") {
      const tSvc = accessory.getService(Service.TemperatureSensor);
      const hSvc = accessory.getService(Service.HumiditySensor);
      const tRaw = getSV("Temperature");
      const hRaw = getSV("Humidity");
      if (tSvc && typeof tRaw === "string") {
        const n = parseFloat(tRaw.replace("°C", "").trim());
        if (!isNaN(n)) tSvc.updateCharacteristic(Characteristic.CurrentTemperature, n);
      }
      if (hSvc && typeof hRaw === "string") {
        const n = parseFloat(hRaw.replace("%", "").trim());
        if (!isNaN(n)) hSvc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, n);
      }
    }

    if (["LED_BULB_DIMMER","LED_BULB_HUE","LED_BULB_COLOR","ON_OFF_PLUG"].includes((d.deviceType || "").toUpperCase())) {
      const svc = accessory.getService(Service.Lightbulb);
      if (svc) {
        const reachable = status !== "UNREACHABLE";
        let on = this._findOnOffInSensorValues(d);
        if (on === null) on = reachable; // fallback basique
        svc.updateCharacteristic(Characteristic.On, !!on);
      }
    }
  }
}
