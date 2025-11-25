// homebridge-sfrhome / index.js
// v0.4.0 - Lecture directe /mysensors via cookies SSO,
//          contrôle ON_OFF_PLUG via /plugcontrol,
//          contrôle alarme via /alarmmode

let hap;
const fs = require("fs");
const axios = require("axios");
const xml2js = require("xml2js");

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

    // rafraîchissement des états
    this.refreshSeconds = Number(this.config.refreshSeconds || 60);

    // Options d'exclusion (noms, modèles)
    this.exclude = this.config.exclude || {};

    // Écriture (API locale éventuelle)
    this.enableWrite = !!this.config.enableWrite;
    const base = this.config.controlBaseUrl || "http://127.0.0.1";
    const port = this.config.controlPort || 5000;
    this.controlBaseUrl = `${base.replace(/\/$/, "")}:${port}`;

    // Chemin des cookies persistés (générés par le script Python)
    this.cookiePath = "/tmp/sfrhome_session_cookies.json";

    // Périodicité de lecture d’état via plugcontrol (optionnelle)
    this.plugPollMs = Number(this.config.plugPollMs || 30000);

    this.accessories = new Map();

    this.api.on("didFinishLaunching", () => {
      this.log.info(
        `Plateforme prête. Source: https://home.sfr.fr/mysensors (cookies: ${this.cookiePath}), refresh: ${this.refreshSeconds}s, write=${this.enableWrite ? "ON" : "OFF"}, control=${this.controlBaseUrl}`
      );
      this._tick();
      this._interval = setInterval(() => this._tick(), this.refreshSeconds * 1000);
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  // ---------- Tick principal : fetch mysensors + reconcile ----------
  async _tick() {
    try {
      const devices = await this._fetchDevicesFromSfr();
      if (!devices || !Array.isArray(devices) || !devices.length) {
        this.log.warn("[SFR Home] Aucun device récupéré via /mysensors.");
        return;
      }
      this._reconcile(devices);
    } catch (e) {
      this.log.error(`[SFR Home] Erreur tick: ${e.message}`);
    }
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
    return (d.id && String(d.id))
      || (d.rrd_id && String(d.rrd_id))
      || `${d.deviceType || "DEVICE"}-${d.name || "unknown"}`;
  }

  _boolFromValue(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "on" || s === "true" || s === "yes";
  }

  _findOnOffInSensorValues(d) {
    const sv = d.sensorValues || {};
    const candidates = ["trigger"];
    for (const name of Object.keys(sv)) {
      const low = name.toLowerCase();
      if (candidates.includes(low)) {
        const val = sv[name].value;
        return this._boolFromValue(val);
      }
    }
    return null;
  }

  // Batterie : Récupération de la valeur et normalisation
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
    for (const k of Object.keys(sv)) {
      if (/^battery(level)?$/i.test(k)) {
        const v = sv[k]?.value;
        const n = this._extractPercentFromString(String(v ?? ""));
        if (n !== null) return n;
      }
    }
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
    const fromSV = this._extractBatteryPercentFromSV(d.sensorValues);
    if (fromSV !== null) return this._clampPct(fromSV);
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

  // ---------- Cookies & appels SFR ----------
  _loadCookiesHeader() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cookiePath, "utf8"));
      const header = data.map(c => `${c.name}=${c.value}`).join("; ");
      if (!header) throw new Error("cookie file empty");
      return header;
    } catch (e) {
      this.log.warn(`[SFR Home] Cookies manquants/illisibles (${this.cookiePath}): ${e.message}`);
      return null;
    }
  }

  // Contrôle des prises ON_OFF_PLUG via /plugcontrol
  async _plugAction(uid, action = null) {
    const loadHeader = () => {
      try {
        const data = JSON.parse(fs.readFileSync(this.cookiePath, "utf8"));
        const h = data.map(c => `${c.name}=${c.value}`).join("; ");
        if (!h) throw new Error("cookie file empty");
        return h;
      } catch (e) {
        throw new Error(`Cookies manquants/illisibles (${this.cookiePath}): ${e.message}`);
      }
    };

    const doReq = async (cookieHeader) => {
      const url = action
        ? `https://home.sfr.fr/plugcontrol?uid=${encodeURIComponent(uid)}&action=${action}`
        : `https://home.sfr.fr/plugcontrol?uid=${encodeURIComponent(uid)}`;

      const headers = {
        Cookie: cookieHeader,
        Referer: "https://home.sfr.fr/accueil",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
        Accept: "application/xml,text/xml,*/*"
      };

      const resp = await axios.get(url, {
        headers,
        maxRedirects: 0,
        validateStatus: s => (s >= 200 && s < 300) || s === 302 || s === 303 || s === 403
      });

      if (resp.status === 403) {
        throw new Error("403");
      }
      if (resp.status === 302 || resp.status === 303) {
        throw new Error(`Redirection ${resp.status} (auth requise)`);
      }
      const xml = String(resp.data || "");
      const m = xml.match(/<ONOFF>(\d+)<\/ONOFF>/);
      const onoff = m ? parseInt(m[1], 10) : 0;
      return onoff === 1;
    };

    try {
      const ck = loadHeader();
      return await doReq(ck);
    } catch (e) {
      if (String(e.message).includes("403")) {
        this.log.warn("[SFR Home] 403 plugcontrol : relecture des cookies et nouvel essai...");
        try {
          const ck2 = loadHeader();
          return await doReq(ck2);
        } catch (e2) {
          throw new Error(`403 après reload cookies. Vérifie que ${this.cookiePath} est à jour et lisible (cron). Détail: ${e2.message}`);
        }
      }
      throw e;
    }
  }

  // Contrôle de l’alarme via /alarmmode?action=off|on|custom
  async _alarmAction(mode) {
    const modeNorm = String(mode || "").toLowerCase();
    if (!["off", "on", "custom"].includes(modeNorm)) {
      throw new Error(`Mode alarme invalide: ${mode}`);
    }

    const loadHeader = () => {
      try {
        const data = JSON.parse(fs.readFileSync(this.cookiePath, "utf8"));
        const h = data.map(c => `${c.name}=${c.value}`).join("; ");
        if (!h) throw new Error("cookie file empty");
        return h;
      } catch (e) {
        throw new Error(`Cookies manquants/illisibles (${this.cookiePath}): ${e.message}`);
      }
    };

    const doReq = async (cookieHeader) => {
      const url = `https://home.sfr.fr/alarmmode?action=${encodeURIComponent(modeNorm)}`;

      const headers = {
        Cookie: cookieHeader,
        Referer: "https://home.sfr.fr/accueil",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
        Accept: "application/xml,text/xml,*/*"
      };

      const resp = await axios.get(url, {
        headers,
        maxRedirects: 0,
        validateStatus: s => (s >= 200 && s < 300) || s === 302 || s === 303 || s === 403
      });

      if (resp.status === 403) {
        throw new Error("403");
      }
      if (resp.status === 302 || resp.status === 303) {
        throw new Error(`Redirection ${resp.status} (auth requise)`);
      }

      const xml = String(resp.data || "");
      const ok = /<STATUS>\s*OK\s*<\/STATUS>/i.test(xml);
      if (!ok) {
        throw new Error(`Réponse inattendue alarmmode: ${xml.slice(0, 200)}...`);
      }
      return true;
    };

    try {
      const ck = loadHeader();
      return await doReq(ck);
    } catch (e) {
      if (String(e.message).includes("403")) {
        this.log.warn("[SFR Home] 403 alarmmode : relecture des cookies et nouvel essai...");
        try {
          const ck2 = loadHeader();
          return await doReq(ck2);
        } catch (e2) {
          throw new Error(`403 après reload cookies (alarmmode). Vérifie que ${this.cookiePath} est à jour et lisible. Détail: ${e2.message}`);
        }
      }
      throw e;
    }
  }

  // ---------- Récupération + parsing /mysensors ----------
  async _fetchDevicesFromSfr() {
    const loadHeader = () => {
      try {
        const data = JSON.parse(fs.readFileSync(this.cookiePath, "utf8"));
        const h = data.map(c => `${c.name}=${c.value}`).join("; ");
        if (!h) throw new Error("cookie file empty");
        return h;
      } catch (e) {
        throw new Error(`Cookies manquants/illisibles (${this.cookiePath}): ${e.message}`);
      }
    };

    const doReq = async (cookieHeader) => {
      const url = "https://home.sfr.fr/mysensors";
      const headers = {
        Cookie: cookieHeader,
        Referer: "https://home.sfr.fr/accueil",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
        Accept: "application/xml,text/xml,*/*"
      };

      const resp = await axios.get(url, {
        headers,
        responseType: "text",
        maxRedirects: 0,
        validateStatus: s => (s >= 200 && s < 300) || s === 302 || s === 303 || s === 403
      });

      if (resp.status === 403) {
        throw new Error("403");
      }
      if (resp.status === 302 || resp.status === 303) {
        throw new Error(`Redirection ${resp.status} (auth requise)`);
      }

      const xml = String(resp.data || "");
      try {
        fs.writeFileSync("/tmp/debug_mysensors.xml", xml);
      } catch (e) {
        this.log.warn(`[SFR Home] Impossible d'écrire /tmp/debug_mysensors.xml : ${e.message}`);
      }
      return await this._parseDevicesFromXml(xml);
    };

    try {
      const ck = loadHeader();
      return await doReq(ck);
    } catch (e) {
      if (String(e.message).includes("403")) {
        this.log.warn("[SFR Home] 403 mysensors : relecture des cookies et nouvel essai...");
        try {
          const ck2 = loadHeader();
          return await doReq(ck2);
        } catch (e2) {
          this.log.error(`[SFR Home] Échec final mysensors après reload cookies: ${e2.message}`);
          return [];
        }
      }
      this.log.error(`[SFR Home] Erreur mysensors: ${e.message}`);
      return [];
    }
  }

  async _parseDevicesFromXml(xml) {
    let root;
    try {
      root = await xml2js.parseStringPromise(xml, {
        explicitArray: false,
        mergeAttrs: true,
        trim: true
      });
    } catch (e) {
      this.log.error(`[SFR Home] XML mysensors invalide: ${e.message}`);
      return [];
    }

    // --- 1) Recherche générique des nœuds "device-like" dans tout l'arbre ---

    const isDeviceLike = (obj) => {
      if (!obj || typeof obj !== "object") return false;
      const keys = Object.keys(obj);
      const hasId = ["id", "uid", "rrd_id"].some(k => k in obj);
      const hasTypeOrName = ["deviceType", "model_type", "modelType", "name", "deviceName"].some(k => k in obj);
      return hasId && hasTypeOrName;
    };

    const found = [];

    const visit = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node !== "object") return;

      if (isDeviceLike(node)) {
        found.push(node);
      }

      if (node.device) {
        visit(node.device);
      }

      for (const key of Object.keys(node)) {
        if (key === "device") continue;
        const val = node[key];
        if (val && typeof val === "object") {
          visit(val);
        }
      }
    };

    visit(root);

    if (!found.length) {
      this.log.warn("[SFR Home] Aucun noeud ressemblant à un device trouvé dans mysensors.xml");
      return [];
    }

    // Déduplication par id/uid/rrd_id si possible
    const byId = new Map();
    for (const dev of found) {
      const sid =
        (dev.id && String(dev.id)) ||
        (dev.uid && String(dev.uid)) ||
        (dev.rrd_id && String(dev.rrd_id)) ||
        JSON.stringify(dev);
      if (!byId.has(sid)) {
        byId.set(sid, dev);
      }
    }

    const arr = Array.from(byId.values());
    const devices = [];

    // --- 2) Transformation en objets "device" pour le plugin ---

    for (const dev of arr) {
      if (!dev) continue;

      const sensorValues = {};
      const svRaw = dev.sensorValue || dev.sensorValues || dev.sv || [];
      const svArr = Array.isArray(svRaw) ? svRaw : (svRaw ? [svRaw] : []);

      for (const sv of svArr) {
        if (!sv) continue;
        const name = sv.name || sv.Name || sv.id || "value";
        const value =
          sv.value !== undefined ? sv.value :
          sv._ !== undefined ? sv._ :
          sv.text !== undefined ? sv.text :
          "";

        const clone = { ...sv };
        delete clone._;
        delete clone.value;

        sensorValues[name] = {
          value: value,
          attrs: clone
        };
      }

      const d = {
        id: dev.id || dev.uid || dev.rrd_id,
        rrd_id: dev.rrd_id,
        name: dev.name || dev.label || dev.deviceName,
        deviceType: dev.deviceType || dev.model_type || dev.modelType,
        model_type: dev.model_type || dev.modelType || "",
        status: dev.status || dev.deviceStatus || "",
        brand: dev.brand || "",
        deviceModel: dev.deviceModel || dev.model || "",
        deviceVersion: dev.deviceVersion || dev.version || "",
        batteryLevel: dev.batteryLevel,
        deviceMac: dev.deviceMac || dev.mac || "",
        sensorValues
      };

      devices.push(d);
    }

    if (this.log.debug) {
      this.log.debug(`[SFR Home] mysensors -> ${devices.length} devices parsés (après récursion).`);
    }

    return devices;
  }

  // ---------- Cycle principal d'ajout des devices ----------
  _reconcile(devices) {
    const seen = new Set();

    const exclude = this.config.exclude || {};
    const excludedNames = (exclude.names || []).map((x) => x.toLowerCase());
    const excludedModels = (exclude.models || []).map((x) => x.toUpperCase());

    for (const d of devices) {
      const id = this._stableIdOf(d);
      const name = (d.name || "").trim();

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

  // ---------- Set up initial des devices ----------
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
      .setCharacteristic(Characteristic.SerialNumber, serial || "Unknown")
      .setCharacteristic(Characteristic.FirmwareRevision, d.deviceVersion || "1.0");

    switch ((d.deviceType || "").toUpperCase()) {
      case "ALARM_PANEL": {
        const svc = accessory.addService(Service.SecuritySystem, accessory.displayName);

        // Mapping demandé :
        // - Activité (SFR) = Absent (AWAY_ARM) -> "on"
        // - Nuit (SFR)     = Nuit (NIGHT_ARM) -> "custom"
        // - Désactivé      = Off (DISARM) et Maison (STAY_ARM) -> "off"
        svc.getCharacteristic(Characteristic.SecuritySystemTargetState)
          .on("set", async (value, callback) => {
            let mode = "off";
            switch (value) {
              case Characteristic.SecuritySystemTargetState.DISARM:
                mode = "off";
                break;
              case Characteristic.SecuritySystemTargetState.STAY_ARM:
                mode = "off";     // Maison => Désactivé
                break;
              case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                mode = "custom";  // Nuit => Custom
                break;
              case Characteristic.SecuritySystemTargetState.AWAY_ARM:
                mode = "on";      // Absent => Activité
                break;
              default:
                mode = "off";
                break;
            }

            try {
              await this._alarmAction(mode);
              this.log.info(`[SFR Home] Alarme -> ${mode.toUpperCase()}`);

              const curMap = {
                "off": Characteristic.SecuritySystemCurrentState.DISARMED,
                "custom": Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
                "on": Characteristic.SecuritySystemCurrentState.AWAY_ARM
              };
              const cur = curMap[mode] ?? Characteristic.SecuritySystemCurrentState.DISARMED;
              svc.updateCharacteristic(Characteristic.SecuritySystemCurrentState, cur);

              callback();
            } catch (e) {
              this.log.error(`[SFR Home] Erreur commande alarme (${mode}): ${e.message}`);
              callback(e);
            }
          });

        break;
      }

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
        // Placeholder minimal (on laisse pour plus tard)
        accessory.addService(Service.CameraRTPStreamManagement, accessory.displayName);
        break;

      case "ON_OFF_PLUG": {
        const svc = accessory.addService(Service.Switch, accessory.displayName);
        if (!svc._sfrBound) {
          svc.getCharacteristic(Characteristic.On)
            .on("set", async (value, callback) => {
              try {
                await this._plugAction(d.id, value ? "on" : "off");
                this.log.info(`[SFR Home] ${d.name} -> ${value ? "ON" : "OFF"}`);
                callback();
              } catch (e) {
                this.log.error(`[SFR Home] Erreur commande ${d.name}: ${e.message}`);
                callback(e);
              }
            })
            .on("get", async (callback) => {
              try {
                const state = await this._plugAction(d.id, null);
                callback(null, state);
              } catch (e) {
                callback(e);
              }
            });
          svc._sfrBound = true;
        }
        break;
      }

      case "SHUTTER_COMMAND":
        accessory.addService(Service.Switch, accessory.displayName);
        break;

      case "LED_BULB_DIMMER":
      case "LED_BULB_HUE":
      case "LED_BULB_COLOR":
        accessory.addService(Service.Lightbulb, accessory.displayName);
        break;

      default:
        accessory.addService(Service.MotionSensor, accessory.displayName);
    }

    // Batterie
    const level = this._extractBatteryNormalized(d);
    const lowFlag = this._hasLowBatFlag(d);
    if (level !== null || lowFlag) {
      const batt = accessory.addService(hap.Service.BatteryService, accessory.displayName + " (Battery)");
      const finalLevel = (level !== null) ? level : (lowFlag ? 15 : 100);
      batt.setCharacteristic(hap.Characteristic.BatteryLevel, this._clampPct(finalLevel));
      batt.setCharacteristic(hap.Characteristic.ChargingState, hap.Characteristic.ChargingState.NOT_CHARGING);
      batt.setCharacteristic(
        hap.Characteristic.StatusLowBattery,
        (level !== null ? (level <= 20) : lowFlag)
          ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
  }

  // ---------- Mises à jour des devices ----------
  _updateValues(accessory, d) {
    const Service = hap.Service, Characteristic = hap.Characteristic;
    const getSV = (name) => d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;
    const status = (d.status || "").toUpperCase();

    // ALARM PANEL : lecture état depuis mysensors
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
          case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
            target = Characteristic.SecuritySystemTargetState.AWAY_ARM;
            break;
          case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
            target = Characteristic.SecuritySystemTargetState.NIGHT_ARM;
            break;
          case Characteristic.SecuritySystemCurrentState.STAY_ARM:
            target = Characteristic.SecuritySystemTargetState.STAY_ARM;
            break;
          default:
            target = Characteristic.SecuritySystemTargetState.DISARM;
        }
        svc.updateCharacteristic(Characteristic.SecuritySystemTargetState, target);
      }
    }

    // Contact (sirènes/telecommandes/magnétiques)
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

    // Mouvement
    if ((d.deviceType || "").toUpperCase() === "PIR_DETECTOR") {
      const svc = accessory.getService(Service.MotionSensor);
      if (svc) {
        const motion = status === "TRIGGERED";
        svc.updateCharacteristic(Characteristic.MotionDetected, motion);
      }
    }

    // Fumée
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

    // Temp/Hum
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

    // ON_OFF_PLUG: lecture de l’état réel à chaque tick
    if ((d.deviceType || "").toUpperCase() === "ON_OFF_PLUG") {
      const svc = accessory.getService(Service.Switch);
      if (svc) {
        this._plugAction(d.id, null)
          .then(state => svc.updateCharacteristic(Characteristic.On, !!state))
          .catch(e => this.log.warn(`[SFR Home] Échec lecture état ${d.name} (ID=${d.id}) : ${e.message}`));
      }
    }

    // SHUTTER_COMMAND : on reflète juste la reachability
    if ((d.deviceType || "").toUpperCase() === "SHUTTER_COMMAND") {
      const svc = accessory.getService(Service.Switch);
      if (svc) {
        const reachable = status !== "UNREACHABLE";
        svc.updateCharacteristic(Characteristic.On, reachable);
      }
    }

    // Lumières
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
