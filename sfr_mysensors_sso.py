#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
from bs4 import BeautifulSoup
import lxml.etree as ET
import json
import csv
import argparse
import sys
import os

# --------------------------------------------------------------------------------------
# CONFIG PAR DÉFAUT
# --------------------------------------------------------------------------------------
BASE_URL = "https://home.sfr.fr"
LOGIN_URL = f"{BASE_URL}/login"
SSO_CONNECTOR_URL = f"{BASE_URL}/sso-connector.php"
MYSENSORS_URL = f"{BASE_URL}/mysensors"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
}

# --------------------------------------------------------------------------------------
# ARGUMENTS
# --------------------------------------------------------------------------------------
def parse_args():
    p = argparse.ArgumentParser(description="SFR Home mysensors fetcher (via SSO)")
    p.add_argument("--user", required=True, help="Nom d'utilisateur SFR (email)")
    p.add_argument("--password", required=True, help="Mot de passe SFR")
    p.add_argument("--output-json", dest="output_json", help="Fichier JSON de sortie", default="devices.json")
    p.add_argument("--output-csv", dest="output_csv", help="Fichier CSV de sortie", default="devices.csv")
    p.add_argument("--debug", action="store_true", help="Activer les fichiers debug HTML")
    return p.parse_args()

# --------------------------------------------------------------------------------------
# PARSE XML DES CAPTEURS
# --------------------------------------------------------------------------------------
def parse_sensors_xml(xml_text):
    devices = []
    try:
        root = ET.fromstring(xml_text.encode("utf-8"))
    except ET.XMLSyntaxError:
        print("[!] Erreur : XML illisible ou incomplet.")
        return devices

    for el in root.findall(".//device"):
        dev = el.attrib.copy()
        sv = {}
        for sv_el in el.findall(".//sensorValue"):
            name = sv_el.get("name") or sv_el.get("type") or "unknown"
            val = sv_el.text or ""
            sv[name] = {"value": val, "attrs": dict(sv_el.attrib)}
        dev["sensorValues"] = sv
        devices.append(dev)

    # Ajouter la centrale d’alarme si présente sur la première ligne XML
    root_attrs = root.attrib
    if "name" in root_attrs and "model_type" in root_attrs and "alarm_mode" in root_attrs:
        centrale = {
            "name": root_attrs["name"],
            "model_type": root_attrs["model_type"],
            "alarm_mode": root_attrs["alarm_mode"],
            "sensorValues": {
                "alarm_mode": {"value": root_attrs["alarm_mode"]}
            },
        }
        devices.append(centrale)

    return devices

# --------------------------------------------------------------------------------------
# EXPORT JSON / CSV
# --------------------------------------------------------------------------------------
def export_json(devices, filename):
    try:
        with open(filename, "w", encoding="utf-8") as f:
            json.dump(devices, f, ensure_ascii=False, indent=2)
        print(f"[+] JSON écrit : {filename} ({len(devices)} devices)")
    except Exception as e:
        print(f"[!] Erreur d’écriture JSON : {e}")

def export_csv(devices, filename):
    try:
        with open(filename, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["name", "model_type", "status", "batteryLevel", "signalLevel", "alarm_mode"])
            for d in devices:
                writer.writerow([
                    d.get("name"),
                    d.get("model_type"),
                    d.get("status"),
                    d.get("batteryLevel"),
                    d.get("signalLevel"),
                    d.get("alarm_mode"),
                ])
        print(f"[+] CSV écrit : {filename}")
    except Exception as e:
        print(f"[!] Erreur d’écriture CSV : {e}")

# --------------------------------------------------------------------------------------
# CONNEXION SSO
# --------------------------------------------------------------------------------------
def connect_and_fetch(user, password, debug=False):
    session = requests.Session()
    session.headers.update(HEADERS)

    # Étape 1 : POST SSO
    print("[*] Étape 1/4 — POST SSO")
    resp1 = session.post(SSO_CONNECTOR_URL, data={"username": user, "password": password})
    if resp1.status_code != 200:
        print(f"[!] Erreur SSO : {resp1.status_code}")
        return None
    if debug:
        open("debug_sso.html", "w").write(resp1.text)

    # Étape 2 : login final
    print("[*] Étape 2/4 — Soumission du formulaire final")
    resp2 = session.get(LOGIN_URL)
    if debug:
        open("debug_login.html", "w").write(resp2.text)

    # Étape 3 : tableau de bord
    print("[*] Étape 3/4 — Ouverture du dashboard")
    resp3 = session.get(f"{BASE_URL}/accueil")
    if debug:
        open("debug_dashboard.html", "w").write(resp3.text)

    # Étape 4 : récupération des capteurs
    print("[*] Étape 4/4 — Récupération mysensors")
    resp4 = session.get(MYSENSORS_URL)
    if resp4.status_code != 200:
        print(f"[!] Échec mysensors : {resp4.status_code}")
        if debug:
            open("debug_mysensors_error.html", "w").write(resp4.text)
        return None
    return resp4.text

# --------------------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------------------
def main():
    args = parse_args()

    xml_text = connect_and_fetch(args.user, args.password, args.debug)
    if not xml_text:
        print("[!] Aucune donnée récupérée.")
        sys.exit(1)

    devices = parse_sensors_xml(xml_text)
    print(f"[+] Parse OK : {len(devices)} devices")

    # Export JSON & CSV
    export_json(devices, args.output_json)
    export_csv(devices, args.output_csv)

# --------------------------------------------------------------------------------------
if __name__ == "__main__":
    main()
