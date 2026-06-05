from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))

import client as client_module
from client import SensorTowerClient


def test_auth_token_prefers_sensor_tower_api_token(monkeypatch):
    secrets = {
        "SENSOR_TOWER_API_TOKEN": "api-token",
        "SENSORTOWER_API_KEY": "api-key",
        "SENSOR_TOWER_AUTH_TOKEN": "old-token",
        "SENSORTOWER_AUTH_TOKEN": "older-token",
    }

    monkeypatch.setattr(client_module, "secret", lambda name, default="": secrets.get(name, default))

    assert SensorTowerClient()._get_auth_token() == "api-token"


def test_sales_estimates_uses_canonical_endpoint_and_worldwide_default(monkeypatch):
    client = SensorTowerClient(auth_token="token")
    seen = {}

    def fake_request(endpoint, params=None, **_kwargs):
        seen["endpoint"] = endpoint
        seen["params"] = params
        return {"data": []}

    monkeypatch.setattr(client, "_request", fake_request)

    result = client.get_sales_estimates(
        ["1632713844"],
        platform="ios",
        start_date="2025-11-01",
        end_date="2026-04-30",
        countries=None,
        date_granularity="monthly",
    )

    assert result == {"data": []}
    assert seen == {
        "endpoint": "/v1/ios/sales_report_estimates",
        "params": {
            "app_ids": "1632713844",
            "countries": "WW",
            "date_granularity": "monthly",
            "start_date": "2025-11-01",
            "end_date": "2026-04-30",
        },
    }
