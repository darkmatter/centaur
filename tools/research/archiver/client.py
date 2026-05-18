"""ArchiverClient — pattern wrapper around archiver modules."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from .download.orchestrator import download_source
from .ingest.parse import parse_manifest
from .utils import (
    FileRecord,
    compute_file_hash,
    detect_mime_type,
    dump_json,
    file_record_to_dict,
)


class ArchiverClient:
    """Extraction-first client for investment document parsing."""

    def download(
        self,
        source_url: str,
        output_dir: str,
        company: str | None = None,
        account: str | None = None,
        password: str | None = None,
        email: str | None = None,
        max_depth: int = 3,
    ) -> dict:
        output_dir = Path(output_dir)
        payload = download_source(
            source_url=source_url,
            output_dir=output_dir,
            company=company,
            account=account,
            password=password,
            email=email,
            max_depth=max_depth,
        )
        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(dump_json(payload))
        return {**payload, "manifest_path": str(manifest_path)}

    def _manifest_with_context(
        self, manifest_path: Path, context: dict | None
    ) -> Path:
        if not context:
            return manifest_path
        data = json.loads(manifest_path.read_text())
        existing = data.get("context") or {}
        data["context"] = {**existing, **context}
        tmp = Path(tempfile.mktemp(suffix=".ctx.json", dir=manifest_path.parent))
        tmp.write_text(json.dumps(data))
        return tmp

    def parse(self, manifest_path: str, context: dict | None = None) -> dict:
        path = Path(manifest_path)
        path = self._manifest_with_context(path, context)
        return parse_manifest(path)

    def extract_manifest(self, manifest_path: str, context: dict | None = None) -> dict:
        """Reducto-first extraction from an existing manifest."""
        return self.parse(manifest_path, context=context)

    def _build_manifest_from_local_files(
        self,
        file_paths: list[str],
        context: dict | None = None,
        source_url: str | None = None,
    ) -> Path:
        records: list[dict[str, Any]] = []
        for raw in file_paths:
            path = Path(raw).expanduser()
            if path.exists() and path.is_file():
                resolved = path.resolve()
                record = FileRecord(
                    source_url=source_url or "local://manual",
                    source_type="local",
                    file_path=str(resolved),
                    filename=resolved.name,
                    file_hash=compute_file_hash(resolved),
                    size_bytes=resolved.stat().st_size,
                    mime_type=detect_mime_type(resolved),
                )
                records.append(file_record_to_dict(record))
            else:
                records.append(
                    {
                        "source_url": source_url or "local://manual",
                        "source_type": "local",
                        "file_path": str(path),
                        "filename": path.name,
                        "file_hash": "",
                        "size_bytes": 0,
                        "mime_type": None,
                        "status": "error",
                        "error": "File not found",
                    }
                )

        payload: dict[str, Any] = {
            "status": "ok",
            "source_url": source_url or "local://manual",
            "source_type": "local",
            "files": records,
        }
        if context:
            payload["context"] = context

        manifest_path = Path(tempfile.mktemp(suffix=".manifest.json"))
        manifest_path.write_text(json.dumps(payload))
        return manifest_path

    def extract_files(
        self,
        file_paths: list[str],
        context: dict | None = None,
        source_url: str | None = None,
    ) -> dict:
        """Reducto-first extraction directly from local files."""
        if not file_paths:
            return {"status": "error", "error": "file_paths cannot be empty", "files": []}
        manifest = self._build_manifest_from_local_files(
            file_paths=file_paths,
            context=context,
            source_url=source_url,
        )
        return parse_manifest(manifest)

    def extract_source(
        self,
        source_url: str,
        output_dir: str,
        company: str | None = None,
        account: str | None = None,
        password: str | None = None,
        email: str | None = None,
        max_depth: int = 3,
        context: dict | None = None,
    ) -> dict:
        """Download source and run Reducto extraction in one call."""
        download_payload = self.download(
            source_url=source_url,
            output_dir=output_dir,
            company=company,
            account=account,
            password=password,
            email=email,
            max_depth=max_depth,
        )
        if download_payload.get("status") != "ok":
            return {
                "status": "error",
                "error": download_payload.get("error") or "Download stage failed",
                "source": source_url,
                "manifest_path": download_payload.get("manifest_path"),
                "download": download_payload,
                "files": download_payload.get("files") or [],
            }
        if not download_payload.get("files"):
            return {
                "status": "error",
                "error": "Download stage produced no files",
                "source": source_url,
                "manifest_path": download_payload.get("manifest_path"),
                "download": download_payload,
                "files": [],
            }
        manifest_path = Path(output_dir) / "manifest.json"
        return self.extract_manifest(str(manifest_path), context=context)


def _client() -> ArchiverClient:
    return ArchiverClient()
