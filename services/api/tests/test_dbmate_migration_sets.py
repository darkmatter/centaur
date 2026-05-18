from __future__ import annotations

from types import SimpleNamespace


def test_get_migration_sets_includes_overlay(tmp_path, monkeypatch) -> None:
    import api.db as db

    base_dir = tmp_path / "base" / "db" / "migrations"
    overlay_root = tmp_path / "overlay"
    overlay_dir = overlay_root / "services" / "api" / "db" / "migrations"
    base_dir.mkdir(parents=True)
    overlay_dir.mkdir(parents=True)

    monkeypatch.setattr(db, "BASE_MIGRATIONS_DIR", base_dir)
    monkeypatch.setenv("CENTAUR_OVERLAY_DIR", str(overlay_root))

    migration_sets = db.get_migration_sets()

    assert [(item.name, item.migrations_table, item.migrations_dir) for item in migration_sets] == [
        ("core", db.BASE_MIGRATIONS_TABLE, base_dir),
        ("overlay", db.OVERLAY_MIGRATIONS_TABLE, overlay_dir),
    ]


def test_run_migrations_applies_each_migration_set(tmp_path, monkeypatch) -> None:
    import api.db as db

    base_dir = tmp_path / "base" / "db" / "migrations"
    overlay_root = tmp_path / "overlay"
    overlay_dir = overlay_root / "services" / "api" / "db" / "migrations"
    base_dir.mkdir(parents=True)
    overlay_dir.mkdir(parents=True)

    monkeypatch.setattr(db, "BASE_MIGRATIONS_DIR", base_dir)
    monkeypatch.setenv("CENTAUR_OVERLAY_DIR", str(overlay_root))

    calls: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> SimpleNamespace:
        calls.append(command)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(db.subprocess, "run", fake_run)

    db.run_migrations("postgresql://tempo:tempo_dev@postgres:5432/centaur")

    assert len(calls) == 2
    assert calls[0] == [
        "dbmate",
        "--url",
        "postgresql://tempo:tempo_dev@postgres:5432/centaur?sslmode=disable",
        "--migrations-dir",
        str(base_dir),
        "--migrations-table",
        db.BASE_MIGRATIONS_TABLE,
        "--no-dump-schema",
        "up",
    ]
    assert calls[1] == [
        "dbmate",
        "--url",
        "postgresql://tempo:tempo_dev@postgres:5432/centaur?sslmode=disable",
        "--migrations-dir",
        str(overlay_dir),
        "--migrations-table",
        db.OVERLAY_MIGRATIONS_TABLE,
        "--no-dump-schema",
        "up",
    ]
