#!/usr/bin/env python3
"""Prometheus exporter for OVHcloud billing and AI endpoint costs.
Serves both /metrics (scrape) and /api/v1/query (Grafana Prometheus datasource).

AI endpoint data has two sources:
  1. Invoices (/me/bill ... details): final billed amounts, month M lands
     in an invoice dated ~1st of M+1 (in arrears).
  2. Live usage (/cloud/project/{id}/usage/current): current-month
     consumption so far, refreshed ~hourly by OVH. Exposed as
     ovhcloud_ai_live_* metrics (and merged into ovhcloud_ai_* for
     the current month).
"""

import os
import re
import time
import json
import hashlib
import sys
import urllib.request
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

OVH_APP_KEY = os.environ.get("OVH_APP_KEY", "")
OVH_APP_SECRET = os.environ.get("OVH_APP_SECRET", "")
OVH_CONSUMER_KEY = os.environ.get("OVH_CONSUMER_KEY", "")
OVH_ENDPOINT = os.environ.get("OVH_ENDPOINT", "https://eu.api.ovh.com/1.0")
REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", "3600"))
NUM_INVOICES = int(os.environ.get("NUM_INVOICES", "6"))
OVH_CLOUD_PROJECT = os.environ.get("OVH_CLOUD_PROJECT", "")

metrics = []
metrics_up = 0
last_fetch = 0
invoice_cache = {}
time_delta = None
project_cache = None


def _get_time_delta():
    global time_delta
    if time_delta is None:
        with urllib.request.urlopen(f"{OVH_ENDPOINT}/auth/time", timeout=10) as r:
            server_ts = int(r.read().decode().strip())
        time_delta = server_ts - int(time.time())
    return time_delta


def ovh_get(path):
    url = f"{OVH_ENDPOINT}{path}"
    ts = str(int(time.time()) + _get_time_delta())
    to_sign = f"{OVH_APP_SECRET}+{OVH_CONSUMER_KEY}+GET+{url}++{ts}"
    sig = "$1$" + hashlib.sha1(to_sign.encode()).hexdigest()
    req = urllib.request.Request(url, headers={
        "X-Ovh-Application": OVH_APP_KEY,
        "X-Ovh-Consumer": OVH_CONSUMER_KEY,
        "X-Ovh-Signature": sig,
        "X-Ovh-Timestamp": ts,
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def get_project():
    """Cloud project id (env override, else first project on the account)."""
    global project_cache
    if OVH_CLOUD_PROJECT:
        return OVH_CLOUD_PROJECT
    if project_cache is None:
        projects = ovh_get("/cloud/project")
        if isinstance(projects, list) and projects:
            p = projects[0]
            project_cache = p if isinstance(p, str) else p.get("name")
    return project_cache


def slugify(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def fetch_live_ai():
    """Current-month AI endpoint usage from the cloud usage API.
    Returns (ai_data, last_update_ts) where ai_data is keyed by (model, month)."""
    project = get_project()
    if not project:
        return {}, None

    model_names = []
    try:
        ml = ovh_get(f"/cloud/project/{project}/ai/endpoint")
        if isinstance(ml, list):
            model_names = [m for m in ml if isinstance(m, str)]
    except Exception:
        pass
    name_by_slug = {slugify(n): n for n in model_names}

    uc = ovh_get(f"/cloud/project/{project}/usage/current")
    if not isinstance(uc, dict):
        return {}, None

    last_update = None
    lu = uc.get("lastUpdate")
    if isinstance(lu, str):
        try:
            last_update = int(datetime.fromisoformat(lu.replace("Z", "+00:00")).timestamp())
        except ValueError:
            pass

    period = uc.get("period") or {}
    month = (period.get("from") or "")[:7]
    if not month:
        return {}, last_update

    ai_data = {}
    for tr in uc.get("resourcesUsage") or []:
        if tr.get("type") != "ai-endpoints":
            continue
        for reg in tr.get("resources") or []:
            for comp in reg.get("components") or []:
                desc = comp.get("name") or ""
                m = re.match(r"^(.+)-(input|output)_tokens$", desc)
                if not m:
                    continue
                model = name_by_slug.get(slugify(m.group(1)), m.group(1))
                direction = m.group(2)
                qty = (comp.get("quantity") or {}).get("value", 0) or 0
                price = comp.get("totalPrice", 0) or 0
                key = (model, month)
                if key not in ai_data:
                    ai_data[key] = {"input": 0, "output": 0, "cost": 0.0}
                if direction == "input":
                    ai_data[key]["input"] += int(qty)
                elif direction == "output":
                    ai_data[key]["output"] += int(qty)
                ai_data[key]["cost"] += price

    return ai_data, last_update


def fetch_data():
    global metrics, metrics_up, last_fetch
    now = time.time()
    if now - last_fetch < REFRESH_INTERVAL:
        return
    last_fetch = now
    metrics = []
    metrics_up = 0

    try:
        invoice_ids = ovh_get("/me/bill")
        if not isinstance(invoice_ids, list):
            print(f"/me/bill returned non-list: {invoice_ids!r}", file=sys.stderr, flush=True)
            return
        recent_ids = invoice_ids[-NUM_INVOICES:]

        line_items = []
        for bid in recent_ids:
            try:
                inv = ovh_get(f"/me/bill/{bid}")
            except Exception as e:
                print(f"invoice fetch failed for {bid}: {e!r}", file=sys.stderr, flush=True)
                continue
            invoice_cache[bid] = inv
            date = inv.get("date", "")[:10]
            month = date[:7]
            category = inv.get("category", "unknown")
            total = inv.get("priceWithTax", {}).get("value", 0)

            metrics.append(("ovhcloud_invoice_total_eur",
                            {"bill_id": bid, "date": date, "month": month, "category": category},
                            total))

            try:
                detail_ids = ovh_get(f"/me/bill/{bid}/details")
            except Exception as e:
                print(f"invoice details list failed for {bid}: {e!r}", file=sys.stderr, flush=True)
                continue
            if not isinstance(detail_ids, list):
                continue
            for did in detail_ids:
                try:
                    d = ovh_get(f"/me/bill/{bid}/details/{did}")
                except Exception as e:
                    print(f"invoice detail fetch failed for {bid}/{did}: {e!r}", file=sys.stderr, flush=True)
                    continue
                desc = d.get("description", "")
                period_start = d.get("periodStart", "")
                usage_month = period_start[:7] if period_start else month
                line_items.append({
                    "date": date, "month": month, "usage_month": usage_month,
                    "desc": desc,
                    "qty": int(d.get("quantity", 0) or 0),
                    "total": d.get("totalPrice", {}).get("value", 0),
                })

        ai_data = {}
        for li in line_items:
            if "AI Endpoints" not in li["desc"]:
                continue
            m = re.search(r"AI Endpoints (.+?) model", li["desc"])
            model = m.group(1) if m else "unknown"
            direction = "input" if "input" in li["desc"] else "output" if "output" in li["desc"] else "other"
            key = (model, li["usage_month"])
            if key not in ai_data:
                ai_data[key] = {"input": 0, "output": 0, "cost": 0.0}
            if direction == "input":
                ai_data[key]["input"] += li["qty"]
            elif direction == "output":
                ai_data[key]["output"] += li["qty"]
            ai_data[key]["cost"] += li["total"]

        # Live current-month usage (hourly); wins over any same-month invoice data
        live_month = None
        try:
            live_ai, live_update = fetch_live_ai()
            if live_ai:
                live_month = sorted(k[1] for k in live_ai)[-1]
            for key, d in live_ai.items():
                ai_data[key] = d
            if live_update:
                metrics.append(("ovhcloud_ai_usage_last_update_timestamp_seconds", {}, live_update))
        except Exception:
            live_ai = {}

        live_total = {}
        for (model, month), d in ai_data.items():
            if month != live_month:
                continue
            t = live_total.setdefault(month, {"input": 0, "output": 0, "cost": 0.0})
            t["input"] += d["input"]
            t["output"] += d["output"]
            t["cost"] += d["cost"]

        for (model, month), d in sorted(ai_data.items()):
            lbls = {"model": model, "month": month}
            metrics.append(("ovhcloud_ai_input_tokens", lbls, d["input"]))
            metrics.append(("ovhcloud_ai_output_tokens", lbls, d["output"]))
            metrics.append(("ovhcloud_ai_cost_eur", lbls, round(d["cost"], 4)))
            if month == live_month:
                metrics.append(("ovhcloud_ai_live_input_tokens", lbls, d["input"]))
                metrics.append(("ovhcloud_ai_live_output_tokens", lbls, d["output"]))
                metrics.append(("ovhcloud_ai_live_cost_eur", lbls, round(d["cost"], 4)))

        for month, t in sorted(live_total.items()):
            metrics.append(("ovhcloud_ai_live_input_total", {"month": month}, t["input"]))
            metrics.append(("ovhcloud_ai_live_output_total", {"month": month}, t["output"]))
            metrics.append(("ovhcloud_ai_live_total_eur", {"month": month}, round(t["cost"], 4)))

        monthly = {}
        for bid, inv in invoice_cache.items():
            if bid not in recent_ids:
                continue
            month = inv.get("date", "")[:7]
            total = inv.get("priceWithTax", {}).get("value", 0)
            monthly[month] = monthly.get(month, 0) + total
        for month, total in sorted(monthly.items()):
            metrics.append(("ovhcloud_monthly_total_eur", {"month": month}, round(total, 2)))
        if monthly:
            latest = sorted(monthly.keys())[-1]
            metrics.append(("ovhcloud_current_month_total_eur",
                            {"month": latest},
                            round(monthly[latest], 2)))

        cat_totals = {}
        for bid in recent_ids:
            inv = invoice_cache.get(bid, {})
            cat = inv.get("category", "unknown")
            total = inv.get("priceWithTax", {}).get("value", 0)
            cat_totals[cat] = cat_totals.get(cat, 0) + total
        for cat, total in sorted(cat_totals.items()):
            metrics.append(("ovhcloud_category_total_eur", {"category": cat}, round(total, 2)))

        metrics_up = 1
    except Exception as e:
        print(f"fetch_data failed: {e!r}", file=sys.stderr, flush=True)
        metrics_up = 0


def build_metrics_text():
    seen_types = set()
    lines = ["# HELP ovhcloud_up Exporter fetch status",
             "# TYPE ovhcloud_up gauge",
             f"ovhcloud_up {metrics_up}"]
    for name, labels, value in metrics:
        if name not in seen_types:
            lines.append(f"# TYPE {name} gauge")
            seen_types.add(name)
        ls = ",".join(f'{k}="{v}"' for k, v in labels.items())
        if ls:
            lines.append(f"{name}{{{ls}}} {value}")
        else:
            lines.append(f"{name} {value}")
    return "\n".join(lines) + "\n"


def parse_query(expr):
    expr = expr.strip()
    m = re.match(r'^(\w+)(?:\{(.+)\})?$', expr)
    if not m:
        return None, {}
    name = m.group(1)
    labels = {}
    if m.group(2):
        for pair in re.finditer(r'(\w+)="([^"]*)"', m.group(2)):
            labels[pair.group(1)] = pair.group(2)
    return name, labels


def do_query(expr, now_ts):
    name, label_match = parse_query(expr)
    if name is None:
        return {"status": "success", "data": {"resultType": "vector", "result": []}}
    results = []
    for mname, mlabels, mval in metrics:
        if mname != name:
            continue
        if all(mlabels.get(k) == v for k, v in label_match.items()):
            results.append({
                "metric": {"__name__": mname, **mlabels},
                "value": [now_ts, str(mval)],
            })
    return {"status": "success", "data": {"resultType": "vector", "result": results}}


def do_query_range(expr, start, end, step):
    base = do_query(expr, time.time())
    result = []
    for r in base["data"]["result"]:
        values = []
        ts = start
        while ts <= end:
            values.append([ts, r["value"][1]])
            ts += step
        result.append({"metric": r["metric"], "values": values})
    return {"status": "success", "data": {"resultType": "matrix", "result": result}}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def _handle_query(self, params):
        expr = params.get("query", [""])[0]
        now = time.time()
        if self.path.split("?", 1)[0].endswith("/query_range"):
            start = float(params.get("start", [now - 3600])[0])
            end = float(params.get("end", [now])[0])
            step = float(params.get("step", ["300"])[0])
            resp = do_query_range(expr, start, end, step)
        else:
            resp = do_query(expr, now)
        self._send(200, "application/json", json.dumps(resp).encode())

    def do_GET(self):
        parsed = urlparse(self.path)
        path, params = parsed.path, parse_qs(parsed.query)
        if path == "/metrics":
            fetch_data()
            self._send(200, "text/plain; charset=utf-8", build_metrics_text().encode())
        elif path in ("/api/v1/query", "/api/v1/query_range"):
            fetch_data()
            self._handle_query(params)
        elif path == "/health":
            self._send(200, "application/json", b'{"status":"ok"}')
        elif path == "/api/v1/labels":
            fetch_data()
            names = sorted(set(m[0] for m in metrics))
            self._send(200, "application/json",
                       json.dumps({"status": "success", "data": names}).encode())
        elif path == "/api/v1/label/__name__/values":
            fetch_data()
            names = sorted(set(m[0] for m in metrics))
            self._send(200, "application/json",
                       json.dumps({"status": "success", "data": names}).encode())
        else:
            self._send(404, "text/plain", b"not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        clen = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(clen).decode() if clen else ""
        if path in ("/api/v1/query", "/api/v1/query_range"):
            fetch_data()
            params = parse_qs(body)
            self._handle_query(params)
        else:
            self._send(404, "text/plain", b"not found")

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("LISTEN_PORT", "8001"))
    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"OVHcloud exporter listening on :{port}")
    server.serve_forever()
