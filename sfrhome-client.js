// sfrhome-client.js — Client SFR 100% Node (SSO + submit login + fetch /mysensors + parse XML)

const axios = require("axios").default;
const { wrapper: axiosCookieJarSupport } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");
const { XMLParser } = require("fast-xml-parser");

const BASE = "https://home.sfr.fr/";
const LOGIN_URL = "https://home.sfr.fr/login";
const SSO = "https://home.sfr.fr/sso-connector.php";
const MYSENSORS = "https://home.sfr.fr/mysensors";

function makeClient() {
  const jar = new CookieJar();
  const client = axios.create({
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    },
    withCredentials: true,
    jar
  });
  axiosCookieJarSupport(client);
  return client;
}

// 1) POST SSO -> token_sso
async function postSSO(client, user, pass) {
  const r = await client.post(
    SSO,
    new URLSearchParams({ connectionSFR: user, passSFR: pass }),
    { headers: { Origin: BASE.slice(0, -1), Referer: LOGIN_URL } }
  );
  const token = r.data?.result?.token_sso;
  if (!token) throw new Error("token_sso manquant dans la réponse SSO");
  return token;
}

// 2) GET /login + POST formulaire final avec name="token_sso"
async function submitFinalForm(client, token, user) {
  const r = await client.get(LOGIN_URL, { headers: { Referer: LOGIN_URL } });
  const $ = cheerio.load(r.data);
  const form = $("#login_form_add_rib").attr("action") ? $("#login_form_add_rib") : $("#loginForm");
  if (!form || !form.attr("action")) throw new Error("Formulaire final de login introuvable");

  const actionRel = form.attr("action");
  const action = actionRel.startsWith("http") ? actionRel : new URL(actionRel, LOGIN_URL).href;

  const payload = {};
  form.find("input[name]").each((_, el) => {
    const name = $(el).attr("name");
    const type = ($(el).attr("type") || "").toLowerCase();
    if (type === "checkbox" && !$(el).attr("checked")) return;
    payload[name] = $(el).attr("value") || "";
  });

  payload["token_sso"] = token;
  // si le champ 'email' existe et est vide, le remplir (souvent optionnel)
  if ("email" in payload && !payload.email) payload.email = user;

  const r2 = await client.post(action, new URLSearchParams(payload), {
    headers: { Origin: BASE.slice(0, -1), Referer: LOGIN_URL },
    maxRedirects: 5
  });
  const finalUrl = r2.request?.res?.responseUrl || action;
  return finalUrl;
}

// 3) GET /mysensors (XML)
async function fetchMySensorsXML(client) {
  const r = await client.get(MYSENSORS, {
    headers: {
      "Accept": "application/xml,text/xml,*/*",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": BASE
    },
    responseType: "text"
  });
  return r.data; // XML string
}

// util — chercher le premier nœud qui contient 'Sensor'
function findSensorsNode(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, "Sensor")) return obj;
  for (const k of Object.keys(obj)) {
    const res = findSensorsNode(obj[k]);
    if (res) return res;
  }
  return null;
}

// 4) Parse XML -> devices (incluant ALARM_PANEL depuis les attributs racine)
function parseDevices(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text",
    allowBooleanAttributes: true
  });
  const parsed = parser.parse(xml);

  // Trouver le nœud qui porte la liste de capteurs
  const sensorsNode = findSensorsNode(parsed) || parsed;

  const devices = [];

  // Attributs racine (centrale d'alarme) éventuels
  const panelName = sensorsNode?.name;
  const panelModel = sensorsNode?.model_type || sensorsNode?.model || sensorsNode?.type;
  const panelMode = (sensorsNode?.alarm_mode || sensorsNode?.mode || "").toUpperCase();

  if (panelName || panelModel || panelMode) {
    devices.push({
      id: "panel",
      deviceType: "ALARM_PANEL",
      deviceModel: panelModel || "",
      name: panelName || "Centrale",
      long_name: panelModel ? `Centrale d'alarme (${panelModel})` : "Centrale d'alarme",
      status: panelMode || "UNKNOWN",
      batteryLevel: "-2",
      signalLevel: "-2",
      categories: "alarm",
      sensorValues: {
        AlarmMode: { value: panelMode, attrs: { name: "AlarmMode" } }
      }
    });
  }

  // Liste des capteurs
  const list = Array.isArray(sensorsNode?.Sensor)
    ? sensorsNode.Sensor
    : (sensorsNode?.Sensor ? [sensorsNode.Sensor] : []);

  for (const s of list) {
    // Copier attributs/props de base
    const dev = {
      ...s,
      sensorValues: null
    };

    // Normalisation des champs texte courants (si imbriqués en sous-objets)
    for (const key of ["deviceType","deviceModel","deviceVersion","name","long_name","batteryLevel","signalLevel","status","categories"]) {
      const v = s?.[key];
      if (v && typeof v === "object" && "#text" in v) dev[key] = String(v["#text"]);
    }

    // Normaliser sensorValue(s)
    const sv = {};
    // cas 1: s.sensorValue (array/obj)
    const svRaw = s?.sensorValue;
    if (svRaw) {
      const arr = Array.isArray(svRaw) ? svRaw : [svRaw];
      for (const el of arr) {
        const name = el?.name || el?.id || `value_${Object.keys(sv).length+1}`;
        const val = (el?.["#text"] || el?._ || el?.value || "").toString();
        const attrs = { ...el };
        delete attrs["#text"]; delete attrs["_"]; delete attrs["value"];
        sv[name] = { value: val, attrs };
      }
    }
    // cas 2: s.sensorValues (rare)
    const svObj = s?.sensorValues;
    if (svObj && typeof svObj === "object") {
      for (const k of Object.keys(svObj)) {
        if (!sv[k]) {
          const raw = svObj[k];
          const val = (raw?.["#text"] || raw?.value || raw || "").toString();
          sv[k] = { value: val, attrs: { name: k } };
        }
      }
    }

    dev.sensorValues = Object.keys(sv).length ? sv : null;
    devices.push(dev);
  }

  return devices;
}

// API principale (exportée)
async function getDevices({ user, pass }) {
  const client = makeClient();
  const token = await postSSO(client, user, pass);
  await submitFinalForm(client, token, user);
  const xml = await fetchMySensorsXML(client);
  return parseDevices(xml);
}

module.exports = { getDevices };
