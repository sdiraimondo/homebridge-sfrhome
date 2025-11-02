// homebridge-sfrhome / index.js
// v0.3.2 — Fusion "Battery" + parent, et écriture de caractéristiques seulement si supportées.
// (Conserve tout le reste : BatteryService, mapping ON/OFF réel, écriture optionnelle via API locale, controlPort configurable)

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

    this.accessories = new Map(); // uuid -> accessory

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
    // Restauration cache Homebridge
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

  // -------- Helpers ----------
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
    // N’écrit la caractéristique que si le service la supporte (évite les warnings Homebridge)
    try {
      if (!svc || !Char) return;
      if (typeof svc.testCharacteristic === "function" && !svc.testCharacteristic(Char)) {
        return;
      }
      svc.updateCharacteristic(Char, value);
    } catch (_) {}
  }

  _extractBattery(d) {
    // Retourne un pourcentage 0..100 ou null
    const direct = parseInt(String(d.batteryLevel ?? ""), 10);
    if (!isNaN(direct) && direct >= 0 && direct <= 100) return direct;

    const sv = d.sensorValues || {};
    for (const key of Object.keys(sv)) {
      if (/battery/i.test(key)) {
        const raw = String(sv[key].value || "");
        const n = parseInt(raw.replace("%", "").trim(), 10);
        if (!isNaN(n) && n >= 0 && n <= 100) return n;
      }
    }
    return null;
  }

  _boolFromValue(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "on" || s === "true" || s === "yes";
  }

  _findOnOffInSensorValues(d) {
    // Heuristique pour trouver un état On/Off dans sensorValues
    const sv = d.sensorValues || {};
    const candidates = ["state","power","on","switch","relay","onoff","status"];
    for (const name of Object.keys(sv)) {
      const low = name.toLowerCase();
      if (candidates.includes(low)) {
        const val = sv[name].value;
        // gère ON/OFF/1/0/true/false
        if (typeof val === "string" && /^(on|off|true|false|0|1)$/i.test(val.trim())) {
          return this._boolFromValue(val);
        }
        // sinon on tente parse bool
        return this._boolFromValue(val);
      }
    }
    return null;
  }

  _baseNameForBattery(name) {
    if (!name) return { base: "", isBattery: false };
    const trimmed = String(name).trim();
    if (/ Battery$/i.test(trimmed)) {
      return { base: trimmed.replace(/\s+Battery$/i, "").trim(), isBattery: true };
    }
    return { base: trimmed, isBattery: false };
  }

  _groupAndMergeDevices(devices) {
    // Regroupe par "nom de base" : "Cuisine" et "Cuisine Battery" → groupe "Cuisine"
    const groups = new Map();
    for (const d of devices) {
      const { base, isBattery } = this._baseNameForBattery(d.name || "");
      const key = base || (d.name || "");
      if (!groups.has(key)) groups.set(key, { main: null, battery: null, extras: [] });

      const g = groups.get(key);
      if (isBattery) {
        g.battery = d;
      } else {
        // S’il y a plusieurs "main", on choisit le premier avec deviceType capteur/utile
        if (!g.main) {
          g.main = d;
        } else {
          g.extras.push(d); // on ne perd rien, mais on n’exposera pas ces doublons
        }
      }
    }

    // Produit la liste des devices fusionnés
    const merged = [];
    for (const [key, g] of groups.entries()) {
      let m = g.main || g.battery; // au pire, si on n’a QUE le battery (rare), on le garde
      if (!m) continue;

      // Injecte un niveau de batterie si “Battery” existe
      if (g.battery) {
        const fromSV = g.battery.sensorValues?.Battery?.value;
        const fromTop = g.battery.batteryLevel;
        const extracted = (() => {
          if (typeof fromSV === "string") {
            const n = parseInt(fromSV.replace("%", "").trim(), 10);
            if (!isNaN(n)) return n;
          }
          const n2 = parseInt(String(fromTop ?? ""), 10);
          return !isNaN(n2) ? n2 : null;
        })();

        if (extracted !== null) {
          m = { ...m, batteryLevel: extracted }; // fusion dans l’objet principal
        }
      }

      merged.push(m);
    }
    return merged;
  }

  // ---------------------------

  _reconcile(devices) {
    // 1) Fusionne "Battery" avec leur parent
    const devicesMerged = this._groupAndMergeDevices(devices);

    // 2) Création/mise à jour Homebridge
    const seen = new Set();
    for (const d of devicesMerged) {
      const id = (d.id && String(d.id)) || (d.rrd_id && String(d.rrd_id)) || `${d.deviceType || "DEVICE"}-${d.name || "unknown"}`;
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

    // 3) Supprimer les accessoires disparus (inclura désormais les anciens "Battery" isolés)
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

    // AccessoryInformation — SerialNumber non-vide
    const info = accessory.getService(Service.AccessoryInformation);
    const rawSerial =
      (d.id && String(d.id).trim()) ||
      (d.rrd_id && String(d.rrd_id).trim()) ||
      `${d.deviceType || "DEVICE"}-${(d.name || "unknown").toString().trim()}`;
    const serial = rawSerial.length > 1 ? rawSerial : `${(d.deviceType || "DEV")}-sn`;

    info
      .setCharacteristic(Characteristic.Manufacturer, d.brand || "SFR HOME")
      .setCharacteristic(Characteristic.Model, d.deviceModel || d.deviceType || "Unknown")
      .setCharacteristic(Characteristic.SerialNumber, serial);

    // Service principal selon type
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
        // ÉCRITURE optionnelle via API locale
        svc.getCharacteristic(Characteristic.On)
          .onSet(async (value) => {
            if (!this.enableWrite) {
              this.log.warn(`(lecture seule) ${accessory.displayName} -> On=${value}`);
              return;
            }
            try {
              const id = (d.id || d.rrd_id || `${d.deviceType}-${d.name}`);
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

    // BatteryService si pertinent
    const batteryLevel = this._extractBattery(d);
    if (batteryLevel !== null) {
      const batt = accessory.addService(Service.BatteryService, accessory.displayName + " Battery");
      this._maybeSet(batt, Characteristic.BatteryLevel, batteryLevel);
      this._maybeSet(batt, Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING);
      this._maybeSet(
        batt,
        Characteristic.StatusLowBattery,
        batteryLevel <= 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                           : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }

  _updateValues(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    const getSV = (name) =>
      d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;

    // Marquer services "actifs" (évite "Not Detected"), et n’écrire que si supporté
    for (const svc of accessory.services) {
      this._maybeSet(svc, Characteristic.StatusActive, true);
      this._maybeSet(svc, Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
    }

    const status = (d.status || "").toUpperCase();

    // Centrale -> SecuritySystem
    if ((d.deviceType || "").toUpperCase() === "ALARM_PANEL") {
      const svc = accessory.getService(Service.SecuritySystem);
      if (svc) {
        const modeRaw = ((status || getSV("AlarmMode") || "") + "").toUpperCase();
        const curMap = {
          "OFF": Characteristic.SecuritySystemCurrentState.DISARMED,
          "CUSTOM": Characteristic.SecuritySystemCurrentState.NIGHT_ARM, // ou STAY_ARM selon préférence
          "ON": Characteristic.SecuritySystemCurrentState.AWAY_ARM
        };
        const cur = curMap[modeRaw] ?? Characteristic.SecuritySystemCurrentState.DISARMED;
        this._maybeSet(svc, Characteristic.SecuritySystemCurrentState, cur);

        let target;
        switch (cur) {
          case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
            target = Characteristic.SecuritySystemTargetState.AWAY_ARM; break;
          case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
            target = Characteristic.SecuritySystemTargetState.NIGHT_ARM; break;
          case Characteristic.SecuritySystemCurrentState.STAY_ARM:
            target = Characteristic.SecuritySystemTargetState.STAY_ARM; break;
          default:
            target = Characteristic.SecuritySystemTargetState.DISARM;
        }
        this._maybeSet(svc, Characteristic.SecuritySystemTargetState, target);
      }
    }

    // Contact
    if ((d.deviceType || "").toUpperCase() === "MAGNETIC") {
      const svc = accessory.getService(Service.ContactSensor);
      if (svc) {
        const isOpen = status === "TRIGGERED" || status === "OPEN";
        this._maybeSet(
          svc,
          Characteristic.ContactSensorState,
          isOpen
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      }
    }

    // PIR
    if ((d.deviceType || "").toUpperCase() === "PIR_DETECTOR") {
      const svc = accessory.getService(Service.MotionSensor);
      if (svc) {
        const motion = status === "TRIGGERED";
        this._maybeSet(svc, Characteristic.MotionDetected, motion);
      }
    }

    // Smoke
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
        if (bl !== null) {
          this._maybeSet(
            svc,
            Characteristic.StatusLowBattery,
            bl <= 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                     : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
          );
        }
      }
    }

    // Temp/Hum
    if ((d.deviceType || "").toUpperCase() === "TEMP_HUM") {
      const tSvc = accessory.getService(Service.TemperatureSensor);
      const hSvc = accessory.getService(Service.HumiditySensor);
      const tRaw = getSV("Temperature");
      const hRaw = getSV("Humidity");
      if (tSvc && typeof tRaw === "string") {
        const n = parseFloat(tRaw.replace("°C", "").trim());
        if (!isNaN(n)) this._maybeSet(tSvc, Characteristic.CurrentTemperature, n);
      }
      if (hSvc && typeof hRaw === "string") {
        const n = parseFloat(hRaw.replace("%", "").trim());
        if (!isNaN(n)) this._maybeSet(hSvc, Characteristic.CurrentRelativeHumidity, n);
      }
    }

    // Lights/Plugs — ON réel si dispo
    if (["LED_BULB_DIMMER","LED_BULB_HUE","LED_BULB_COLOR","ON_OFF_PLUG"].includes((d.deviceType || "").toUpperCase())) {
      const svc = accessory.getService(Service.Lightbulb);
      if (svc) {
        const reachable = status !== "UNREACHABLE";
        let on = this._findOnOffInSensorValues(d);
        if (on === null) on = reachable; // fallback
        this._maybeSet(svc, hap.Characteristic.StatusActive, reachable);
        this._maybeSet(svc, hap.Characteristic.On, !!on);
      }
    }
  }
}
