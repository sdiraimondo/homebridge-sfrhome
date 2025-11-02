// homebridge-sfrhome / index.js — v1.0.0 (100% Node)
// Lit directement SFR (SSO + /mysensors), plus besoin de Python/cron.

let hap;
const PLUGIN_NAME = "homebridge-sfrhome";
const PLATFORM_NAME = "SFRHomePlatform";
const { getDevices } = require("./sfrhome-client");

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
    this.refreshSeconds = Number(this.config.refreshSeconds || 60);

    // Identifiants SFR (requis)
    this.user = this.config.user;
    this.password = this.config.password;

    // Écriture (facultative) — API locale si tu veux conserver cette option
    this.enableWrite = !!this.config.enableWrite;
    const base = this.config.controlBaseUrl || "http://127.0.0.1";
    const port = this.config.controlPort || 5000;
    this.controlBaseUrl = `${base.replace(/\/$/, "")}:${port}`;

    this.accessories = new Map();

    if (!this.user || !this.password) {
      this.log.error("Config manquante: 'user' et 'password' sont requis.");
      return;
    }

    this.api.on("didFinishLaunching", () => {
      this.log.info(`Plateforme prête. refresh=${this.refreshSeconds}s, write=${this.enableWrite ? "ON" : "OFF"}`);
      this._tick();
      this._interval = setInterval(() => this._tick(), this.refreshSeconds * 1000);
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  _tick() {
    getDevices({ user: this.user, pass: this.password })
      .then(list => this._reconcile(list))
      .catch(err => this.log.error(`Erreur SFR: ${err.message}`));
  }

  _reconcile(devices) {
    const seen = new Set();
    for (const d of devices) {
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

    // retirer les accessoires non vus
    const toRemove = [];
    for (const [uuid, acc] of this.accessories.entries()) {
      if (!seen.has(uuid)) {
        toRemove.push(acc);
        this.accessories.delete(uuid);
      }
    }
    if (toRemove.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
      toRemove.forEach(acc => this.log.info(`- Accessoire supprimé: ${acc.displayName}`));
    }
  }

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

  _setupServices(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    // Nettoyer services (sauf AccessoryInformation)
    accessory.services
      .filter(s => !(s instanceof Service.AccessoryInformation))
      .forEach(s => accessory.removeService(s));

    // AccessoryInformation — SerialNumber non vide
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
        // écriture optionnelle via API locale (si tu veux garder cette option)
        svc.getCharacteristic(Characteristic.On).onSet(async (value) => {
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

    // BatteryService si batterie détectable
    const batteryLevel = this._extractBattery(d);
    if (batteryLevel !== null) {
      const batt = accessory.addService(Service.BatteryService, accessory.displayName + " Battery");
      batt.setCharacteristic(Characteristic.BatteryLevel, batteryLevel);
      batt.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING);
      batt.setCharacteristic(
        Characteristic.StatusLowBattery,
        batteryLevel <= 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                           : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }

  _extractBattery(d) {
    const direct = parseInt(String(d.batteryLevel ?? ""), 10);
    if (!isNaN(direct) && direct >= 0 && direct <= 100) return direct;
    const sv = d.sensorValues || {};
    for (const key of Object.keys(sv)) {
      if (/battery/i.test(key)) {
        const raw = String(sv[key].value || "");
        const n = parseInt(raw.replace("%","").trim(), 10);
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
    const sv = d.sensorValues || {};
    const candidates = ["state","power","on","switch","relay","onoff","status"];
    for (const name of Object.keys(sv)) {
      const low = name.toLowerCase();
      if (candidates.includes(low)) {
        return this._boolFromValue(sv[name].value);
      }
    }
    return null;
  }

  _updateValues(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    const getSV = (name) =>
      d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;

    // activer services (évite "Not Detected")
    for (const svc of accessory.services) {
      if (svc && svc.updateCharacteristic && Characteristic.StatusActive) {
        try { svc.updateCharacteristic(Characteristic.StatusActive, true); } catch {}
      }
      if (svc && svc.updateCharacteristic && Characteristic.StatusFault) {
        try { svc.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT); } catch {}
      }
    }

    const status = (d.status || "").toUpperCase();

    // Alarme
    if ((d.deviceType || "").toUpperCase() === "ALARM_PANEL") {
      const svc = accessory.getService(Service.SecuritySystem);
      if (svc) {
        const modeRaw = ((status || getSV("AlarmMode") || "") + "").toUpperCase();
        const map = {
          "OFF": Characteristic.SecuritySystemCurrentState.DISARMED,
          "CUSTOM": Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
          "ON": Characteristic.SecuritySystemCurrentState.AWAY_ARM
        };
        const cur = map[modeRaw] ?? Characteristic.SecuritySystemCurrentState.DISARMED;
        svc.updateCharacteristic(Characteristic.SecuritySystemCurrentState, cur);

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
        svc.updateCharacteristic(Characteristic.SecuritySystemTargetState, target);
      }
    }

    // Contact
    if ((d.deviceType || "").toUpperCase() === "MAGNETIC") {
      const svc = accessory.getService(Service.ContactSensor);
      if (svc) {
        const isOpen = status === "TRIGGERED" || status === "OPEN";
        svc.updateCharacteristic(
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
        svc.updateCharacteristic(Characteristic.MotionDetected, motion);
      }
    }

    // Smoke
    if ((d.deviceType || "").toUpperCase() === "SMOKE") {
      const svc = accessory.getService(Service.SmokeSensor);
      if (svc) {
        const smoke = status === "TRIGGERED" || status === "ALARM";
        svc.updateCharacteristic(
          Characteristic.SmokeDetected,
          smoke ? Characteristic.SmokeDetected.SMOKE_DETECTED
                : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED
        );
        const bl = this._extractBattery(d);
        if (bl !== null && Characteristic.StatusLowBattery) {
          svc.updateCharacteristic(
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
        const n = parseFloat(tRaw.replace("°C","").trim());
        if (!isNaN(n)) tSvc.updateCharacteristic(Characteristic.CurrentTemperature, n);
      }
      if (hSvc && typeof hRaw === "string") {
        const n = parseFloat(hRaw.replace("%","").trim());
        if (!isNaN(n)) hSvc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, n);
      }
    }

    // Lumières / prises
    if (["LED_BULB_DIMMER","LED_BULB_HUE","LED_BULB_COLOR","ON_OFF_PLUG"].includes((d.deviceType || "").toUpperCase())) {
      const svc = accessory.getService(Service.Lightbulb);
      if (svc) {
        const reachable = status !== "UNREACHABLE";
        let on = this._findOnOffInSensorValues(d);
        if (on === null) on = reachable; // fallback
        if (Characteristic.StatusActive) svc.updateCharacteristic(Characteristic.StatusActive, reachable);
        svc.updateCharacteristic(Characteristic.On, !!on);
      }
    }
  }
}
