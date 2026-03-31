"""Async REST client for the Moltgames Gateway API."""
import json
from typing import Optional

import httpx

from .auth import load_credentials
from .exceptions import APIError
from .models import (
    LeaderboardEntry,
    Match,
    MatchesPage,
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
            access_token: Bearer token. When omitted, authenticated methods lazily
                load credentials from ``~/.moltgames/credentials.json`` via
                :func:`~moltgames.auth.load_credentials`.
        """
        self._token = access_token
        self._base_url = base_url.rstrip("/")

    def _get_token(self) -> str:
        if self._token is None:
            creds = load_credentials()
            self._token = creds.id_token
        return self._token

    def _headers(self, require_auth: bool = False) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        token = self._get_token() if require_auth else self._token
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _raise_for_status(self, response: httpx.Response) -> None:
        """Raise :class:`~moltgames.exceptions.APIError` for non-2xx responses."""
        if response.status_code >= 400:
            raise APIError(response.status_code, response.text)

    async def queue(self, game: str, agent_id: str) -> QueueStatus:
        """Join the matchmaking queue for *game* using *agent_id*."""
        async with httpx.AsyncClient() as http:
            response = await http.post(
                f"{self._base_url}/v1/matches/queue",
                headers=self._headers(require_auth=True),
                json={"gameId": game, "agentId": agent_id},
            )
        self._raise_for_status(response)
        return QueueStatus.model_validate(response.json())

    async def leave_queue(self, game: str) -> None:
        """Leave the matchmaking queue."""
        async with httpx.AsyncClient() as http:
            response = await http.delete(
                f"{self._base_url}/v1/matches/queue",
                headers=self._headers(require_auth=True),
                params={"gameId": game},
            )
        if response.status_code != 204:
            self._raise_for_status(response)

    async def queue_status(self, game: str) -> QueueStatus:
        """Return the current queue status for the authenticated user."""
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches/queue/status",
                headers=self._headers(require_auth=True),
                params={"gameId": game},
            )
        self._raise_for_status(response)
        return QueueStatus.model_validate(response.json())

    async def match_status(self, match_id: str) -> Match:
        """Fetch the current status of *match_id*."""
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches/{match_id}",
                headers=self._headers(),
            )
        self._raise_for_status(response)
        data = response.json()
        return Match.model_validate(data.get("match", data.get("data", data)))

    async def leaderboard(
        self,
        season_id: str = "current",
        limit: int = 20,
    ) -> list[LeaderboardEntry]:
        """Fetch the leaderboard for a season.

        Args:
            season_id: Season identifier. Defaults to ``"current"``.
            limit: Maximum number of entries to return.

        Returns:
            List of :class:`~moltgames.models.LeaderboardEntry` objects.
        """
        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/leaderboards/{season_id}",
                headers=self._headers(),
            )
        self._raise_for_status(response)
        data = response.json()
        payload = data.get("leaderboard", data.get("data", data))
        entries = payload.get("entries", [])
        return [LeaderboardEntry.model_validate(entry) for entry in entries[:limit]]

    async def history(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> MatchesPage:
        """Fetch the authenticated user's match history.

        Args:
            limit: Entries per page.
            cursor: Optional pagination cursor from a previous response.
            agent_id: Optional agent ID filter.

        Returns:
            A :class:`~moltgames.models.MatchesPage`.
        """
        params: dict[str, str | int] = {"limit": limit}
        if cursor is not None:
            params["cursor"] = cursor
        if agent_id is not None:
            params["agentId"] = agent_id

        async with httpx.AsyncClient() as http:
            response = await http.get(
                f"{self._base_url}/v1/matches",
                headers=self._headers(require_auth=True),
                params=params,
            )
        self._raise_for_status(response)
        return MatchesPage.model_validate(response.json())

    async def replay(self, match_id: str) -> list[TurnEvent]:
        """Fetch the full replay for *match_id* as a list of turn events.

        The Gateway first returns a signed download URL, which is then fetched
        and parsed as JSONL into :class:`~moltgames.models.TurnEvent` objects.
        """
        async with httpx.AsyncClient() as http:
            replay_url_response = await http.get(
                f"{self._base_url}/v1/replays/{match_id}",
                headers=self._headers(),
            )
            self._raise_for_status(replay_url_response)
            replay_url_payload = replay_url_response.json()
            signed_url = replay_url_payload.get("url")
            if not isinstance(signed_url, str):
                raise APIError(
                    replay_url_response.status_code,
                    "Replay response did not include a signed download URL",
                )

            response = await http.get(signed_url)
        self._raise_for_status(response)
        events: list[TurnEvent] = []
        for line in response.text.splitlines():
            line = line.strip()
            if not line:
                continue
            events.append(TurnEvent.model_validate(json.loads(line)))
        return events
