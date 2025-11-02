// sfrhome-client.js — Client SFR robuste (SSO + submit login + mysensors + parse XML)

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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Connection": "keep-alive"
    },
    withCredentials: true,
    jar,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400 // considérer 3xx comme "ok" (axios suit les redirects)
  });
  axiosCookieJarSupport(client);
  return client;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getLoginPage(client) {
  // Amorçage des cookies
  const r = await client.get(LOGIN_URL, {
    headers: {
      "Referer": LOGIN_URL,
      "Origin": BASE.slice(0, -1)
    }
  });
  return r.data;
}

// 1) POST SSO -> token_sso (avec retry)
async function postSSO(client, user, pass) {
  const form = new URLSearchParams({ connectionSFR: user, passSFR: pass });
  const headers = {
    "Origin": BASE.slice(0, -1),
    "Referer": LOGIN_URL,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest"
  };

  // tentative 1
  let token = await tryPostSSO(client, form, headers);
  if (token) return token;

  // petite pause + rechargement /login + tentative 2
  await sleep(500);
  await getLoginPage(client);
  await sleep(250);
  token = await tryPostSSO(client, form, headers);

  if (!token) throw new Error("token_sso manquant dans la réponse SSO");
  return token;
}

async function tryPostSSO(client, form, headers) {
  try {
    const r = await client.post(SSO, form, { headers });
    // axios validateStatus laisse passer 3xx — si 3xx, r.data peut être vide
    let data = r.data;
    if (typeof data === "string") {
      // parfois le serveur renvoie du texte JSON
      try { data = JSON.parse(data); } catch { /* noop */ }
    }
    const token = data?.result?.token_sso;
    if (token) return token;

    // log compact pour debug, sans fuite sensible
    const snippet = (typeof data === "string" ? data : JSON.stringify(data || {})).slice(0, 200);
    console.warn("[SFR SSO] Réponse inattendue (extrait):", snippet);
    return null;
  } catch (e) {
    // remonter le code si 4xx/5xx
    const status = e.response?.status;
    const snippet = (e.response?.data ? (typeof e.response.data === "string" ? e.response.data : JSON.stringify(e.response.data)) : "").slice(0, 200);
    throw new Error(`POST SSO échoué${status ? " ("+status+")" : ""}${snippet ? " — "+snippet : ""}`);
  }
}

// 2) GET /login + POST formulaire final avec name="token_sso"
async function submitFinalForm(client, token, user) {
  const html = await getLoginPage(client);
  const $ = cheerio.load(html);
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
  if ("email" in payload && !payload.email) payload.email = user;

  const headers = {
    "Origin": BASE.slice(0, -1),
    "Referer": LOGIN_URL,
    "Content-Type": "application/x-www-form-urlencoded"
  };

  const r2 = await client.post(action, new URLSearchParams(payload), { headers });
  // donner un peu de temps à la session pour se stabiliser
  await sleep(200);
  // parfois le serveur renvoie une page login encore une fois, pas grave si cookies posés
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
    responseType: "text",
    // si le serveur répond 403/401, on veut voir l'erreur
    validateStatus: s => s >= 200 && s < 300
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
  const sensorsNode = findSensorsNode(parsed) || parsed;

  const devices = [];

  // ALARM PANEL depuis root
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
    const dev = { ...s, sensorValues: null };

    // normaliser champs texte imbriqués
    for (const key of ["deviceType","deviceModel","deviceVersion","name","long_name","batteryLevel","signalLevel","status","categories"]) {
      const v = s?.[key];
      if (v && typeof v === "object" && "#text" in v) dev[key] = String(v["#text"]);
    }

    // sensorValues
    const sv = {};
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

// API principale
async function getDevices({ user, pass }) {
  const client = makeClient();

  // 1) amorcer cookies
  await getLoginPage(client);

  // 2) SSO avec retry
  const token = await postSSO(client, user, pass);

  // 3) soumettre formulaire final
  await submitFinalForm(client, token, user);

  // 4) récupérer mysensors
  try {
    const xml = await fetchMySensorsXML(client);
    return parseDevices(xml);
  } catch (e) {
    const status = e.response?.status;
    const snippet = (e.response?.data ? (typeof e.response.data === "string" ? e.response.data : JSON.stringify(e.response.data)) : "").slice(0, 200);
    throw new Error(`/mysensors échoué${status ? " ("+status+")" : ""}${snippet ? " — "+snippet : ""}`);
  }
}

module.exports = { getDevices };
