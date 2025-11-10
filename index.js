// homebridge-sfrhome / index.js
// v0.3.3


let hap;
const PLUGIN_NAME = "SFR Home pour Homebridge";
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

    // Options d'exclusion (noms, modèles)
    this.exclude = this.config.exclude || {};

    // Écriture (facultative) — API locale
    this.enableWrite = !!this.config.enableWrite;
    const base = this.config.controlBaseUrl || "http://127.0.0.1";
    const port = this.config.controlPort || 5000;
    this.controlBaseUrl = `${base.replace(/\/$/, "")}:${port}`;

    this.accessories = new Map();

    if (!this.devicesPath) {
      this.devicesPath = "/tmp/devices.json";
      //this.log.error("devicesPath manquant — configurez-le dans config.json");
      //return;
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


  // ---------- Helpers ----------
  _categoryFor(d) {
    const c = hap.Categories;
    switch ((d.deviceType || "").toUpperCase()) {
      case "ALARM_PANEL": return c.SECURITY_SYSTEM;
      case "REMOTE": return c.SECURITY_SYSTEM;
      case "KEYPAD": return c.SECURITY_SYSTEM;
      case "SOLAR_SIREN": return c.SECURITY_SYSTEM;
      case "SIREN": return c.SECURITY_SYSTEM;
      case "MAGNETIC": return c.SENSOR;
      case "PIR_DETECTOR": return c.SENSOR;
      case "SMOKE": return c.SENSOR;
      case "TEMP_HUM": return c.SENSOR;
      case "LED_BULB_DIMMER": return c.LIGHTBULB;
      case "LED_BULB_HUE": return c.LIGHTBULB;
      case "LED_BULB_COLOR": return c.LIGHTBULB;
      case "CAMERA_WIFI": return c.CAMERA;
      case "ON_OFF_PLUG": return c.SWITCH;
      case "SHUTTER_COMMAND": return c.SWITCH;
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
    //const candidates = ["state","power","on","switch","relay","onoff","status"];
    const candidates = ["status"];
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


  // Batterie : Récupération de la valeur et normalisation de la valeur
  // -------------------------------------------------------------------------------------------------------------
  
  _clampPct(x) { return Math.max(0, Math.min(100, Number(x))); }

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
    // d’abord clés typées Battery
    for (const k of Object.keys(sv)) {
      if (/^battery(level)?$/i.test(k)) {
        const v = sv[k]?.value;
        const n = this._extractPercentFromString(String(v ?? ""));
        if (n !== null) return n;
      }
    }
    // sinon, tente toutes les valeurs
    for (const k of Object.keys(sv)) {
      const v = sv[k]?.value;
      const n = this._extractPercentFromString(String(v ?? ""));
      if (n !== null) return n;
    }
    return null;
  }

  _hasLowBatFlag(d) {
    if (String(d.status || "").toUpperCase() === "LOW_BAT") return true;
    const sv = d.sensorValues || {};
    for (const k of Object.keys(sv)) {
      if (/statuslowbattery|lowbattery|batterylow/i.test(k)) {
        const s = String(sv[k].value).trim().toLowerCase();
        if (["1","true","yes","low"].includes(s)) return true;
        if (["0","false","no","ok","normal"].includes(s)) return false;
      }
    }
    return false;
  }

  _extractBatteryNormalized(d) {
    // 1) % explicite dans sensorValues → prioritaire
    const fromSV = this._extractBatteryPercentFromSV(d.sensorValues);
    if (fromSV !== null) return this._clampPct(fromSV);

    // 2) Échelle 1..10 via batteryLevel
    if (d.batteryLevel !== undefined && d.batteryLevel !== null) {
      const raw = Number(d.batteryLevel);
      if (Number.isFinite(raw)) {
        if (raw === 255 || raw === -1 || raw === -2) return null;
        if (raw >= 1 && raw <= 10) return this._clampPct(raw * 10);
        if (raw >= 0 && raw <= 100) return this._clampPct(raw);
      }
    }

    return null;
  }


  // Cycle principal d'ajout des devices
  // -------------------------------------------------------------------------------------------------------------
  
  _reconcile(devices) {
    const seen = new Set();

    const exclude = this.config.exclude || {};
    const excludedNames = (exclude.names || []).map((x) => x.toLowerCase());
    const excludedModels = (exclude.models || []).map((x) => x.toUpperCase());

    for (const d of devices) {
      const id = this._stableIdOf(d);
      const name = (d.name || "").trim();

      // Exclusions de certains devices par nom ou par modèle, si indiqués dans le config.json
      if (excludedNames.includes(name.toLowerCase())) {
        this.log.info(`[SFR Home] Périphérique exclu par nom : ${name}`);
        continue;
      }
      if (excludedModels.includes((d.deviceType || "").toUpperCase()) ||
          excludedModels.includes((d.model_type || "").toUpperCase())) {
        this.log.info(`[SFR Home] Périphérique exclu par modèle : ${d.model_type || d.deviceType}`);
        continue;
      }

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

    // Retire les devices qui n'existent plus
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

  // Set up initial des devices
  // -------------------------------------------------------------------------------------------------------------
  _setupServices(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;

    accessory.services
      .filter((s) => !(s instanceof Service.AccessoryInformation))
      .forEach((s) => accessory.removeService(s));

    const info = accessory.getService(Service.AccessoryInformation);
    const serialRaw = this._stableIdOf(d);
    const serial = serialRaw.length > 1 ? serialRaw : `${(d.deviceType || "DEV")}-sn`;
    info
      .setCharacteristic(Characteristic.Manufacturer, d.brand || "SFR HOME")
      .setCharacteristic(Characteristic.Model, d.deviceModel || d.deviceType || "Unknown")
      .setCharacteristic(Characteristic.SerialNumber, serial);

    switch ((d.deviceType || "").toUpperCase()) {
      case "ALARM_PANEL":
        accessory.addService(Service.SecuritySystem, accessory.displayName);
        break;
		
      case "REMOTE":
      case "KEYPAD":
      case "SIREN":
      case "SOLAR_SIREN":
      case "MAGNETIC":
        accessory.addService(Service.ContactSensor, accessory.displayName);
        break;

      case "PIR_DETECTOR":
        accessory.addService(Service.OccupancySensor, accessory.displayName);
        break;

      case "SMOKE":
        accessory.addService(Service.SmokeSensor, accessory.displayName);
        break;

      case "TEMP_HUM":
        accessory.addService(Service.TemperatureSensor, accessory.displayName + " (Temp)");
        accessory.addService(Service.HumiditySensor, accessory.displayName + " (Hum)");
        break;

      case "CAMERA_WIFI":
        accessory.addService(Service.CameraRTPStreamManagement, accessory.displayName);
        break;

      case "ON_OFF_PLUG":
	  case "SHUTTER_COMMAND":
        accessory.addService(Service.Switch, accessory.displayName);
        break;

      case "LED_BULB_DIMMER":
      case "LED_BULB_HUE":
      case "LED_BULB_COLOR": {
        accessory.addService(Service.Lightbulb, accessory.displayName);
        break;
      }

      default:
        accessory.addService(Service.MotionSensor, accessory.displayName);
    }

    // Ajout en parallèle de devices de type Batterie pour récupérer le niveau de batterie des devices
    // -------------------------------------------------------------------------------------------------------------
    const level = this._extractBatteryNormalized(d);
    const lowFlag = this._hasLowBatFlag(d);
    if (level !== null || lowFlag) {
      const batt = accessory.addService(Service.BatteryService, accessory.displayName + " (Battery)");
      const finalLevel = (level !== null) ? level : (lowFlag ? 15 : 100);
      batt.setCharacteristic(Characteristic.BatteryLevel, this._clampPct(finalLevel));
      batt.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING);
      batt.setCharacteristic(
        Characteristic.StatusLowBattery,
        (level !== null ? (level <= 20) : lowFlag)
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }

  // Mises à jour des paramètres spécifiques à chaque type de device
  // -------------------------------------------------------------------------------------------------------------
  _updateValues(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;
    const getSV = (name) => d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;
    const status = (d.status || "").toUpperCase();

    // Devices de type Alarm : Clavier, télécommande, sirène
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

    // Détecteur d'ouverture
    if (["MAGNETIC","REMOTE","KEYPAD","SOLAR_SIREN","SIREN"].includes((d.deviceType || "").toUpperCase())) {
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

    // Détecteur de mouvement
    if ((d.deviceType || "").toUpperCase() === "PIR_DETECTOR") {
      const svc = accessory.getService(Service.MotionSensor);
      if (svc) {
        const motion = status === "TRIGGERED";
        svc.updateCharacteristic(Characteristic.MotionDetected, motion);
      }
    }

    // Détecteur de fumée
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

    // Capteur de température (et d'humidité), ajoutés commes 2 devices distincts
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
	  
    // Caméra Wifi
	if ((d.deviceType || "").toUpperCase() === "CAMERA_WIFI") {
        accessory.addService(Service.CameraOperatingMode, accessory.displayName);
	}

    // Prise programmable + Commande volet Legrand
    if (["ON_OFF_PLUG","SHUTTER_COMMAND"].includes((d.deviceType || "").toUpperCase())) {
        accessory.addService(Service.SmokeSensor, accessory.displayName);
	}

    // Lumières SFR + Hue    
    if (["LED_BULB_DIMMER","LED_BULB_HUE","LED_BULB_COLOR"].includes((d.deviceType || "").toUpperCase())) {
      const svc = accessory.getService(Service.Lightbulb);
      if (svc) {
        const reachable = status !== "UNREACHABLE";
        let on = this._findOnOffInSensorValues(d);
        if (on === null) on = reachable;
        svc.updateCharacteristic(Characteristic.On, !!on);
      }
    }
  }
}
