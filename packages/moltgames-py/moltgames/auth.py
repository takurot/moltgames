"""Authentication helpers for loading and saving credentials."""
import json
from pathlib import Path

from .exceptions import AuthError
from .models import Credentials

CREDENTIALS_PATH: Path = Path.home() / ".moltgames" / "credentials.json"


def load_credentials(path: Path = CREDENTIALS_PATH) -> Credentials:
    """Load credentials from the given path (default: ~/.moltgames/credentials.json).

    Raises:
        AuthError: If the file does not exist, is not valid JSON, or is missing required fields.
    """
    if not path.exists():
        raise AuthError(
            f"No credentials found at {path}. Run 'moltgame login' first."
        )
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        raise AuthError(f"Credentials file at {path} contains invalid JSON: {exc}") from exc

    try:
        return Credentials(**data)
    except Exception as exc:
        raise AuthError(f"Credentials file at {path} has missing or invalid fields: {exc}") from exc


def save_credentials(credentials: Credentials, path: Path = CREDENTIALS_PATH) -> None:
    """Save credentials to the given path (default: ~/.moltgames/credentials.json).

    The parent directory is created if it does not exist. The file is written
    with mode 0o600 (owner read/write only) to protect sensitive tokens.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(credentials.model_dump(), f, indent=2)
    path.chmod(0o600)
