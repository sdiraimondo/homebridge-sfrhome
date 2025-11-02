#!/usr/bin/env python3
import argparse, os, datetime
from flask import Flask, request, jsonify

app = Flask(__name__)

def log(msg):
    print(f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)

@app.route("/api/device/<dev_id>/set", methods=["POST"])
def set_device(dev_id):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    log(f"CMD device {dev_id}: ON={on}")
    return jsonify({"ok": True, "id": dev_id, "on": on})

@app.route("/api/alarm/set", methods=["POST"])
def set_alarm():
    data = request.get_json(silent=True) or {}
    dev_id = data.get("id", "panel")
    mode = (data.get("mode") or "OFF").upper()
    log(f"CMD alarm {dev_id}: MODE={mode}")
    return jsonify({"ok": True, "id": dev_id, "mode": mode})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "5000")))
    args = parser.parse_args()
    app.run(host=args.host, port=args.port)
