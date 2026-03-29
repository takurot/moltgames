"""Tests for auth helpers."""
import json
import time
import pytest
from pathlib import Path
from moltgames.auth import load_credentials, save_credentials
from moltgames.exceptions import AuthError
from moltgames.models import Credentials


class TestLoadCredentials:
    def test_loads_valid_file(self, credentials_file: Path) -> None:
        creds = load_credentials(credentials_file)
        assert creds.id_token == "test-id-token"
        assert creds.refresh_token == "test-refresh-token"

    def test_raises_auth_error_when_missing(self, tmp_path: Path) -> None:
        missing = tmp_path / "no_such_file.json"
        with pytest.raises(AuthError, match="No credentials found"):
            load_credentials(missing)

    def test_raises_auth_error_on_malformed_json(self, tmp_path: Path) -> None:
        bad_file = tmp_path / "credentials.json"
        bad_file.write_text("not json", encoding="utf-8")
        with pytest.raises(AuthError):
            load_credentials(bad_file)

    def test_raises_auth_error_on_missing_fields(self, tmp_path: Path) -> None:
        bad_file = tmp_path / "credentials.json"
        bad_file.write_text(json.dumps({"id_token": "only_partial"}), encoding="utf-8")
        with pytest.raises(AuthError):
            load_credentials(bad_file)


class TestSaveCredentials:
    def test_saves_credentials(self, tmp_path: Path, sample_credentials: Credentials) -> None:
        dest = tmp_path / ".moltgames" / "credentials.json"
        save_credentials(sample_credentials, dest)
        assert dest.exists()
        data = json.loads(dest.read_text())
        assert data["id_token"] == "test-id-token"

    def test_creates_parent_directory(self, tmp_path: Path, sample_credentials: Credentials) -> None:
        dest = tmp_path / "new_dir" / "sub" / "credentials.json"
        save_credentials(sample_credentials, dest)
        assert dest.exists()

    def test_file_permissions_are_restricted(
        self, tmp_path: Path, sample_credentials: Credentials
    ) -> None:
        dest = tmp_path / "credentials.json"
        save_credentials(sample_credentials, dest)
        mode = oct(dest.stat().st_mode)
        # Should end in 600 (owner read/write only)
        assert mode.endswith("600")

    def test_roundtrip(self, tmp_path: Path, sample_credentials: Credentials) -> None:
        dest = tmp_path / "credentials.json"
        save_credentials(sample_credentials, dest)
        loaded = load_credentials(dest)
        assert loaded == sample_credentials
