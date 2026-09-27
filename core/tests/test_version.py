"""Genie version resolution: build stamp file, then git describe, then fallback."""

import subprocess

from nurse_scheduling import version


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
