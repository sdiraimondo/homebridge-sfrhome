#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sfr_mysensors_sso.py — SFR Home : SSO robuste + soumission du formulaire final (token_sso)
+ récupération /mysensors + parsing XML -> devices.json + devices.csv
+ ajout d'un device synthétique "Centrale d'alarme" (ALARM_PANEL) depuis les attributs root:
  name="Centrale", model_type="TSC06SFR", alarm_mode="ON|OFF|CUSTOM"

Dépendances :
    pip install requests lxml beautifulsoup4

Exemples :
    python sfr_mysensors_sso.py --user ton.email@exemple        # mot de passe demandé en caché
    python sfr_mysensors_sso.py --user ton.email@exemple --password 'TonMDP'
    python sfr_mysensors_sso.py --cookie 'PHPSESSID=xxx; ...'   # utilise un cookie déjà authentifié
    python sfr_mysensors_sso.py --use-local                     # parse un XML local pour tests
"""

import os
import sys
import json
import csv
import argparse
import getpass
import requests
from bs4 import BeautifulSoup
from lxml import etree
from io import BytesIO
from urllib.parse import urljoin

# ---------- valeurs par défaut ----------
BASE_URL_DEFAULT = "https://home.sfr.fr/"
LOGIN_URL_DEFAULT = "https://home.sfr.fr/login"
DASHBOARD_URL_DEFAULT = "https://home.sfr.fr/"   # page d'atterrissage
SSO_ENDPOINT = "sso-connector.php"
MYSENSORS_URL_DEFAULT = "https://home.sfr.fr/mysensors"
LOCAL_XML_PATH = "/mnt/data/mysensors.xml"
OUTPUT_JSON = "/tmp/devices.json"
OUTPUT_CSV = "/tmp/devices.csv"

# ---------- arguments ----------
def parse_args():
    p = argparse.ArgumentParser(description="SFR Home: login SSO + fetch mysensors (robust)")
    p.add_argument("--user","-u", help="Identifiant / email SFR")
    p.add_argument("--password","-p", help="Mot de passe (sinon, saisie cachée)")
    p.add_argument("--cookie","-c", help="Chaîne Cookie (si fournie, login non utilisé)")
    p.add_argument("--use-local", action="store_true", help=f"Utiliser {LOCAL_XML_PATH} au lieu du réseau")
    p.add_argument("--base-url", default=BASE_URL_DEFAULT)
    p.add_argument("--login-url", default=LOGIN_URL_DEFAULT)
    p.add_argument("--dashboard-url", default=DASHBOARD_URL_DEFAULT)
    p.add_argument("--mysensors-url", default=MYSENSORS_URL_DEFAULT)
    return p.parse_args()

# ---------- parsing XML (avec ALARM_PANEL) ----------
def parse_sensors_xml(xml_bytes):
    """
    Parse le XML /mysensors et retourne une liste de devices.
    - Convertit _Attrib en dict standard
    - Ajoute un device synthétique "Centrale d'alarme" (ALARM_PANEL) si
      des attributs root name/model_type/alarm_mode sont présents.
    """
    parser = etree.XMLParser(recover=True, encoding='utf-8')
    root = etree.parse(BytesIO(xml_bytes), parser).getroot()
    devices = []

    # 0) Centrale d'alarme depuis les attributs du root (si présents)
    #    Ex: name="Centrale" model_type="TSC06SFR" alarm_mode="ON|OFF|CUSTOM"
    root_name = root.attrib.get("name") or root.attrib.get("panel_name") or root.attrib.get("hub_name")
    root_model = root.attrib.get("model_type") or root.attrib.get("model") or root.attrib.get("type")
    root_mode = root.attrib.get("alarm_mode") or root.attrib.get("mode")  # ON / OFF / CUSTOM
    if root_name or root_model or root_mode:
        panel = {
            "id": "panel",                # id fixe stable
            "rrd_id": "-1",
            "nameable": "1",
            "brand": "SFR HOME",
            "zone": "-1",
            "group": "-1",
            "testable": "0",
            "deviceType": "ALARM_PANEL",
            "deviceModel": root_model or "",
            "deviceVersion": "1.0",
            "name": root_name or "Centrale",
            "long_name": f"Centrale d'alarme ({root_model})" if root_model else "Centrale d'alarme",
            "batteryLevel": "-2",
            "signalLevel": "-2",
            "status": (root_mode or "UNKNOWN").upper(),
            "categories": "alarm",
            "sensorValues": {
                "AlarmMode": {
                    "value": root_mode or "",
                    "attrs": {"name": "AlarmMode"}
                }
            }
        }
        devices.append(panel)

    # 1) Capteurs / actionneurs du XML
    for s in root.findall(".//Sensor"):
        dev = dict(s.attrib)  # attributs du <Sensor>

        # champs texte courants
        for tag in ("deviceType","deviceModel","deviceVersion","name","long_name",
                    "batteryLevel","deviceMac", "signalLevel","status","categories"):
            el = s.find(tag)
            dev[tag] = el.text.strip() if (el is not None and el.text) else None

        # sensorValues
        sv = {}
        for sv_el in s.findall(".//sensorValue"):
            name = sv_el.get("name") or sv_el.attrib.get("name") or sv_el.get("id")
            if not name:
                name = f"value_{len(sv)+1}"
            val = (sv_el.text or "").strip()
            attrs = dict(sv_el.attrib)  # convertir en dict standard
            if name in sv:
                # éviter les collisions de noms
                idx = 2
                while f"{name}_{idx}" in sv:
                    idx += 1
                name = f"{name}_{idx}"
            sv[name] = {"value": val, "attrs": attrs}

        dev["sensorValues"] = sv or None
        devices.append(dev)

    return devices

def save_outputs(devices):
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2, ensure_ascii=False)

    keys = ["id","deviceType","name","status","batteryLevel","deviceMac", "signalLevel","categories"]
    with open(OUTPUT_CSV, "w", newline='', encoding="utf-8") as csvf:
        writer = csv.DictWriter(csvf, fieldnames=keys)
        writer.writeheader()
        for d in devices:
            writer.writerow({k: d.get(k,"") for k in keys})
    print(f"[+] Écrit {OUTPUT_JSON} et {OUTPUT_CSV}")

# ---------- util debug ----------
def dump_cookies(session, filename="debug_cookies.txt", prefix=""):
    try:
        with open(filename, "a", encoding="utf-8") as f:
            f.write(f"{prefix}COOKIES:\n")
            for c in session.cookies:
                masked = (c.value[:6] + "...") if c.value else ""
                f.write(f"  {c.domain}\t{c.path}\t{c.name}={masked}\n")
            f.write("\n")
    except Exception:
        pass

# ---------- SSO & formulaires ----------
def post_sso(session, base_url, user, password):
    url = urljoin(base_url, SSO_ENDPOINT)
    data = {"connectionSFR": user, "passSFR": password}
    headers = {
        "Origin": base_url.rstrip("/"),
        "Referer": urljoin(base_url, "login"),
    }
    r = session.post(url, data=data, headers=headers, timeout=20, allow_redirects=True)
    r.raise_for_status()
    try:
        return r.json()
    except ValueError:
        return {"raw_text": r.text}

def submit_final_form(session, login_url, token_sso, user=None, password=None):
    """
    GET /login, trouver form (#loginForm / #login_form_add_rib), copier tous les inputs,
    injecter token_sso (name attendu), forcer email et passwd si présents,
    inclure le bouton submit s'il existe, POST vers l'action.
    Écrit des fichiers debug_*.html et headers.
    Retourne l'URL finale après submit.
    """
    r = session.get(login_url, headers={"Referer": login_url, "Accept":"text/html,*/*"}, timeout=20)
    r.raise_for_status()
    with open("debug_login_page.html","w",encoding="utf-8") as f:
        f.write(r.text)

    soup = BeautifulSoup(r.text, "html.parser")
    form = soup.find("form", {"id": "login_form_add_rib"}) or soup.find("form", {"id": "loginForm"})
    if not form:
        raise RuntimeError("Formulaire final (#loginForm / #login_form_add_rib) introuvable.")

    action = form.get("action") or login_url
    action_url = urljoin(login_url, action)
    method = (form.get("method") or "post").lower()

    payload = {}
    for inp in form.find_all("input"):
        itype = (inp.get("type") or "").lower()
        name = inp.get("name")
        if not name:
            continue
        value = inp.get("value", "")
        if itype == "checkbox" and not inp.has_attr("checked"):
            continue
        payload[name] = value

    submit_btn = form.find("input", {"type": "submit"})
    if submit_btn and submit_btn.get("name"):
        payload[submit_btn["name"]] = submit_btn.get("value", "")

    payload["token_sso"] = token_sso

    if user and "email" in payload and not payload.get("email"):
        payload["email"] = user
    if password and "passwd" in payload and not payload.get("passwd"):
        payload["passwd"] = password

    headers = {
        "Origin": action_url.split("/login")[0],
        "Referer": login_url,
    }

    dump_cookies(session, prefix="[AVANT SUBMIT] ")

    if method == "post":
        r2 = session.post(action_url, data=payload, headers=headers, timeout=20, allow_redirects=True)
    else:
        r2 = session.get(action_url, params=payload, headers=headers, timeout=20, allow_redirects=True)

    with open("debug_after_submit.html","w",encoding="utf-8") as f:
        f.write(r2.text)
    try:
        with open("debug_after_submit_headers.txt","w",encoding="utf-8") as f:
            f.write(f"URL finale: {r2.url}\nStatus: {r2.status_code}\n\n=== HEADERS ===\n")
            for k,v in r2.headers.items():
                f.write(f"{k}: {v}\n")
    except Exception:
        pass

    r2.raise_for_status()
    dump_cookies(session, prefix="[APRES SUBMIT] ")
    return r2.url

def warm_up_dashboard(session, dashboard_url):
    r = session.get(dashboard_url, headers={"Referer": dashboard_url}, timeout=20, allow_redirects=True)
    with open("debug_dashboard.html","w",encoding="utf-8") as f:
        f.write(r.text)
    r.raise_for_status()
    return r.url

def fetch_mysensors(session, mysensors_url, referer):
    headers = {
        "Accept": "application/xml, text/xml, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer,
    }
    r = session.get(mysensors_url, headers=headers, timeout=20, allow_redirects=True)
    if r.status_code >= 400:
        with open("debug_mysensors_error.html","wb") as f:
            f.write(r.content or b"")
    r.raise_for_status()
    return r.content

# ---------- main ----------
def main():
    args = parse_args()

    # Mode local (test parsing)
    if args.use_local:
        if not os.path.exists(LOCAL_XML_PATH):
            print(f"[!] Fichier local introuvable: {LOCAL_XML_PATH}")
            sys.exit(1)
        with open(LOCAL_XML_PATH, "rb") as f:
            xml = f.read()
        devices = parse_sensors_xml(xml)
        print(f"[+] Parse local OK : {len(devices)} devices")
        save_outputs(devices)
        return

    # Cookie direct ?
    cookie_str = args.cookie or os.getenv("SFR_SESSION_COOKIE")
    if cookie_str:
        print("[*] Utilisation d’un cookie de session fourni")
        session = requests.Session()
        session.headers.update({"User-Agent":"Mozilla/5.0", "Accept":"*/*", "Cookie": cookie_str})
        xml = fetch_mysensors(session, args.mysensors_url, referer=args.dashboard_url)
        with open("mysensors_raw.xml","wb") as f:
            f.write(xml)
        print(f"[+] mysensors récupéré ({len(xml)} octets)")
        devices = parse_sensors_xml(xml)
        print(f"[+] Parse OK : {len(devices)} devices")
        save_outputs(devices)
        return

    # SSO complet
    user = args.user or os.getenv("SFR_USER")
    if not user:
        print("[!] Fournis --user ou SFR_USER.")
        sys.exit(2)
    password = args.password or getpass.getpass(prompt=f"Mot de passe pour {user}: ")

    session = requests.Session()
    session.headers.update({
        "User-Agent":"Mozilla/5.0",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })

    print("[*] Étape 1/4 — POST SSO")
    sso = post_sso(session, args.base_url, user, password)
    token = None
    if isinstance(sso, dict) and isinstance(sso.get("result"), dict):
        token = sso["result"].get("token_sso")
    if not token:
        print("[!] token_sso manquant — flux peut avoir changé.")
        with open("debug_sso.json","w",encoding="utf-8") as f:
            f.write(json.dumps(sso, indent=2, ensure_ascii=False))
        sys.exit(1)
    print("  token_sso reçu.")

    print("[*] Étape 2/4 — Soumission du formulaire final")
    try:
        final_url = submit_final_form(session, args.login_url, token, user=user, password=password)
    except Exception as e:
        print("[!] Échec soumission du formulaire final :", e)
        print("    -> Consulte debug_login_page.html, debug_after_submit.html et debug_after_submit_headers.txt")
        sys.exit(1)
    print("  URL après submit:", final_url)

    print("[*] Étape 3/4 — Ouverture du dashboard")
    try:
        dash_url = warm_up_dashboard(session, args.dashboard_url)
    except Exception as e:
        print("[!] Échec ouverture du dashboard :", e)
        print("    -> Consulte debug_dashboard.html")
        sys.exit(1)
    print("  URL dashboard:", dash_url)

    print("[*] Étape 4/4 — Récupération mysensors")
    try:
        xml = fetch_mysensors(session, args.mysensors_url, referer=dash_url or args.dashboard_url)
        with open("mysensors_raw.xml","wb") as f:
            f.write(xml)
        print(f"[+] mysensors récupéré ({len(xml)} octets)")
    except Exception as e:
        print("[!] Échec mysensors :", e)
        print("    -> Consulte debug_mysensors_error.html (et debug_cookies.txt) pour le contenu et l’état cookies.")
        sys.exit(1)

    devices = parse_sensors_xml(xml)
    print(f"[+] Parse OK : {len(devices)} devices")
    save_outputs(devices)

if __name__ == "__main__":
    main()
