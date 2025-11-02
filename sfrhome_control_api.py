#!/usr/bin/env python3
from flask import Flask, request, jsonify
import datetime

app = Flask(__name__)

def log(msg):
    print(f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)

@app.route("/api/device/<dev_id>/set", methods=["POST"])
def set_device(dev_id):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    log(f"CMD device {dev_id}: ON={on}")
    # TODO: appeler ici la commande SFR réelle (quand endpoint identifié)
    # Retour "accepted"
    return jsonify({"ok": True, "id": dev_id, "on": on})

@app.route("/api/alarm/set", methods=["POST"])
def set_alarm():
    data = request.get_json(silent=True) or {}
    dev_id = data.get("id", "panel")
    mode = (data.get("mode") or "OFF").upper()  # OFF / CUSTOM / ON
    log(f"CMD alarm {dev_id}: MODE={mode}")
    # TODO: appeler ici la commande SFR réelle
    return jsonify({"ok": True, "id": dev_id, "mode": mode})

if __name__ == "__main__":
    # lancer sur 127.0.0.1:5000
    app.run(host="127.0.0.1", port=5000)
