from __future__ import annotations
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from .features import build_features_stub, build_features_for

app = FastAPI(title="MIDAS Context API", version="v1")

def ts_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

@app.get("/healthz")
def healthz():
    return {"status":"ok","service":"context","version":"v1"}

@app.get("/api/features")
def features_stub(ticker: str):
    return {"features": build_features_stub(), "ticker": ticker, "ts": ts_utc_now()}

@app.get("/api/features/v2")
def features_v2(ticker: str):
    try:
        payload = build_features_for(ticker)
        payload["ticker"] = ticker
        payload["ts"] = ts_utc_now()
        return payload
    except Exception as e:
        # degrade gracefully
        return {"features": build_features_stub(), "ticker": ticker, "ts": ts_utc_now(), "error": str(e)}

# ------- One-liner builder -------

class OneLinerIn(BaseModel):
    class_: str
    confidence: float
    title: str = ""
    publisher: str = ""
    url: str = ""
    refs: Optional[List[Optional[Dict[str, str]]]] = None  # up to 3 refs; may include None

def _strategy_phrase(cls: str) -> str:
    m = {
        "IRON_CONDOR": "Range-bound, IV watch",
        "DEBIT_CALL": "Bullish, defined risk",
        "DEBIT_PUT": "Bearish, defined risk",
        "COVERED_CALL": "Income; upside capped",
        "NO_ACTION": "Signal unclear",
    }
    return m.get(cls, "Review setup")

def _build_index_suffix(refs: Optional[List[Optional[Dict[str,str]]]]) -> tuple[str, List[Dict[str, Any]]]:
    """Return text like '([1][2][3])' and an array mapping of numbers to urls."""
    if not refs:
        return "", []
    nums = []
    shown = []
    n = 1
    for slot in refs[:3]:
        if slot and slot.get("url"):
            nums.append(f"[{n}]")
            shown.append({"n": n, "url": slot.get("url")})
            n += 1
    if not nums:
        return "", []
    return f" ({''.join(nums)})", shown

@app.post("/api/one_liner")
def one_liner(x: OneLinerIn):
    # prefix: strategy + confidence
    conf_pct = int(round((x.confidence or 0.0) * 100))
    phrase = _strategy_phrase(x.class_)
    base = f"{phrase}. Source: {(x.publisher or 'News')} —".strip()

    # indices
    suffix, refs_numbers = _build_index_suffix(x.refs)

    # Compose and clamp to 180 chars
    text = f"{base}{suffix}"
    if len(text) > 180:
        text = (text[:177] + "…")

    return {"text": text, "refs_numbers": refs_numbers}
