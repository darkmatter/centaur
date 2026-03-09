"""Grafana HTTP API client for dashboards, datasource queries, alerts, and annotations."""

import json as _json
import os
from typing import Any

import httpx

from shared.tool_sdk import secret


class GrafanaClient:
    """Client for the Grafana HTTP API.

    Supports dashboard search, Prometheus/VictoriaLogs datasource proxy queries,
    alert rules, and annotations. Authenticates via service-account token
    (GRAFANA_API_KEY) or basic auth (GRAFANA_USER / GRAFANA_PASSWORD).
    """

    def __init__(
        self,
        url: str | None = None,
        api_key: str | None = None,
        username: str | None = None,
        password: str | None = None,
        timeout: float = 30.0,
    ):
        self._url = url
        self._api_key = api_key
        self._username = username
        self._password = password
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def base_url(self) -> str:
        url = (self._url or secret("GRAFANA_URL", "")).rstrip("/")
        if url and not url.startswith(("http://", "https://")):
            url = f"http://{url}"
        return url

    def _auth_headers(self) -> dict[str, str]:
        key = self._api_key or secret("GRAFANA_API_KEY", "")
        if key:
            return {"Authorization": f"Bearer {key}"}
        user = self._username or os.getenv("GRAFANA_USER", "admin")  # noqa: TID251
        pw = self._password or secret("GRAFANA_PASSWORD", "")
        if pw:
            import base64

            cred = base64.b64encode(f"{user}:{pw}".encode()).decode()
            return {"Authorization": f"Basic {cred}"}
        return {}

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=self.base_url,
                headers=self._auth_headers(),
                timeout=self.timeout,
            )
        return self._client

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        json_data: dict | None = None,
    ) -> Any:
        resp = self.client.request(method, path, params=params, json=json_data)
        if resp.status_code >= 400:
            raise RuntimeError(f"Grafana API error ({resp.status_code}): {resp.text}")
        return resp.json()

    def _raw_request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        data: dict | None = None,
    ) -> httpx.Response:
        """Like _request but returns the raw httpx.Response (for non-JSON APIs)."""
        resp = self.client.request(method, path, params=params, data=data)
        if resp.status_code >= 400:
            raise RuntimeError(f"Grafana API error ({resp.status_code}): {resp.text}")
        return resp

    # -- Dashboards ----------------------------------------------------------

    def search_dashboards(
        self,
        query: str | None = None,
        tag: str | None = None,
        type: str = "dash-db",
        limit: int = 50,
    ) -> list[dict]:
        """Search dashboards and folders.

        Args:
            query: Optional search string.
            tag: Filter by dashboard tag.
            type: 'dash-db' for dashboards, 'dash-folder' for folders.
            limit: Max results.
        """
        params: dict[str, Any] = {"type": type, "limit": limit}
        if query:
            params["query"] = query
        if tag:
            params["tag"] = tag
        return self._request("GET", "/api/search", params=params)

    def get_dashboard(self, uid: str) -> dict:
        """Get a dashboard by UID. Returns full dashboard JSON + meta."""
        return self._request("GET", f"/api/dashboards/uid/{uid}")

    # -- Datasources ---------------------------------------------------------

    def list_datasources(self) -> list[dict]:
        """List all configured datasources."""
        return self._request("GET", "/api/datasources")

    # -- Prometheus queries via datasource proxy ------------------------------

    def query_prometheus(
        self,
        expr: str,
        datasource_uid: str = "prometheus",
        start: str | None = None,
        end: str | None = None,
        step: str = "60s",
    ) -> dict:
        """Run a PromQL instant or range query via the datasource proxy.

        Args:
            expr: PromQL expression.
            datasource_uid: Datasource UID (default: 'prometheus').
            start: Range query start (RFC3339 or Unix epoch). Omit for instant query.
            end: Range query end. Defaults to 'now' for range queries.
            step: Range query step (e.g. '60s', '5m').
        """
        if start:
            params: dict[str, str] = {"query": expr, "start": start, "step": step}
            if end:
                params["end"] = end
            return self._request(
                "GET",
                f"/api/datasources/proxy/uid/{datasource_uid}/api/v1/query_range",
                params=params,
            )
        return self._request(
            "GET",
            f"/api/datasources/proxy/uid/{datasource_uid}/api/v1/query",
            params={"query": expr},
        )

    def prometheus_labels(self, datasource_uid: str = "prometheus") -> list[str]:
        """List all Prometheus label names."""
        data = self._request(
            "GET",
            f"/api/datasources/proxy/uid/{datasource_uid}/api/v1/labels",
        )
        return data.get("data", [])

    def prometheus_label_values(
        self, label: str, datasource_uid: str = "prometheus"
    ) -> list[str]:
        """Get values for a Prometheus label."""
        data = self._request(
            "GET",
            f"/api/datasources/proxy/uid/{datasource_uid}/api/v1/label/{label}/values",
        )
        return data.get("data", [])

    # -- VictoriaLogs queries via datasource proxy ----------------------------

    def query_victorialogs(
        self,
        query: str,
        datasource_uid: str = "victorialogs",
        start: str | None = None,
        end: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Run a LogsQL query via the VictoriaLogs datasource proxy.

        Args:
            query: LogsQL expression (e.g. '_time:5m error').
            datasource_uid: Datasource UID (default: 'victorialogs').
            start: Range start (RFC3339 or Unix nanoseconds). Omit for last 1h.
            end: Range end.
            limit: Max log lines.
        """
        params: dict[str, Any] = {"query": f"{query} | limit {limit}"}
        if start:
            params["start"] = start
        if end:
            params["end"] = end
        resp = self._raw_request(
            "POST",
            f"/api/datasources/proxy/uid/{datasource_uid}/select/logsql/query",
            data=params,
        )
        lines = []
        for line in resp.text.strip().split("\n"):
            if line:
                lines.append(_json.loads(line))
        return lines

    def victorialogs_field_names(self, datasource_uid: str = "victorialogs") -> list[str]:
        """List all VictoriaLogs field names."""
        resp = self._raw_request(
            "POST",
            f"/api/datasources/proxy/uid/{datasource_uid}/select/logsql/field_names",
            data={"query": "*"},
        )
        result = resp.json()
        return [v["value"] for v in result.get("values", [])]

    def victorialogs_field_values(
        self, field: str, datasource_uid: str = "victorialogs"
    ) -> list[str]:
        """Get values for a VictoriaLogs field."""
        resp = self._raw_request(
            "POST",
            f"/api/datasources/proxy/uid/{datasource_uid}/select/logsql/field_values",
            data={"query": "*", "field": field},
        )
        result = resp.json()
        return [v["value"] for v in result.get("values", [])]

    # -- Alerts --------------------------------------------------------------

    def get_alerts(self) -> list[dict]:
        """Get Prometheus-style active alerts."""
        data = self._request("GET", "/api/prometheus/grafana/api/v1/alerts")
        return data.get("data", {}).get("alerts", [])

    def get_alert_rules(self) -> dict:
        """Get all alert rule groups."""
        data = self._request("GET", "/api/prometheus/grafana/api/v1/rules")
        return data.get("data", {})

    # -- Annotations ----------------------------------------------------------

    def list_annotations(
        self,
        dashboard_uid: str | None = None,
        from_ts: int | None = None,
        to_ts: int | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """List annotations, optionally filtered by dashboard or time range.

        Args:
            dashboard_uid: Filter by dashboard UID.
            from_ts: Start time (epoch ms).
            to_ts: End time (epoch ms).
            limit: Max results.
        """
        params: dict[str, Any] = {"limit": limit}
        if dashboard_uid:
            params["dashboardUID"] = dashboard_uid
        if from_ts:
            params["from"] = from_ts
        if to_ts:
            params["to"] = to_ts
        return self._request("GET", "/api/annotations", params=params)

    # -- Health ---------------------------------------------------------------

    def health(self) -> dict:
        """Check Grafana health."""
        return self._request("GET", "/api/health")

    # -- Lifecycle ------------------------------------------------------------

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> GrafanaClient:
    return GrafanaClient()
