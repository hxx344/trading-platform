"""One fixed read-only Var portfolio request using the standard-library HTTP client.

Copied from project_aggregation modules/asset/scripts/variational-diagnostic.py at 0014655, balance reading only.
Changes: only the "sync-portfolio" operation is kept (diagnostics and positions are left out); request, header,
classification, size limits and output contract of that operation are unchanged. Run as `python3 -I -B`.

The only credential input is stdin. Never print upstream bodies or exception text.
"""
import json
import math
import re
import socket
import sys
import time
import urllib.error
import urllib.request

TARGETS = {
    "sync-portfolio": ("portfolio", "/api/portfolio?compute_margin=true"),
}
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
MAX_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = 8192


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def content_kind(value):
    mime = (value or "").split(";", 1)[0].strip().lower()
    if not mime:
        return "missing"
    if mime == "application/json" or re.fullmatch(r"application/[a-z0-9.+-]+\+json", mime):
        return "json"
    if mime in ("text/html", "application/xhtml+xml"):
        return "html"
    return "other"


def valid_token(value):
    return isinstance(value, str) and 5 <= len(value) <= 4096 and re.fullmatch(r"[A-Za-z0-9._~-]+", value) is not None


def valid_balance(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return False
    if isinstance(value, str) and (len(value) > 128 or re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value) is None):
        return False
    try:
        number = float(value)
        return math.isfinite(number) and not (isinstance(value, str) and number == 0 and re.search(r"[1-9]", value))
    except (ValueError, OverflowError):
        return False


def probe(token, opener=None, operation="sync-portfolio"):
    if not valid_token(token) or not isinstance(operation, str) or operation not in TARGETS:
        raise ValueError("Invalid input")
    endpoint, path = TARGETS[operation]
    started = time.monotonic()
    result = {"endpoint": endpoint, "path": path, "status": None,
              "contentType": None, "challenge": False, "elapsedMs": 0,
              "structureOk": None, "outcome": "network_error", "balance": None}
    response = None
    try:
        # Match Grid's Client.request login path, including its three headers.
        request = urllib.request.Request("https://omni.variational.io" + path, headers={
            "Cookie": "vr-token=" + token, "User-Agent": USER_AGENT, "Accept": "application/json",
        }, method="GET")
        client = opener if opener is not None else urllib.request.build_opener(NoRedirect())
        try:
            response = client.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        status = response.getcode()
        result["status"] = status if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 else None
        result["contentType"] = content_kind(response.headers.get("Content-Type"))
        result["challenge"] = response.headers.get("cf-mitigated", "").strip().lower() == "challenge"
        if result["challenge"]:
            result["outcome"] = "challenge"
        elif isinstance(status, int) and 300 <= status < 400:
            result["outcome"] = "redirect"
        elif status in (401, 403, 429):
            result["outcome"] = {401: "unauthorized", 403: "forbidden", 429: "rate_limited"}[status]
        elif not isinstance(status, int) or not 200 <= status < 300:
            result["outcome"] = "network_error"
        elif result["contentType"] == "html":
            result["outcome"] = "html"
        elif result["contentType"] != "json":
            result["outcome"] = "invalid_data"
        else:
            length = response.headers.get("Content-Length")
            if length and length.isdecimal() and int(length) > MAX_BYTES:
                raise ValueError("Invalid response")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("Invalid response")
            data = json.loads(body)
            balance = data.get("balance") if isinstance(data, dict) else None
            result["structureOk"] = bool(valid_balance(balance))
            if result["structureOk"]:
                result["balance"] = balance
            result["outcome"] = "ok" if result["structureOk"] else "invalid_data"
    except (socket.timeout, TimeoutError):
        result["outcome"] = "timeout"
    except urllib.error.URLError as error:
        result["outcome"] = "timeout" if isinstance(error.reason, (socket.timeout, TimeoutError)) else "network_error"
    except (ValueError, UnicodeError, RecursionError):
        result["structureOk"] = False
        result["outcome"] = "invalid_data"
    except Exception:
        result["outcome"] = "network_error"
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        result["elapsedMs"] = max(0, round((time.monotonic() - started) * 1000))
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            return 2
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {"vrToken", "operation"}
                or not valid_token(value["vrToken"]) or not isinstance(value["operation"], str)
                or value["operation"] not in TARGETS):
            return 2
        result = probe(value["vrToken"], operation=value["operation"])
        sys.stdout.write(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    sys.exit(main())
