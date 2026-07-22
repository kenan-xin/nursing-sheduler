"""Tests for server version resolution: APP_VERSION env → git describe → fallback.

The resolution chain replaces the retired VERSION-file path. In the container,
APP_VERSION is always set (ENV from build arg), so the git branch is unreachable
there — preserving hermeticity. From source (dev), APP_VERSION is typically unset,
so it falls through to git describe of the current checkout.
"""

from pathlib import Path
from unittest.mock import patch

from nurse_scheduling.server.app import _git_describe_version, get_app_version


# ── _git_describe_version ──────────────────────────────────────────────────


class TestGitDescribeVersion:
    def test_returns_describe_output_when_dotGit_exists(self):
        """From a real source checkout, returns the git describe string."""
        repo_root = Path(__file__).resolve().parents[2]
        result = _git_describe_version(repo_root)
        assert result is not None
        assert len(result) > 0

    def test_returns_none_when_dotGit_absent(self, tmp_path):
        """A directory without .git returns None without invoking git."""
        result = _git_describe_version(tmp_path)
        assert result is None

    def test_returns_none_when_git_subprocess_fails(self):
        """If git is present but the command fails, returns None."""
        repo_root = Path(__file__).resolve().parents[2]
        with patch("subprocess.check_output", side_effect=OSError("no git")):
            result = _git_describe_version(repo_root)
        assert result is None


# ── get_app_version ────────────────────────────────────────────────────────


class TestGetAppVersion:
    def test_env_var_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("APP_VERSION", "v1.2.3-test")
        assert get_app_version() == "v1.2.3-test"

    def test_env_var_is_stripped(self, monkeypatch):
        monkeypatch.setenv("APP_VERSION", "  v2.0.0  \n")
        assert get_app_version() == "v2.0.0"

    def test_empty_env_falls_through_to_git(self, monkeypatch):
        monkeypatch.setenv("APP_VERSION", "   ")
        result = get_app_version()
        assert result != "v0.0.0-unknown"
        assert len(result) > 0

    def test_unset_env_uses_git_describe(self, monkeypatch):
        monkeypatch.delenv("APP_VERSION", raising=False)
        result = get_app_version()
        assert result != "v0.0.0-unknown"
        assert len(result) > 0

    def test_no_env_no_git_returns_unknown(self, monkeypatch):
        monkeypatch.delenv("APP_VERSION", raising=False)
        with patch("subprocess.check_output", side_effect=OSError("no git")):
            assert get_app_version() == "v0.0.0-unknown"
