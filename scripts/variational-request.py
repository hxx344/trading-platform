"""Fixed read-only Variational HTTP bridge. Credentials are read only from stdin.

Based on project_aggregation modules/monitor/server/variational-request.py at 8470785. Exit 3 identifies
a socket timeout; all other failures exit 2 without emitting details. Run as `python3 -I -B` by src/monitor/variational-transport.ts.
"""
import base64
import json
import re
import socket
import sys
import urllib.error
import urllib.request

ORIGIN = "https://omni.variational.io"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
PATHS = {
    "/api/me": "GET",
    "/api/quotes/indicative": "POST",
    "/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future": "GET",
    "/api/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future": "GET",
}
MAX_INPUT_BYTES = 32_768
MAX_BODY_BYTES = 2_000_000
RESPONSE_HEADERS = ("content-type", "x-omni-auth", "cf-mitigated")
UNDERLYING = re.compile(r"[A-Z0-9]{1,16}\Z")
QTY = re.compile(r"(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?\Z")
COOKIE = re.compile(r"vr-token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def indicative_instrument(instrument):
    """The only instruments a quote may name, rebuilt field by field: the oil pair, and the three shapes
    the Var/Lighter module quotes (src/monitor/variational-transport.ts checks the same)."""
    if not isinstance(instrument, dict) or instrument.get("settlement_asset") != "USDC":
        raise ValueError()
    underlying = instrument.get("underlying")
    if not isinstance(underlying, str) or UNDERLYING.fullmatch(underlying) is None:
        raise ValueError()
    kind, interval = instrument.get("kind"), instrument.get("funding_interval_s")
    if (instrument.get("instrument_type") == "perpetual_rwa_future" and isinstance(kind, str) and kind in ("commodity", "equity")
            and set(instrument) == {"underlying", "instrument_type", "settlement_asset", "kind"}):
        return {"underlying": underlying, "instrument_type": "perpetual_rwa_future", "settlement_asset": "USDC", "kind": kind}
    if (instrument.get("instrument_type") == "perpetual_future" and type(interval) is int and interval == 3600
            and set(instrument) == {"underlying", "instrument_type", "settlement_asset", "funding_interval_s"}):
        return {"underlying": underlying, "instrument_type": "perpetual_future", "settlement_asset": "USDC", "funding_interval_s": 3600}
    raise ValueError()


def request_definition(value):
    if not isinstance(value, dict) or set(value) != {"url", "method", "headers", "body"}:
        raise ValueError()
    urls = {ORIGIN + path: method for path, method in PATHS.items()}
    if not isinstance(value["url"], str) or value["url"] not in urls:
        raise ValueError()
    method = urls[value["url"]]
    if value["method"] != method or not isinstance(value["headers"], dict):
        raise ValueError()
    headers = value["headers"]
    expected = {"Accept": "application/json", "User-Agent": USER_AGENT,
                "Cache-Control": "no-cache", "Referer": ORIGIN + "/"}
    if method == "POST":
        expected["Content-Type"] = "application/json"
    authenticated = value["url"] in {ORIGIN + "/api/me", ORIGIN + "/api/quotes/indicative"}
    if "Cookie" in headers:
        cookie = headers["Cookie"]
        if not authenticated or not isinstance(cookie, str) or len(cookie) > 8201 or COOKIE.fullmatch(cookie) is None:
            raise ValueError()
        expected["Cookie"] = cookie
    elif authenticated:
        raise ValueError()
    if headers != expected:
        raise ValueError()
    body = None
    if method == "POST":
        submitted = value["body"]
        if not isinstance(submitted, dict) or set(submitted) != {"instrument", "qty"}:
            raise ValueError()
        fixed = indicative_instrument(submitted["instrument"])
        qty = submitted["qty"]
        if not isinstance(qty, str) or QTY.fullmatch(qty) is None or re.search(r"[1-9]", qty) is None:
            raise ValueError()
        body = json.dumps({"instrument": fixed, "qty": qty}, separators=(",", ":")).encode("utf-8")
    elif value["body"] is not None:
        raise ValueError()
    return urllib.request.Request(value["url"], data=body, headers=expected, method=method)


def fetch_response(value):
    request = request_definition(value)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=8)
    except urllib.error.HTTPError as error:
        # Preserve status and selected headers for auth/challenge classification.
        # NoRedirect turns redirects into HTTPError; nothing follows Location.
        response = error
    with response:
        status = response.status
        if type(status) is not int or not 200 <= status <= 599:
            raise ValueError()
        body = response.read(MAX_BODY_BYTES + 1)
        if len(body) > MAX_BODY_BYTES:
            raise ValueError()
        headers = {}
        for name in RESPONSE_HEADERS:
            item = response.headers.get(name)
            if item is not None:
                if not isinstance(item, str) or len(item) > 1024 or any(ord(char) < 32 or ord(char) > 126 for char in item):
                    raise ValueError()
                headers[name] = item
        return {"status": status, "headers": headers, "body": base64.b64encode(body).decode("ascii")}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=unique_object)
        result = fetch_response(value)
        sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 0
    except (TimeoutError, socket.timeout):
        return 3
    except urllib.error.URLError as error:
        # urllib wraps connection timeouts in URLError, while reading a body can raise the socket timeout directly.
        return 3 if isinstance(error.reason, (TimeoutError, socket.timeout)) else 2
    except Exception:
        # Never print input, URLs, request headers, response bodies, or tracebacks.
        return 2


if __name__ == "__main__":
    sys.exit(main())
