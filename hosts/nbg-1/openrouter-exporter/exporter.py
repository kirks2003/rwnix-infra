#!/usr/bin/env python3
"""Prometheus exporter for OpenRouter API key credits.
Serves both /metrics (scrape) and /api/v1/query (Grafana Prometheus datasource)."""

import os
import time
import json
import re
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", "300"))

metrics_text = ""
metrics_parsed = {}  # name -> value
last_fetch = 0


def fetch_credits():
    global metrics_text, metrics_parsed, last_fetch
    now = time.time()
    if now - last_fetch < REFRESH_INTERVAL:
        return
    last_fetch = now
    # Default: down
    metrics_parsed = {"openrouter_up": 0}
    metrics_text = "# HELP openrouter_up Exporter fetch status\n# TYPE openrouter_up gauge\nopenrouter_up 0\n"

    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/key",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            d = data.get("data", {})
            limit = d.get("limit") or 0
            remaining = d.get("limit_remaining") or 0
            usage = d.get("usage") or 0
            usage_monthly = d.get("usage_monthly") or 0
            usage_weekly = d.get("usage_weekly") or 0
            usage_daily = d.get("usage_daily") or 0
            is_free = d.get("is_free_tier", False)
            fm_used = d.get("free_model_daily_requests", {}).get("used", 0)
            fm_limit = d.get("free_model_daily_requests", {}).get("limit", 0)
            fm_remaining = d.get("free_model_daily_requests", {}).get("remaining", 0)
    except Exception as e:
        metrics_text = "# HELP openrouter_up Exporter fetch status\n# TYPE openrouter_up gauge\nopenrouter_up 0\n"
        metrics_parsed = {"openrouter_up": 0}
        return

    # Also fetch account balance from /credits
    total_credits = 0
    total_usage_acc = 0
    try:
        req2 = urllib.request.Request(
            "https://openrouter.ai/api/v1/credits",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
        )
        with urllib.request.urlopen(req2, timeout=15) as resp2:
            data2 = json.loads(resp2.read().decode())
            d2 = data2.get("data", {})
            total_credits = d2.get("total_credits") or 0
            total_usage_acc = d2.get("total_usage") or 0
    except Exception:
        pass  # non-critical, show as 0

    metrics_parsed = {
        "openrouter_up": 1,
        "openrouter_credit_limit": limit,
        "openrouter_credit_remaining": remaining,
        "openrouter_credits_used_total": usage,
        "openrouter_credits_used_monthly": usage_monthly,
        "openrouter_credits_used_weekly": usage_weekly,
        "openrouter_credits_used_daily": usage_daily,
        "openrouter_is_free_tier": 1 if is_free else 0,
        "openrouter_free_model_daily_requests_used": fm_used,
        "openrouter_free_model_daily_requests_limit": fm_limit,
        "openrouter_free_model_daily_requests_remaining": fm_remaining,
        "openrouter_account_total_credits": total_credits,
        "openrouter_account_total_usage": total_usage_acc,
        "openrouter_account_balance": total_credits - total_usage_acc,
    }

    lines = [
        "# HELP openrouter_up Exporter fetch status",
        "# TYPE openrouter_up gauge",
        f"openrouter_up {metrics_parsed['openrouter_up']}",
        "# HELP openrouter_credit_limit Total credit limit for this API key",
        "# TYPE openrouter_credit_limit gauge",
        f"openrouter_credit_limit {metrics_parsed['openrouter_credit_limit']}",
        "# HELP openrouter_credit_remaining Remaining credits for this API key",
        "# TYPE openrouter_credit_remaining gauge",
        f"openrouter_credit_remaining {metrics_parsed['openrouter_credit_remaining']}",
        "# HELP openrouter_credits_used_total Total credits used (all time)",
        "# TYPE openrouter_credits_used_total gauge",
        f"openrouter_credits_used_total {metrics_parsed['openrouter_credits_used_total']}",
        "# HELP openrouter_credits_used_monthly Credits used in current UTC month",
        "# TYPE openrouter_credits_used_monthly gauge",
        f"openrouter_credits_used_monthly {metrics_parsed['openrouter_credits_used_monthly']}",
        "# HELP openrouter_credits_used_weekly Credits used in current UTC week",
        "# TYPE openrouter_credits_used_weekly gauge",
        f"openrouter_credits_used_weekly {metrics_parsed['openrouter_credits_used_weekly']}",
        "# HELP openrouter_credits_used_daily Credits used in current UTC day",
        "# TYPE openrouter_credits_used_daily gauge",
        f"openrouter_credits_used_daily {metrics_parsed['openrouter_credits_used_daily']}",
        "# HELP openrouter_is_free_tier Whether the user has never purchased credits",
        "# TYPE openrouter_is_free_tier gauge",
        f"openrouter_is_free_tier {metrics_parsed['openrouter_is_free_tier']}",
        "# HELP openrouter_free_model_daily_requests_used Free model requests used today",
        "# TYPE openrouter_free_model_daily_requests_used gauge",
        f"openrouter_free_model_daily_requests_used {metrics_parsed['openrouter_free_model_daily_requests_used']}",
        "# HELP openrouter_free_model_daily_requests_limit Free model daily request limit",
        "# TYPE openrouter_free_model_daily_requests_limit gauge",
        f"openrouter_free_model_daily_requests_limit {metrics_parsed['openrouter_free_model_daily_requests_limit']}",
        "# HELP openrouter_free_model_daily_requests_remaining Free model requests remaining today",
        "# TYPE openrouter_free_model_daily_requests_remaining gauge",
        f"openrouter_free_model_daily_requests_remaining {metrics_parsed['openrouter_free_model_daily_requests_remaining']}",
        "# HELP openrouter_account_total_credits Total credits purchased on the account",
        "# TYPE openrouter_account_total_credits gauge",
        f"openrouter_account_total_credits {metrics_parsed['openrouter_account_total_credits']}",
        "# HELP openrouter_account_total_usage Total credits used from the account",
        "# TYPE openrouter_account_total_usage gauge",
        f"openrouter_account_total_usage {metrics_parsed['openrouter_account_total_usage']}",
        "# HELP openrouter_account_balance Current account balance (total_credits - total_usage)",
        "# TYPE openrouter_account_balance gauge",
        f"openrouter_account_balance {metrics_parsed['openrouter_account_balance']}",
    ]
    metrics_text = "\n".join(lines) + "\n"


def build_promql_result(expr, now_ts):
    """Build a Prometheus instant-query response for simple metric selectors."""
    name = expr.strip()
    # Strip prometheus functions like scalar(), rate(), etc.
    name = re.sub(r'^(\w+)\(', '', name)
    name = re.sub(r'\)$', '', name) if name != expr else name
    name = name.strip()
    # Handle operators: openrouter_credits_used_total / (openrouter_credit_limit > 0 or ...)
    # For simplicity, match any known metric name
    value = None
    for mname, mval in metrics_parsed.items():
        if mname in expr:
            value = mval
            break

    if value is None:
        return {"status": "success", "data": {"resultType": "vector", "result": []}}

    return {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {
                    "metric": {"__name__": name},
                    "value": [now_ts, str(value)],
                }
            ],
        },
    }


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/metrics":
            fetch_credits()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(metrics_text.encode())

        elif path == "/api/v1/query":
            fetch_credits()
            expr = params.get("query", [""])[0]
            now_ts = time.time()
            result = build_promql_result(expr, now_ts)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        elif path == "/api/v1/query_range":
            fetch_credits()
            expr = params.get("query", [""])[0]
            now_ts = time.time()
            start = float(params.get("start", [now_ts - 3600])[0])
            end = float(params.get("end", [now_ts])[0])
            step = float(params.get("step", ["300"])[0])
            base = build_promql_result(expr, now_ts)
            ts = start
            values = []
            while ts <= end:
                values.append([ts, str(base["data"]["result"][0]["value"][1])]) if base["data"]["result"] else None
                ts += step
            result = {
                "status": "success",
                "data": {
                    "resultType": "matrix",
                    "result": [
                        {
                            "metric": {"__name__": expr.strip()},
                            "values": values,
                        }
                    ],
                },
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        elif path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')

        elif path == "/api/v1/labels":
            fetch_credits()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "success", "data": list(metrics_parsed.keys())
            }).encode())

        elif path == "/api/v1/label/__name__/values":
            fetch_credits()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "success", "data": list(metrics_parsed.keys())
            }).encode())

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode() if content_length > 0 else ""

        if path == "/api/v1/query":
            fetch_credits()
            params = parse_qs(body)
            expr = params.get("query", [""])[0]
            now_ts = time.time()
            result = build_promql_result(expr, now_ts)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        elif path == "/api/v1/query_range":
            fetch_credits()
            params = parse_qs(body)
            expr = params.get("query", [""])[0]
            now_ts = time.time()
            start = float(params.get("start", [now_ts - 3600])[0])
            end = float(params.get("end", [now_ts])[0])
            step = float(params.get("step", ["300"])[0])
            base = build_promql_result(expr, now_ts)
            values = []
            ts = start
            while ts <= end:
                if base["data"]["result"]:
                    values.append([ts, str(base["data"]["result"][0]["value"][1])])
                ts += step
            result = {
                "status": "success",
                "data": {
                    "resultType": "matrix",
                    "result": [
                        {
                            "metric": {"__name__": expr.strip()},
                            "values": values,
                        }
                    ],
                },
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("LISTEN_PORT", "8000"))
    server = HTTPServer(("0.0.0.0", port), MetricsHandler)
    print(f"OpenRouter exporter listening on :{port}")
    server.serve_forever()
