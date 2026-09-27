"""Genie version resolution: build stamp file, then git describe, then fallback."""

import subprocess

from nurse_scheduling import version
from nurse_scheduling.server import app as app_module


def test_generated_stamp_wins(tmp_path, monkeypatch):
    stamp = tmp_path / ".app-version"
    stamp.write_text("v9.9.9-stamp\n", encoding="utf-8")
    monkeypatch.setattr(version, "APP_VERSION_FILE", stamp)
    assert version.get_app_version() == "v9.9.9-stamp"


def test_blank_stamp_falls_back_to_git(tmp_path, monkeypatch):
    stamp = tmp_path / ".app-version"
    stamp.write_text("  \n", encoding="utf-8")
    monkeypatch.setattr(version, "APP_VERSION_FILE", stamp)
    monkeypatch.setattr(version.subprocess, "check_output", lambda *a, **k: "v1.2.3-4-gabc\n")
    assert version.get_app_version() == "v1.2.3-4-gabc"


def test_missing_stamp_and_git_fall_back_to_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(version, "APP_VERSION_FILE", tmp_path / "absent")

    def fail(*_args, **_kwargs):
        raise subprocess.CalledProcessError(128, "git")

    monkeypatch.setattr(version.subprocess, "check_output", fail)
    assert version.get_app_version() == "v0.0.0-unknown"


# Genie server/app.py keeps its own get_app_version copy that reads the same stamp.
# The v2 APP_VERSION-env-first resolution is gone on purpose (the images write the stamp).


def test_app_stamp_wins_and_is_stripped(tmp_path, monkeypatch):
    stamp = tmp_path / ".app-version"
    stamp.write_text("  v2.0.0  \n", encoding="utf-8")
    monkeypatch.setattr(app_module, "APP_VERSION_FILE", stamp)
    monkeypatch.setenv("APP_VERSION", "v1.2.3-env-is-ignored")
    assert app_module.get_app_version() == "v2.0.0"


def test_app_without_stamp_uses_git_describe_of_the_checkout(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "APP_VERSION_FILE", tmp_path / "absent")
    result = app_module.get_app_version()
    assert result and result != "v0.0.0-unknown"


def test_app_without_stamp_or_git_returns_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "APP_VERSION_FILE", tmp_path / "absent")

    def fail(*_args, **_kwargs):
        raise OSError("no git")

    monkeypatch.setattr(app_module.subprocess, "check_output", fail)
    assert app_module.get_app_version() == "v0.0.0-unknown"
