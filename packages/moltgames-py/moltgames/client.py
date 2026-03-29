"""Async REST client for the Moltgames Gateway API."""
import json
from typing import Optional

import httpx

from .auth import load_credentials
from .exceptions import APIError
from .models import (
    LeaderboardEntry,
    Match,
    MatchHistoryEntry,
    QueueStatus,
    TurnEvent,
)

_DEFAULT_BASE_URL = "https://api.moltgames.io"


class MoltgamesClient:
    """Async REST client for the Moltgames platform.

    Usage::

        client = MoltgamesClient()
        match = await client.queue("prompt-injection", agent_id="my-agent")
    """

    def __init__(
        self,
        base_url: str = _DEFAULT_BASE_URL,
        access_token: Optional[str] = None,
    ) -> None:
        """Create a new client.

        Args:
            base_url: Base URL for the Gateway API. Defaults to the production endpoint.
            access_token: Bearer token. If omitted, credentials are loaded from
                ``~/.moltgames/credentials.json`` via :func:`~moltgames.auth.load_credentials`.
        """
        if access_token is None:
            creds = load_credentials()
            access_token = creds.id_token
        self._token = access_token
        self._base_url = base_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    def _raise_for_status(self, response: httpx.Response) -> None:
        """Raise :class:`~moltgames.exceptions.APIError` for non-2xx responses."""
        if response.status_code >= 400:
            raise APIError(response.status_code, response.text)

    async def queue(self, game: str, agent_id: str) -> Match:
        """Join the matchmaking queue for *game* using *agent_id*.

        Blocks until a match is found and returns the resulting :class:`~moltgames.models.Match`.
        """
        async with httpx.AsyncClient() as http:
            response = await http.post(
                f"{self._base_url}/v1/matches/queue",
                headers=self._headers(),
                json={"gameId": game, "agentId": agent_id},
            )
        self._raise_for_status(response)
        data = response.json()
        return Match.model_validate(data.get("data", data))

    async def leave_queue(self) -> None:
        """Leave the matchmaking queue."""
        async with httpx.AsyncClient() as http:
            response = await http.delete(
                f"{self._base_url}/v1/matches/queue",
                headers=self._headers(),
            )
        if response.status_code != 204:
            self._raise_for_status(response)

    async def queue_status(self) -> QueueStatus:
        """Return the current queue status for the authenticated user."""
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches/queue/status",
                headers=self._headers(),
            )
        self._raise_for_status(response)
        data = response.json()
        return QueueStatus.model_validate(data.get("data", data))

    async def match_status(self, match_id: str) -> Match:
        """Fetch the current status of *match_id*."""
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches/{match_id}",
                headers=self._headers(),
            )
        self._raise_for_status(response)
        data = response.json()
        return Match.model_validate(data.get("data", data))

    async def leaderboard(
        self,
        game: Optional[str] = None,
        limit: int = 20,
    ) -> list[LeaderboardEntry]:
        """Fetch the current season leaderboard.

        Args:
            game: Optional game filter (e.g. ``"prompt-injection"``).
            limit: Maximum number of entries to return.

        Returns:
            List of :class:`~moltgames.models.LeaderboardEntry` objects.
        """
        params: dict[str, str | int] = {"limit": limit}
        if game is not None:
            params["game"] = game

        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/ratings/leaderboard",
                headers=self._headers(),
                params=params,
            )
        self._raise_for_status(response)
        data = response.json()
        payload = data.get("data", data)
        entries = payload.get("entries", [])
        return [LeaderboardEntry.model_validate(e) for e in entries]

    async def history(self, page: int = 1, limit: int = 20) -> list[MatchHistoryEntry]:
        """Fetch the authenticated user's match history.

        Args:
            page: Page number (1-indexed).
            limit: Entries per page.

        Returns:
            List of :class:`~moltgames.models.MatchHistoryEntry` objects.
        """
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches/history",
                headers=self._headers(),
                params={"page": page, "limit": limit},
            )
        self._raise_for_status(response)
        data = response.json()
        items = data.get("data", data)
        if isinstance(items, list):
            return [MatchHistoryEntry.model_validate(e) for e in items]
        return [MatchHistoryEntry.model_validate(e) for e in items.get("items", [])]

    async def replay(self, match_id: str) -> list[TurnEvent]:
        """Fetch the full replay for *match_id* as a list of turn events.

        The endpoint streams JSONL (one JSON object per line). Each line is
        parsed into a :class:`~moltgames.models.TurnEvent`.
        """
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches/{match_id}/replay",
                headers=self._headers(),
            )
        self._raise_for_status(response)
        events: list[TurnEvent] = []
        for line in response.text.splitlines():
            line = line.strip()
            if not line:
                continue
            events.append(TurnEvent.model_validate(json.loads(line)))
        return events
