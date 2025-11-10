#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sfr_mysensors_sso.py — version avec gestion persistante des cookies:
 - préférence aux cookies stockés (session_cookies.json)
 - si échec cookie -> SSO avec credentials, suppression / récréation des cookies
 - parsing XML : ajout device synthétique ALARM_PANEL + video_url pour CAMERA_WIFI
 - normalisation générique du champ 'brand':
     * '' (vide) conservé tel quel (périphériques SFR)
     * 'logo_xxx.png' -> 'Xxx' (title case), idem si chemin contient 'logo_xxx.ext'

Dépendances :
    pip install requests lxml beautifulsoup4
"""
import os
import sys
import json
import csv
import re
import argparse
import getpass
import requests
from bs4 import BeautifulSoup
from lxml import etree
from io import BytesIO
from urllib.parse import urljoin
from requests.cookies import RequestsCookieJar

# ---------- valeurs par défaut ----------
BASE_URL_DEFAULT = "https://home.sfr.fr/"
LOGIN_URL_DEFAULT = "https://home.sfr.fr/login"
DASHBOARD_URL_DEFAULT = "https://home.sfr.fr/"   # page d'atterrissage
SSO_ENDPOINT = "sso-connector.php"
MYSENSORS_URL_DEFAULT = "https://home.sfr.fr/mysensors"
LOCAL_XML_PATH = "/mnt/data/mysensors.xml"
OUTPUT_JSON = "/tmp/devices.json"
OUTPUT_CSV = "/tmp/devices.csv"
COOKIE_FILE = "session_cookies.json"   # fichier de cookies persistés

# ---------- arguments ----------
def parse_args():
    p = argparse.ArgumentParser(description="SFR Home: login SSO + fetch mysensors (robust) with cookie persistence")
    p.add_argument("--user","-u", help="Identifiant / email SFR")
    p.add_argument("--password","-p", help="Mot de passe (sinon, saisie cachée)")
    p.add_argument("--cookie","-c", help="Chaîne Cookie (si fournie, utilisée prioritairement à session_cookies.json)")
    p.add_argument("--use-local", action="store_true", help=f"Utiliser {LOCAL_XML_PATH} au lieu du réseau")
    p.add_argument("--base-url", default=BASE_URL_DEFAULT)
    p.add_argument("--login-url", default=LOGIN_URL_DEFAULT)
    p.add_argument("--dashboard-url", default=DASHBOARD_URL_DEFAULT)
    p.add_argument("--mysensors-url", default=MYSENSORS_URL_DEFAULT)
    return p.parse_args()

# ---------- utils ----------
def normalize_brand(raw: str) -> str:
    """
    Règle générique:
      - Si vide -> 'SFR HOME' (périphériques SFR)
      - Si type 'logo_philips.png' (ou chemin .../logo_philips.png) -> 'Philips'
      - Remplace '_' et '-' par espaces, Title Case.
    """
    if not raw or not str(raw).strip():
        return "SFR HOME"
    s = str(raw).strip()

    # On récupère le dernier segment (au cas où il y a un chemin)
    last = s.split("/")[-1]

    # Cherche 'logo_xxx.ext' (xxx en minuscules/chiffres)
    m = re.match(r'^logo[_-]([a-z0-9_ -]+?)(?:\.[A-Za-z0-9]+)?$', last)
    if not m:
        # parfois l'extension peut ne pas être présente ou pattern légèrement différent
        m = re.search(r'logo[_-]([a-z0-9_ -]+)', last)
    if m:
        core = m.group(1)
    else:
        # Pas de pattern 'logo_...' : on renvoie la valeur brute
        return s

    core = core.replace("_", " ").replace("-", " ").strip()
    if not core:
        return "SFR HOME"

    # Title Case sans forcer d'accents spécifiques
    normalized = " ".join(w.capitalize() for w in core.split())
    return normalized
 

# ---------- parsing XML (avec ALARM_PANEL + video_url + brand normalisé) ----------
def parse_sensors_xml(xml_bytes):
    parser = etree.XMLParser(recover=True, encoding='utf-8')
    root = etree.parse(BytesIO(xml_bytes), parser).getroot()
    devices = []

    # Centrale d'alarme depuis attributs root
    root_name = root.attrib.get("name") or root.attrib.get("panel_name") or root.attrib.get("hub_name")
    root_model = root.attrib.get("model_type") or root.attrib.get("model") or root.attrib.get("type")
    root_mode = root.attrib.get("alarm_mode") or root.attrib.get("mode")
    if root_name or root_model or root_mode:
        panel = {
            "id": "panel",
            "rrd_id": "-1",
            "nameable": "1",
            "brand": "SFR HOME",  # cohérent avec précédentes versions
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

    # Capteurs / actionneurs
    for s in root.findall(".//Sensor"):
        dev = dict(s.attrib)

        # Champs texte usuels
        for tag in ("deviceType","deviceModel","deviceVersion","name","long_name",
                    "batteryLevel","deviceMac", "signalLevel","status","categories","brand"):
            el = s.find(tag)
            dev[tag] = el.text.strip() if (el is not None and el.text) else dev.get(tag)

        # Normaliser brand s'il existe (vide conservé)
        if "brand" in dev and dev["brand"] is not None:
            dev["brand"] = normalize_brand(dev["brand"])

        # sensorValues
        sv = {}
        for sv_el in s.findall(".//sensorValue"):
            name = sv_el.get("name") or sv_el.attrib.get("name") or sv_el.get("id")
            if not name:
                name = f"value_{len(sv)+1}"
            val = (sv_el.text or "").strip()
            attrs = dict(sv_el.attrib)
            if name in sv:
                idx = 2
                while f"{name}_{idx}" in sv:
                    idx += 1
                name = f"{name}_{idx}"
            sv[name] = {"value": val, "attrs": attrs}
        dev["sensorValues"] = sv or None

        # Video URL pour caméras
        dtype = (dev.get("deviceType") or "").upper()
        if dtype == "CAMERA_WIFI":
            mac = dev.get("deviceMac")
            dev["video_url"] = f"https://home.sfr.fr/homescope/flv?localconn=0&mac={mac}" if mac else None

        devices.append(dev)

    return devices

def save_outputs(devices):
    # JSON
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(devices, f, indent=2, ensure_ascii=False)

    # CSV (ajout de 'brand')
    keys = ["id","deviceType","name","status","batteryLevel","deviceMac", "signalLevel","categories","brand","video_url"]
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

# ---------- cookie persistence helpers ----------
def save_cookies_file(session, path=COOKIE_FILE):
    try:
        cookies_list = []
        for c in session.cookies:
            cookies_list.append({
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path,
                "expires": getattr(c, "expires", None)
            })
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cookies_list, f, indent=2)
        print(f"[+] Cookies sauvegardés dans {path}")
    except Exception as e:
        print(f"[!] Échec sauvegarde cookies: {e}")

def load_cookies_file(session, path=COOKIE_FILE):
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            cookies_list = json.load(f)
        jar = RequestsCookieJar()
        for c in cookies_list:
            name = c.get("name")
            value = c.get("value")
            domain = c.get("domain")
            path_ = c.get("path") or "/"
            jar.set(name, value, domain=domain, path=path_)
        session.cookies = jar
        print(f"[+] Cookies chargés depuis {path}")
        return True
    except Exception as e:
        print(f"[!] Échec lecture cookies {path}: {e}")
        return False

def remove_cookies_file(path=COOKIE_FILE):
    try:
        if os.path.exists(path):
            os.remove(path)
            print(f"[+] Fichier cookies {path} supprimé")
    except Exception as e:
        print(f"[!] Impossible de supprimer {path}: {e}")

def parse_cookie_string_to_session(cookie_str):
    session = requests.Session()
    session.headers.update({"User-Agent":"Mozilla/5.0", "Accept":"*/*"})
    jar = RequestsCookieJar()
    parts = [p.strip() for p in cookie_str.split(";") if p.strip()]
    for p in parts:
        if "=" in p:
            k,v = p.split("=",1)
            jar.set(k.strip(), v.strip(), path="/")
    session.cookies = jar
    return session

# ---------- SSO & formulaires (inchangés de ta version qui marche) ----------
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

    # (ta version) injection token dans 'token_sso'
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

    # Cookie explicite ?
    explicit_cookie = args.cookie or os.getenv("SFR_SESSION_COOKIE")
    if explicit_cookie:
        print("[*] Utilisation d’un cookie fourni via --cookie / SFR_SESSION_COOKIE")
        session = parse_cookie_string_to_session(explicit_cookie)
        try:
            xml = fetch_mysensors(session, args.mysensors_url, referer=args.dashboard_url)
            with open("mysensors_raw.xml","wb") as f:
                f.write(xml)
            print(f"[+] mysensors récupéré ({len(xml)} octets) via cookie explicite")
            devices = parse_sensors_xml(xml)
            save_outputs(devices)
            save_cookies_file(session)
            return
        except Exception as e:
            print(f"[!] Échec avec cookie fourni: {e}")
            # on continue vers cookie-file / sso

    # Cookies persistés ?
    session = requests.Session()
    session.headers.update({
        "User-Agent":"Mozilla/5.0",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })

    if load_cookies_file(session):
        try:
            print("[*] Tentative d'accès via cookies stockés")
            xml = fetch_mysensors(session, args.mysensors_url, referer=args.dashboard_url)
            with open("mysensors_raw.xml","wb") as f:
                f.write(xml)
            print(f"[+] mysensors récupéré ({len(xml)} octets) via cookies stockés")
            devices = parse_sensors_xml(xml)
            save_outputs(devices)
            return
        except Exception as e:
            print(f"[!] Échec via cookies stockés: {e}")
            dump_cookies(session, prefix="[FAIL COOKIE LOAD] ")
            remove_cookies_file()

    # SSO
    user = args.user or os.getenv("SFR_USER")
    if not user:
        print("[!] Fournis --user ou SFR_USER pour authentification initiale.")
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
        print("[!] token_sso manquant — flux peut avoir changé. Dump SSO en debug_sso.json")
        with open("debug_sso.json","w",encoding="utf-8") as f:
            try:
                f.write(json.dumps(sso, indent=2, ensure_ascii=False))
            except Exception:
                f.write(str(sso))
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

    save_cookies_file(session)

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
