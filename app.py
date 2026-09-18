import csv
import io
import json
import math
import os

import numpy as np
from flask import Flask, jsonify, request, send_from_directory

ROOT = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(ROOT, "data", "api.json"), encoding="utf-8") as fh:
    API = json.load(fh)

app = Flask(__name__, static_folder="static", static_url_path="")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "rcvb-v1-platform"}


@app.get("/api/default")
def defaults():
    return jsonify(API["/api/default"])


@app.get("/api/catalog")
def catalog():
    return jsonify(API["/api/catalog"])


@app.get("/api/protocol")
def protocol():
    return jsonify(API["/api/protocol"])


@app.get("/api/demo-result")
def demo_result():
    return jsonify(API["/api/demo-result"])


@app.post("/api/scenario")
def scenario():
    body = request.get_json(force=True)
    item = next((x for x in API["/api/catalog"] if x["scenario_id"] == body.get("scenario_id")), None)
    if not item:
        return jsonify(error="未知场景。"), 404
    area = float(body.get("area_m2", 500))
    envelope_area = area * (item["wall_area_ratio"] + item["roof_area_ratio"] + item["window_area_ratio"])
    u_mean = (item["wall_u_w_m2k"] + item["roof_u_w_m2k"] + item["window_u_w_m2k"]) / 3
    ua_kw_k = max(0.05, envelope_area * u_mean / 1000)
    r = 1 / ua_kw_k
    c = area * item["c_area_kwh_m2k"]
    eta = item["cop_total_demo"] * item["sensible_fraction_demo"]
    cfg = dict(API["/api/default"])
    cfg.update(r_k_per_kw=r, c_kwh_per_k=c, eta_sensible=eta)
    return jsonify(prior={"scenario": item, "area_m2": area, "r_k_per_kw": r, "c_kwh_per_k": c,
                          "eta_sensible": eta, "tau_h": r * c,
                          "warning": "D0 演示先验，必须用项目实测校准。"}, config=cfg)


def _float(row, names):
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            return float(value)
    raise ValueError("缺少字段：" + "/".join(names))


@app.post("/api/identify")
def identify():
    try:
        body = request.get_json(force=True)
        step = int(body.get("identify_minutes", 5))
        rows = list(csv.DictReader(io.StringIO(body["csv_text"])))
        # The downloadable 24 h examples include a final END_BOUNDARY row whose
        # temperature is useful for the last transition but whose HVAC inputs
        # are intentionally blank.  Keep it for ``nxt`` while only building
        # regressors from complete input rows below.
        if len(rows) < max(30, step * 4):
            raise ValueError("数据量不足。请上传连续的 1 分钟 CSV。")
        tin = np.array([_float(r, ["indoor_temp_c", "indoor_temp", "tin_c"]) for r in rows])
        tout = np.array([_float(r, ["outdoor_temp_c", "outdoor_temp", "tout_c"]) for r in rows])
        input_rows = rows[:-1]
        power = np.array([_float(r, ["hvac_kw", "hvac_power", "hvac_power_kw"]) for r in input_rows])
        n = min(len(tin) - 1, len(power))
        idx = np.arange(0, n, step)
        if len(idx) < 12:
            raise ValueError("聚合后样本不足。")
        ti, to = tin[idx], tout[idx]
        nxt = tin[np.minimum(idx + step, len(tin) - 1)]
        pw = np.array([power[i:min(i + step, n)].mean() for i in idx])
        solar = np.array([np.mean([float(rows[j].get("solar_w_m2") or rows[j].get("solar") or 0)
                                   for j in range(i, min(i + step, n))]) for i in idx])
        x = np.column_stack([ti - to, pw, solar, np.ones(len(idx))])
        coef, *_ = np.linalg.lstsq(x, nxt - to, rcond=None)
        a = float(np.clip(coef[0], 0.01, 0.9999))
        dt_h = step / 60
        tau = -dt_h / math.log(a)
        r_eta = max(1e-6, -float(coef[1]) / (1 - a))
        c_over_eta = tau / r_eta
        pred = to + x @ coef
        rmse = float(np.sqrt(np.mean((nxt - pred) ** 2)))
        baseline = float(np.sqrt(np.mean((nxt - ti) ** 2)))
        quality = "PASS_SHADOW_ONLY" if rmse < baseline and 0.1 < tau < 200 else "COLLECT_MORE_DATA"
        trace_n = min(240, len(nxt))
        return jsonify(
            identification_step_min=step,
            tau_h=tau,
            r_times_eta_k_per_kw=r_eta,
            c_over_eta_kwh_per_k=c_over_eta,
            coefficients={"a": a, "power": float(coef[1]), "solar": float(coef[2]), "bias": float(coef[3])},
            metrics={"holdout_one_step_rmse_c": rmse, "persistence_rmse_c": baseline},
            quality_status=quality,
            closed_loop_allowed=False,
            trace={"measured_c": nxt[:trace_n].tolist(), "free_run_c": pred[:trace_n].tolist()},
            warning="一天数据仅用于快速等效辨识和影子仿真；不能独立辨识真实 COP。",
        )
    except Exception as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/parameter-package")
def parameter_package():
    ident = request.get_json(force=True).get("identification", {})
    return jsonify(schema="rcvb-mpc-parameter-package-v1", mode="SHADOW_ONLY",
                   closed_loop_allowed=False, identification=ident)


@app.post("/api/run")
def run_demo():
    result = json.loads(json.dumps(API["/api/demo-result"]))
    result.setdefault("metadata", {})["online_mode"] = "VALIDATED_SYNTHETIC_DEMO_NOT_RECOMPUTED"
    return jsonify(result)


@app.get("/docs/README")
def docs():
    return send_from_directory(app.static_folder, "README.md", mimetype="text/markdown")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
