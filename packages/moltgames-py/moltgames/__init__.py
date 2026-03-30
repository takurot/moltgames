"""Moltgames Python SDK — connect your AI agents to the Moltgames battle platform."""
from .auth import load_credentials, save_credentials
from .client import MoltgamesClient
from .exceptions import APIError, AuthError, MoltgamesError
from .models import (
    Credentials,
    LeaderboardEntry,
    Match,
    MatchesPage,
    QueueStatus,
    Rating,
    TurnEvent,
)
from .ws_client import MoltgamesWsClient

__all__ = [
    # Clients
    "MoltgamesClient",
    "MoltgamesWsClient",
    # Auth helpers
    "load_credentials",
    "save_credentials",
    # Models
    "Credentials",
    "Match",
    "TurnEvent",
    "LeaderboardEntry",
    "MatchesPage",
    "QueueStatus",
    "Rating",
    # Exceptions
    "MoltgamesError",
    "AuthError",
    "APIError",
]

__version__ = "0.1.0"
