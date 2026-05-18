"""Unit tests for URL interception in the agent router."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from api.routers.agent import _DOCSEND_RE, _GDOC_RE, _GDRIVE_RE, _GDRIVE_FOLDER_RE


# ---------------------------------------------------------------------------
# Regex pattern tests
# ---------------------------------------------------------------------------


class TestDocsendRegex:
    def test_basic_url(self):
        m = _DOCSEND_RE.search("Check this out https://docsend.com/view/abc123")
        assert m
        assert m.group(1) == "abc123"

    def test_www_prefix(self):
        m = _DOCSEND_RE.search("https://www.docsend.com/view/xyz789")
        assert m
        assert m.group(1) == "xyz789"

    def test_http(self):
        m = _DOCSEND_RE.search("http://docsend.com/view/test456")
        assert m
        assert m.group(1) == "test456"

    def test_custom_subdomain(self):
        m = _DOCSEND_RE.search("https://morpho.docsend.com/view/nme3zyb6sukunvy5")
        assert m
        assert m.group(1) == "nme3zyb6sukunvy5"

    def test_hyphenated_subdomain(self):
        m = _DOCSEND_RE.search("https://anchorage-digital.docsend.com/view/test123")
        assert m
        assert m.group(1) == "test123"

    def test_no_match(self):
        assert _DOCSEND_RE.search("https://docsend.com/about") is None

    def test_multiple_urls(self):
        text = "See https://docsend.com/view/aaa and https://docsend.com/view/bbb"
        matches = _DOCSEND_RE.findall(text)
        assert matches == ["aaa", "bbb"]


class TestGdocRegex:
    def test_document(self):
        m = _GDOC_RE.search("https://docs.google.com/document/d/1aBcDeF_gH/edit")
        assert m
        assert m.group(1) == "document"
        assert m.group(2) == "1aBcDeF_gH"

    def test_spreadsheet(self):
        m = _GDOC_RE.search("https://docs.google.com/spreadsheets/d/abc-123_XY/edit#gid=0")
        assert m
        assert m.group(1) == "spreadsheets"
        assert m.group(2) == "abc-123_XY"

    def test_presentation(self):
        m = _GDOC_RE.search("https://docs.google.com/presentation/d/pres123/edit")
        assert m
        assert m.group(1) == "presentation"
        assert m.group(2) == "pres123"

    def test_no_match_forms(self):
        assert _GDOC_RE.search("https://docs.google.com/forms/d/xyz") is None


class TestGdriveRegex:
    def test_file_url(self):
        m = _GDRIVE_RE.search("https://drive.google.com/file/d/abc123XYZ/view")
        assert m
        assert m.group(1) == "abc123XYZ"

    def test_no_match_folder(self):
        assert _GDRIVE_RE.search("https://drive.google.com/drive/folders/abc") is None


# ---------------------------------------------------------------------------
# _resolve_urls integration (mocked DB + tool manager)
# ---------------------------------------------------------------------------


class FakePool:
    """Minimal asyncpg pool mock that records INSERT calls."""

    def __init__(self):
        self.inserts: list[tuple] = []

    async def execute(self, sql, *args):
        self.inserts.append((sql, args))


class FakeRequest:
    """Minimal request mock."""
    pass


@pytest.mark.asyncio
async def test_resolve_urls_no_urls():
    """Parts without URLs pass through unchanged."""
    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "Hello, world!"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())
    assert result is parts  # exact same object — no URLs found
    assert len(pool.inserts) == 0


def _patch_get_tool_manager(monkeypatch, fake_tm):
    """Patch the deferred `from api.app import get_tool_manager` inside _resolve_urls.

    api.app triggers Settings validation at import time, so we inject a fake
    module into sys.modules instead.
    """
    import types

    fake_app = types.ModuleType("api.app")
    fake_app.get_tool_manager = lambda: fake_tm  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "api.app", fake_app)


@pytest.mark.asyncio
async def test_resolve_urls_docsend_failure_logged(monkeypatch):
    """DocSend download failure doesn't crash — just logs and skips."""

    class FakeTM:
        async def call_tool_raw(self, tool, method, args):
            return {"status": "error", "error": "not found", "data": None}

    _patch_get_tool_manager(monkeypatch, FakeTM())

    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "Check https://docsend.com/view/abc123"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())
    # Original parts preserved, no attachment_ref added (download failed)
    assert len(result) == 1
    assert result[0]["type"] == "text"
    assert len(pool.inserts) == 0


@pytest.mark.asyncio
async def test_resolve_urls_docsend_success(monkeypatch):
    """Successful DocSend download creates attachment and appends ref."""
    import base64

    fake_pdf = b"%PDF-1.4 fake content"

    class FakeTM:
        async def call_tool_raw(self, tool, method, args):
            assert tool == "docsend"
            assert method == "download"
            return {
                "status": "ok",
                "filename": "docsend_abc123.pdf",
                "data": base64.b64encode(fake_pdf).decode(),
                "mime_type": "application/pdf",
            }

    _patch_get_tool_manager(monkeypatch, FakeTM())

    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "See https://docsend.com/view/abc123"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())

    assert len(result) == 2
    assert result[0]["type"] == "text"
    ref = result[1]
    assert ref["type"] == "attachment_ref"
    assert ref["name"] == "docsend_abc123.pdf"
    assert ref["mime_type"] == "application/pdf"
    assert ref["source_url"] == "https://docsend.com/view/abc123"
    # Verify DB insert happened
    assert len(pool.inserts) == 1
    sql, args = pool.inserts[0]
    assert "INSERT INTO attachments" in sql
    assert args[4] == "application/pdf"
    assert args[5] == fake_pdf  # raw bytes stored


@pytest.mark.asyncio
async def test_resolve_urls_gdoc_via_gsuite(monkeypatch, tmp_path):
    """Google Doc URL resolved via gsuite drive_export tool."""
    fake_pdf = b"%PDF-1.4 exported doc"
    tmp_file = tmp_path / "exported.pdf"
    tmp_file.write_bytes(fake_pdf)

    class FakeTM:
        async def call_tool_raw(self, tool, method, args):
            assert tool == "gsuite"
            assert method == "drive_export"
            assert args["file_id"] == "abc123XYZ"
            assert args["export_format"] == "pdf"
            return str(tmp_file)

    _patch_get_tool_manager(monkeypatch, FakeTM())

    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "See https://docs.google.com/document/d/abc123XYZ/edit"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())

    assert len(result) == 2
    ref = result[1]
    assert ref["type"] == "attachment_ref"
    assert ref["name"] == "gdoc_abc123XYZ.pdf"
    assert ref["mime_type"] == "application/pdf"
    assert ref["source_url"] == "https://docs.google.com/document/d/abc123XYZ"
    assert len(pool.inserts) == 1
    assert pool.inserts[0][1][5] == fake_pdf


@pytest.mark.asyncio
async def test_resolve_urls_gdrive_via_gsuite(monkeypatch, tmp_path):
    """Google Drive file URL resolved via gsuite drive_get + drive_download."""
    fake_content = b"spreadsheet data"
    tmp_file = tmp_path / "downloaded.xlsx"
    tmp_file.write_bytes(fake_content)

    class FakeTM:
        async def call_tool_raw(self, tool, method, args):
            assert tool == "gsuite"
            if method == "drive_get":
                return {"name": "Q1 Report.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
            if method == "drive_download":
                # Simulate writing to the requested output_path
                import shutil
                shutil.copy(tmp_file, args["output_path"])
                return args["output_path"]
            raise AssertionError(f"unexpected method {method}")

    _patch_get_tool_manager(monkeypatch, FakeTM())

    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "See https://drive.google.com/file/d/fileXYZ123/view"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())

    assert len(result) == 2
    ref = result[1]
    assert ref["type"] == "attachment_ref"
    assert ref["name"] == "Q1 Report.xlsx"
    assert ref["mime_type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert len(pool.inserts) == 1
    assert pool.inserts[0][1][5] == fake_content


@pytest.mark.asyncio
async def test_resolve_urls_gsuite_error_skips(monkeypatch):
    """gsuite tool returning an error dict skips gracefully."""

    class FakeTM:
        async def call_tool_raw(self, tool, method, args):
            return {"error": "credentials not configured"}

    _patch_get_tool_manager(monkeypatch, FakeTM())

    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "See https://docs.google.com/document/d/abc/edit"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())
    assert len(result) == 1
    assert len(pool.inserts) == 0


# ---------------------------------------------------------------------------
# GDrive folder regex tests
# ---------------------------------------------------------------------------


class TestGdriveFolderRegex:
    def test_basic_folder_url(self):
        m = _GDRIVE_FOLDER_RE.search("https://drive.google.com/drive/folders/abc123XYZ")
        assert m
        assert m.group(1) == "abc123XYZ"

    def test_with_user_prefix(self):
        m = _GDRIVE_FOLDER_RE.search("https://drive.google.com/drive/u/0/folders/def456")
        assert m
        assert m.group(1) == "def456"

    def test_no_match_file_url(self):
        assert _GDRIVE_FOLDER_RE.search("https://drive.google.com/file/d/abc") is None


# ---------------------------------------------------------------------------
# DocSend /view/s/ variant
# ---------------------------------------------------------------------------


class TestDocsendViewSVariant:
    def test_view_s_variant(self):
        m = _DOCSEND_RE.search("https://docsend.com/view/s/abc123")
        assert m
        assert m.group(1) == "abc123"


# ---------------------------------------------------------------------------
# GDrive folder _resolve_urls integration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_urls_gdrive_folder(monkeypatch, tmp_path):
    """GDrive folder URL resolves each file in the folder listing."""
    fake_doc_pdf = b"%PDF-1.4 exported google doc"
    fake_binary_pdf = b"%PDF-1.4 binary uploaded pdf"

    doc_tmp = tmp_path / "exported_doc.pdf"
    doc_tmp.write_bytes(fake_doc_pdf)

    bin_tmp = tmp_path / "downloaded_binary.pdf"
    bin_tmp.write_bytes(fake_binary_pdf)

    class FakeTM:
        async def call_tool_raw(self, tool, method, args):
            assert tool == "gsuite"
            if method == "drive_list":
                assert args["folder_id"] == "folderABC"
                return [
                    {
                        "id": "doc1",
                        "name": "Meeting Notes",
                        "mime_type": "application/vnd.google-apps.document",
                    },
                    {
                        "id": "file2",
                        "name": "report.pdf",
                        "mime_type": "application/pdf",
                    },
                ]
            if method == "drive_export":
                assert args["file_id"] == "doc1"
                return str(doc_tmp)
            if method == "drive_download":
                assert args["file_id"] == "file2"
                import shutil

                shutil.copy(bin_tmp, args["output_path"])
                return args["output_path"]
            raise AssertionError(f"unexpected method {method}")

    _patch_get_tool_manager(monkeypatch, FakeTM())

    from api.routers.agent import _resolve_urls

    pool = FakePool()
    parts = [{"type": "text", "text": "See https://drive.google.com/drive/folders/folderABC"}]
    result = await _resolve_urls(pool, "t:1", "m:1", parts, FakeRequest())

    # 1 original text + 2 attachment_refs (one per file)
    assert len(result) == 3
    assert result[0]["type"] == "text"
    assert result[1]["type"] == "attachment_ref"
    assert result[1]["name"] == "Meeting Notes.pdf"
    assert result[1]["mime_type"] == "application/pdf"
    assert result[2]["type"] == "attachment_ref"
    assert result[2]["name"] == "report.pdf"
    assert result[2]["mime_type"] == "application/pdf"
    # 2 DB inserts (one per file)
    assert len(pool.inserts) == 2
