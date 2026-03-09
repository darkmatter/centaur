"""VictoriaLogs HTTP API client for LogsQL queries, field names, and field values."""

import json
from typing import Any

import httpx

from shared.tool_sdk import secret


class VictoriaLogsClient:
    """Client for the VictoriaLogs HTTP API.

    Queries logs via LogsQL, lists field names/values, and retrieves log streams.
    Connects directly to the VictoriaLogs instance (default: http://victorialogs:9428).
    """

    def __init__(self, url: str | None = None, timeout: float = 30.0):
        self._url = url
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def base_url(self) -> str:
        url = (self._url or secret("VICTORIALOGS_URL", "http://victorialogs:9428")).rstrip("/")
        if url and not url.startswith(("http://", "https://")):
            url = f"http://{url}"
        return url

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(base_url=self.base_url, timeout=self.timeout)
        return self._client

    def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        data: dict | None = None,
    ) -> httpx.Response:
        resp = self.client.request(method, path, params=params, data=data)
        if resp.status_code >= 400:
            raise RuntimeError(f"VictoriaLogs API error ({resp.status_code}): {resp.text}")
        return resp

    # -- Queries ---------------------------------------------------------------

    def query(
        self,
        query: str,
        limit: int = 100,
        start: str | None = None,
        end: str | None = None,
    ) -> list[dict]:
        """Run a LogsQL query and return matching log entries.

        Args:
            query: LogsQL expression (e.g. '_time:5m error').
            limit: Max log lines to return.
            start: Range start (RFC3339 or Unix timestamp).
            end: Range end. Defaults to now.
        """
        data: dict[str, Any] = {"query": f"{query} | limit {limit}"}
        if start:
            data["start"] = start
        if end:
            data["end"] = end
        resp = self._request("POST", "/select/logsql/query", data=data)
        lines = []
        for line in resp.text.strip().split("\n"):
            if line:
                lines.append(json.loads(line))
        return lines

    def hits(
        self,
        query: str,
        start: str | None = None,
        end: str | None = None,
        step: str | None = None,
    ) -> dict:
        """Query log hits stats over a time range.

        Args:
            query: LogsQL expression.
            start: Range start.
            end: Range end.
            step: Step between data points (e.g. '5m').
        """
        data: dict[str, Any] = {"query": query}
        if start:
            data["start"] = start
        if end:
            data["end"] = end
        if step:
            data["step"] = step
        resp = self._request("POST", "/select/logsql/hits", data=data)
        return resp.json()

    def field_names(
        self, query: str = "*", start: str | None = None, end: str | None = None
    ) -> list[str]:
        """List all known field names.

        Args:
            query: Optional LogsQL filter to scope field names.
            start: Optional start time filter.
            end: Optional end time filter.
        """
        data: dict[str, str] = {"query": query}
        if start:
            data["start"] = start
        if end:
            data["end"] = end
        resp = self._request("POST", "/select/logsql/field_names", data=data)
        result = resp.json()
        return [v["value"] for v in result.get("values", [])]

    def field_values(
        self,
        field: str,
        query: str = "*",
        limit: int = 100,
        start: str | None = None,
        end: str | None = None,
    ) -> list[str]:
        """Get all values for a specific field.

        Args:
            field: Field name (e.g. 'service', 'container').
            query: Optional LogsQL filter to scope values.
            limit: Max values to return.
            start: Optional start time filter.
            end: Optional end time filter.
        """
        data: dict[str, Any] = {"query": query, "field": field, "limit": limit}
        if start:
            data["start"] = start
        if end:
            data["end"] = end
        resp = self._request("POST", "/select/logsql/field_values", data=data)
        result = resp.json()
        return [v["value"] for v in result.get("values", [])]

    def streams(
        self,
        query: str = "*",
        start: str | None = None,
        end: str | None = None,
    ) -> list[dict]:
        """Find log streams matching a query.

        Args:
            query: LogsQL expression.
            start: Optional start time filter.
            end: Optional end time filter.
        """
        data: dict[str, str] = {"query": query}
        if start:
            data["start"] = start
        if end:
            data["end"] = end
        resp = self._request("POST", "/select/logsql/streams", data=data)
        result = resp.json()
        return result.get("values", [])

    def ready(self) -> bool:
        """Check if VictoriaLogs is ready to serve requests."""
        try:
            resp = self.client.get("/health")
            return resp.status_code == 200
        except Exception:
            return False

    # -- Lifecycle -------------------------------------------------------------

    def close(self):
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> VictoriaLogsClient:
    return VictoriaLogsClient()
