from __future__ import annotations
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, HTTPException, Query
import os, httpx, time
from datetime import datetime, timezone

CTX_URL = os.getenv("CTX_URL", "http://127.0.0.1:8012")
REC_URL = os.getenv("REC_URL", "http://127.0.0.1:8014")

TIMEOUT = float(os.getenv("GATEWAY_TIMEOUT_S", "8"))
RETRIES = int(os.getenv("GATEWAY_RETRIES", "2"))
DELAY   = float(os.getenv("GATEWAY_RETRY_DELAY_S", "0.25"))

app = FastAPI(title="MIDAS Gateway API", version="v1")

def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z")

def _parse_iso(s: str) -> Optional[datetime]:
    if not s: return None
    try: return datetime.fromisoformat(s.replace("Z","+00:00")).astimezone(timezone.utc)
    except Exception: return None

def _get_json(url: str, params: dict | None = None) -> dict:
    last_exc: Optional[Exception] = None
    with httpx.Client(timeout=TIMEOUT, trust_env=False) as client:
        for _ in range(RETRIES + 1):
            try:
                r = client.get(url, params=params)
                r.raise_for_status()
                return r.json()
            except Exception as e:
                last_exc = e
                time.sleep(DELAY)
    raise HTTPException(status_code=502, detail=f"GET {url} failed: {last_exc}")

def _post_json(url: str, payload: dict) -> dict:
    last_exc: Optional[Exception] = None
    with httpx.Client(timeout=TIMEOUT, trust_env=False) as client:
        for _ in range(RETRIES + 1):
            try:
                r = client.post(url, json=payload)
                r.raise_for_status()
                return r.json()
            except Exception as e:
                last_exc = e
                time.sleep(DELAY)
    raise HTTPException(status_code=502, detail=f"POST {url} failed: {last_exc}")

@app.get("/healthz")
def healthz():
    return {"status":"ok","service":"gateway","version":"v1","ts":iso_now(),"CTX_URL":CTX_URL,"REC_URL":REC_URL}

@app.get("/api/run")
def run(t: str = Query(..., alias="ticker")) -> Dict[str, Any]:
    # 1) features from context
    ctx = _get_json(f"{CTX_URL}/api/features/v2", params={"ticker": t})
    features: Dict[str, Any] = ctx.get("features", {}) or {}
    top_headline: Optional[Dict[str, str]] = ctx.get("top_headline")
    feature_note = ctx.get("error")
    quote: Dict[str, float | None] = ctx.get("quote") or {"last": 0.0, "bid": None, "ask": None}
    ts_ctx = ctx.get("ts")
    refs: List[Optional[Dict[str,str]]] = ctx.get("refs") or []
    refs_sources: List[str] = ctx.get("refs_sources") or []

    # 2) recommendation (top-level fields)
    rec = _post_json(f"{REC_URL}/api/recommend", features)

    # 3) one-liner build (pass refs for ([1][2][3]))
    headline = top_headline or {"title": "", "publisher": "", "url": ""}
    try:
        one = _post_json(f"{CTX_URL}/api/one_liner", {
            "class_":     rec.get("class", "NO_ACTION"),
            "confidence": rec.get("confidence", 0.0),
            "title":      headline.get("title", ""),
            "publisher":  headline.get("publisher", ""),
            "url":        headline.get("url", ""),
            "refs":       refs,   # list of {title,publisher,url} or None slots
        })
    except HTTPException:
        one = {"text": f"{rec.get('class','NO_ACTION')} · {int(rec.get('confidence',0)*100)}% confidence"}

    # 4) compute age
    now = datetime.now(timezone.utc)
    tctx = _parse_iso(ts_ctx) if isinstance(ts_ctx, str) else None
    age_s = int((now - tctx).total_seconds()) if tctx else None

    resp = {
        "ticker": t,
        "features": features,
        "recommendation": rec,
        "one_liner": one,                 # includes refs_numbers for HUD links
        "quote": quote,
        "top_headline": top_headline,
        "refs": refs,
        "refs_sources": refs_sources,
        "ts_ctx": ts_ctx,
        "ts_gateway": iso_now(),
        "cache_age_seconds": age_s,
    }
    if feature_note:
        resp["features_note"] = feature_note
    return resp