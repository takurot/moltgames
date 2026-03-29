"""Shared pytest fixtures for moltgames SDK tests."""
import json
import pytest
from pathlib import Path
from moltgames.models import Credentials


@pytest.fixture
def sample_credentials() -> Credentials:
    return Credentials(
        id_token="test-id-token",
        refresh_token="test-refresh-token",
        expires_at=9999999999000,
    )


@pytest.fixture
def credentials_file(tmp_path: Path, sample_credentials: Credentials) -> Path:
    creds_dir = tmp_path / ".moltgames"
    creds_dir.mkdir()
    creds_file = creds_dir / "credentials.json"
    creds_file.write_text(
        json.dumps(sample_credentials.model_dump()),
        encoding="utf-8",
    )
    return creds_file
