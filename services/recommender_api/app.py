# services/recommender_api/app.py
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from typing import Dict, Any
import os

from .inference import Recommender, FeatureIn

app = FastAPI(title="MIDAS Recommender API", version="v1")

MODEL_PATH = os.getenv("MODEL_PATH", "services/recommender_api/model.joblib")

@app.get("/healthz")
def healthz():
    return {"status": "ok", "model_path": MODEL_PATH}

@app.on_event("startup")
def _load_model():
    global model
    if not os.path.exists(MODEL_PATH):
        raise RuntimeError(f"Model bundle not found at {MODEL_PATH}")
    model = Recommender(MODEL_PATH)

@app.post("/api/recommend")
def recommend(features: FeatureIn) -> Dict[str, Any]:
    """Run model inference for the given features."""
    try:
        result = model.predict(features)
        if not isinstance(result, dict) or "class" not in result:
            raise ValueError("Model.predict() did not return expected dict")
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/explain")
def explain(features: FeatureIn) -> Dict[str, Any]:
    """Return explainability metadata: inputs, top global feature importances, and prediction."""
    try:
        pred = model.predict(features)

        importances = getattr(model.tree, "feature_importances_", None)
        top = []
        if importances is not None:
            pairs = list(zip(model.order, [float(x) for x in importances]))
            pairs.sort(key=lambda x: x[1], reverse=True)
            top = [{"feature": k, "importance": v} for k, v in pairs if v > 0.0][:6]

        inputs = {k: getattr(features, k) for k in model.order}

        return {
            "version": model.version,
            "prediction": pred,
            "inputs": inputs,
            "top_importances": top,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))