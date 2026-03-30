"""Custom exceptions for the Moltgames SDK."""


class MoltgamesError(Exception):
    """Base exception for all Moltgames SDK errors."""


class AuthError(MoltgamesError):
    """Raised when authentication fails or credentials are missing/invalid."""


class APIError(MoltgamesError):
    """Raised when the Gateway API returns an error response."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"HTTP {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class ConnectionError(MoltgamesError):
    """Raised when a WebSocket connection cannot be established or is lost."""
