// index.js
// Plugin Homebridge lisant devices.json (généré par ton script Python) et exposant des accessoires HomeKit.

let hap, PLUGIN_NAME = "homebridge-sfrhome", PLATFORM_NAME = "SFRHomePlatform";

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
    this.accessories = new Map(); // uuid -> accessory

    if (!this.devicesPath) {
      this.log.error("devicesPath manquant — configurez-le dans config.json");
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.log.info(`Plateforme prête. Lecture: ${this.devicesPath}, refresh: ${this.refreshSeconds}s`);
      this._tick(); // lecture initiale
      this._interval = setInterval(() => this._tick(), this.refreshSeconds * 1000);
    });
  }

  configureAccessory(accessory) {
    // Récupère accessoires cachés par Homebridge (restauration cache)
    this.accessories.set(accessory.UUID, accessory);
  }

  _tick() {
    const fs = require('fs');
    fs.readFile(this.devicesPath, 'utf8', (err, data) => {
      if (err) {
        this.log.warn(`Impossible de lire ${this.devicesPath}: ${err.message}`);
        return;
      }
      let list;
      try { list = JSON.parse(data); } catch (e) {
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

  _reconcile(devices) {
    // index des équipements par id
    const seen = new Set();
    for (const d of devices) {
      const id = d.id || d.rrd_id || `${d.deviceType}-${d.name}`;
      const name = d.name || `${d.deviceType} ${id}`;
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
        // update services (peut-être type changé / renommage)
        accessory.displayName = name;
        this._setupServices(accessory, d);
      }

      // mise à jour des valeurs
      this._updateValues(accessory, d);
    }

    // Retirer les accessoires qui n’apparaissent plus
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
    switch (d.deviceType) {
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

    // Clear services except AccessoryInformation
    accessory.services
      .filter(s => !(s instanceof Service.AccessoryInformation))
      .forEach(s => accessory.removeService(s));

    // Always set info
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, d.brand || "SFR HOME")
      .setCharacteristic(Characteristic.Model, d.deviceModel || d.deviceType || "Unknown")
      .setCharacteristic(Characteristic.SerialNumber, d.id || "n/a");

    // Choose service by device type
    switch (d.deviceType) {
      case "MAGNETIC": {
        const svc = accessory.addService(Service.ContactSensor, accessory.displayName);
        // Characteristic.ContactSensorState
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
        // simple ON/OFF (pas de dimmer pour MVP)
        svc.getCharacteristic(Characteristic.On)
          .onSet(async (value) => {
            // MVP: lecture seule (pas d’action vers SFR Home).
            this.log.warn(`(lecture seule) ${accessory.displayName} -> On=${value}`);
          });
        break;
      }
      default: {
        // Fallback: MotionSensor (pour être visible)
        accessory.addService(Service.MotionSensor, accessory.displayName);
      }
    }
  }

  _updateValues(accessory, d) {
    const Characteristic = hap.Characteristic;
    const status = (d.status || "").toUpperCase();

    const getSV = (name) => d.sensorValues && d.sensorValues[name] ? d.sensorValues[name].value : undefined;

    // MAGNETIC -> ContactSensorState (detected: OPEN)
    if (d.deviceType === "MAGNETIC") {
      const svc = accessory.getService(hap.Service.ContactSensor);
      if (svc) {
        // pas de valeur explicite -> heuristique : status OK => fermé, sinon ouvert ?
        // Si tu as un champ plus fiable dans sensorValues, remplace ici.
        const isOpen = status === "TRIGGERED" || status === "OPEN";
        svc.updateCharacteristic(Characteristic.ContactSensorState,
          isOpen ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                 : Characteristic.ContactSensorState.CONTACT_DETECTED);
      }
    }

    // PIR_DETECTOR -> MotionDetected
    if (d.deviceType === "PIR_DETECTOR") {
      const svc = accessory.getService(hap.Service.MotionSensor);
      if (svc) {
        const motion = (status === "TRIGGERED");
        svc.updateCharacteristic(Characteristic.MotionDetected, motion);
      }
    }

    // SMOKE -> SmokeDetected
    if (d.deviceType === "SMOKE") {
      const svc = accessory.getService(hap.Service.SmokeSensor);
      if (svc) {
        const smoke = (status === "TRIGGERED" || status === "ALARM");
        svc.updateCharacteristic(Characteristic.SmokeDetected,
          smoke ? Characteristic.SmokeDetected.SMOKE_DETECTED
                : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
        // Optionnel: low battery
        const bl = parseInt(d.batteryLevel, 10);
        if (!isNaN(bl)) {
          svc.updateCharacteristic(Characteristic.StatusLowBattery, bl <= 2
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        }
      }
    }

    // TEMP_HUM -> Temperature/Humidity
    if (d.deviceType === "TEMP_HUM") {
      const tSvc = accessory.getService(hap.Service.TemperatureSensor);
      const hSvc = accessory.getService(hap.Service.HumiditySensor);
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

    // Lights/Plugs -> lecture seule (On = false si UNREACHABLE)
    if (["LED_BULB_DIMMER","LED_BULB_HUE","LED_BULB_COLOR","ON_OFF_PLUG"].includes(d.deviceType)) {
      const svc = accessory.getService(hap.Service.Lightbulb);
      if (svc) {
        const isReachable = status !== "UNREACHABLE";
        svc.updateCharacteristic(Characteristic.On, isReachable); // heuristique MVP
      }
    }

    // AccessoryInformation: Battery/Signal en Manufacturer/Model extra (facultatif)
    // (On pourrait aussi exposer un BatteryService si besoin)
  }
}
