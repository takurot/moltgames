"""Tests for the async REST client using respx to mock httpx."""
import httpx
import pytest
import respx
from moltgames.client import MoltgamesClient
from moltgames.exceptions import APIError
from moltgames.models import LeaderboardEntry, Match, MatchesPage, QueueStatus, TurnEvent


BASE_URL = "https://api.moltgames.io"


def make_client(token: str = "test-token") -> MoltgamesClient:
    return MoltgamesClient(base_url=BASE_URL, access_token=token)


class TestQueue:
    @respx.mock
    async def test_queue_returns_status(self) -> None:
        queue_data = {
            "status": "QUEUED",
            "gameId": "prompt-injection",
            "agentId": "agent-1",
            "queuedAt": "2026-01-01T00:00:00Z",
        }
        respx.post(f"{BASE_URL}/v1/matches/queue").mock(
            return_value=httpx.Response(202, json=queue_data)
        )
        client = make_client()
        status = await client.queue("prompt-injection", agent_id="agent-1")
        assert isinstance(status, QueueStatus)
        assert status.status == "QUEUED"
        assert status.game_id == "prompt-injection"

    @respx.mock
    async def test_queue_raises_api_error_on_failure(self) -> None:
        respx.post(f"{BASE_URL}/v1/matches/queue").mock(
            return_value=httpx.Response(
                429, json={"error": {"code": "RATE_LIMITED", "message": "Too many requests"}}
            )
        )
        client = make_client()
        with pytest.raises(APIError) as exc_info:
            await client.queue("game", agent_id="agent-1")
        assert exc_info.value.status_code == 429


class TestMatchStatus:
    @respx.mock
    async def test_match_status_returns_match(self) -> None:
        match_data = {
            "matchId": "m42",
            "gameId": "vector-grid",
            "status": "active",
            "participants": [{"uid": "u1", "agentId": "a1", "role": "PLAYER"}],
            "ruleId": "vg-v1",
            "ruleVersion": "1.0.0",
            "region": "us-central1",
        }
        respx.get(f"{BASE_URL}/v1/matches/m42").mock(
            return_value=httpx.Response(200, json={"status": "ok", "match": match_data})
        )
        client = make_client()
        match = await client.match_status("m42")
        assert match.match_id == "m42"
        assert match.status == "active"

    @respx.mock
    async def test_match_status_404_raises_api_error(self) -> None:
        respx.get(f"{BASE_URL}/v1/matches/unknown").mock(
            return_value=httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "Not found"}})
        )
        client = make_client()
        with pytest.raises(APIError) as exc_info:
            await client.match_status("unknown")
        assert exc_info.value.status_code == 404


class TestLeaderboard:
    @respx.mock
    async def test_leaderboard_returns_entries(self) -> None:
        leaderboard_data = {
            "seasonId": "s1",
            "generatedAt": "2026-01-01T00:00:00Z",
            "entries": [
                {"uid": "u1", "rank": 1, "elo": 1800.0, "matches": 50, "winRate": 0.7},
                {"uid": "u2", "rank": 2, "elo": 1700.0, "matches": 40, "winRate": 0.6},
            ],
        }
        respx.get(f"{BASE_URL}/v1/leaderboards/current").mock(
            return_value=httpx.Response(200, json={"status": "ok", "leaderboard": leaderboard_data})
        )
        client = make_client()
        entries = await client.leaderboard()
        assert len(entries) == 2
        assert isinstance(entries[0], LeaderboardEntry)
        assert entries[0].rank == 1

    @respx.mock
    async def test_leaderboard_with_season_filter(self) -> None:
        leaderboard_data = {"seasonId": "s1", "generatedAt": "2026-01-01T00:00:00Z", "entries": []}
        route = respx.get(f"{BASE_URL}/v1/leaderboards/season-2").mock(
            return_value=httpx.Response(200, json={"status": "ok", "leaderboard": leaderboard_data})
        )
        client = make_client()
        await client.leaderboard(season_id="season-2", limit=10)
        assert route.called
        assert len(route.calls) == 1

    @respx.mock
    async def test_public_endpoints_do_not_require_credentials(self) -> None:
        match_data = {
            "matchId": "m42",
            "gameId": "vector-grid",
            "status": "active",
            "participants": [],
            "ruleId": "vg-v1",
            "ruleVersion": "1.0.0",
            "region": "us-central1",
        }
        respx.get(f"{BASE_URL}/v1/matches/m42").mock(
            return_value=httpx.Response(200, json={"status": "ok", "match": match_data})
        )

        client = MoltgamesClient(base_url=BASE_URL)
        match = await client.match_status("m42")
        assert match.match_id == "m42"


class TestHistory:
    @respx.mock
    async def test_history_returns_match_page(self) -> None:
        history_data = {
            "items": [
                {
                    "matchId": "m1",
                    "gameId": "game",
                    "status": "completed",
                    "participants": [{"uid": "u1", "agentId": "a1", "role": "PLAYER"}],
                    "startedAt": "2026-01-01T00:00:00Z",
                    "endedAt": "2026-01-01T00:10:00Z",
                    "ruleId": "rule-1",
                    "ruleVersion": "1.0.0",
                    "region": "us-central1",
                }
            ],
            "nextCursor": "cursor-2",
        }
        route = respx.get(f"{BASE_URL}/v1/matches").mock(
            return_value=httpx.Response(200, json=history_data)
        )
        client = make_client()
        page = await client.history(limit=10, cursor="cursor-1", agent_id="agent-1")
        assert isinstance(page, MatchesPage)
        assert len(page.items) == 1
        assert page.items[0].match_id == "m1"
        assert page.next_cursor == "cursor-2"
        request = route.calls[0].request
        assert b"limit=10" in request.url.query
        assert b"cursor=cursor-1" in request.url.query
        assert b"agentId=agent-1" in request.url.query


class TestReplay:
    @respx.mock
    async def test_replay_returns_turn_events(self) -> None:
        signed_url = "https://storage.googleapis.com/replay-m1.jsonl"
        jsonl_content = "\n".join([
            '{"eventId":"e1","matchId":"m1","turn":1,"actor":"a1","action":{"move":"up"},"result":{"ok":true},"actionLatencyMs":100,"timestamp":"2026-01-01T00:00:00Z","actionType":"move","seat":"first","ruleVersion":"1.0.0","phase":"main","scoreDiffBefore":0.0,"scoreDiffAfter":1.0}',
            '{"eventId":"e2","matchId":"m1","turn":2,"actor":"a2","action":{"move":"down"},"result":{"ok":true},"actionLatencyMs":150,"timestamp":"2026-01-01T00:00:01Z","actionType":"move","seat":"second","ruleVersion":"1.0.0","phase":"main","scoreDiffBefore":1.0,"scoreDiffAfter":0.5}',
        ])
        respx.get(f"{BASE_URL}/v1/replays/m1").mock(
            return_value=httpx.Response(200, json={"status": "ok", "url": signed_url})
        )
        respx.get(signed_url).mock(
            return_value=httpx.Response(200, text=jsonl_content)
        )
        client = make_client()
        events = await client.replay("m1")
        assert len(events) == 2
        assert isinstance(events[0], TurnEvent)
        assert events[0].event_id == "e1"
        assert events[1].turn == 2

    @respx.mock
    async def test_replay_empty(self) -> None:
        signed_url = "https://storage.googleapis.com/replay-m1.jsonl"
        respx.get(f"{BASE_URL}/v1/replays/m1").mock(
            return_value=httpx.Response(200, json={"status": "ok", "url": signed_url})
        )
        respx.get(signed_url).mock(
            return_value=httpx.Response(200, text="")
        )
        client = make_client()
        events = await client.replay("m1")
        assert events == []


class TestQueueStatus:
    @respx.mock
    async def test_queue_status_includes_game_id(self) -> None:
        route = respx.get(f"{BASE_URL}/v1/matches/queue/status").mock(
            return_value=httpx.Response(
                200,
                json={
                    "status": "QUEUED",
                    "gameId": "prompt-injection",
                    "agentId": "agent-1",
                    "queuedAt": "2026-01-01T00:00:00Z",
                },
            )
        )
        client = make_client()
        qs = await client.queue_status("prompt-injection")
        assert isinstance(qs, QueueStatus)
        assert qs.status == "QUEUED"
        assert qs.game_id == "prompt-injection"
        request = route.calls[0].request
        assert b"gameId=prompt-injection" in request.url.query

    @respx.mock
    async def test_leave_queue(self) -> None:
        route = respx.delete(f"{BASE_URL}/v1/matches/queue").mock(
            return_value=httpx.Response(204)
        )
        client = make_client()
        # Should not raise
        await client.leave_queue("prompt-injection")
        request = route.calls[0].request
        assert b"gameId=prompt-injection" in request.url.query


class TestAuthorizationHeader:
    @respx.mock
    async def test_bearer_token_sent(self) -> None:
        respx.get(f"{BASE_URL}/v1/matches").mock(
            return_value=httpx.Response(
                200,
                json={"items": [], "nextCursor": None},
            )
        )
        client = make_client(token="my-secret-token")
        await client.history()
        request = respx.calls[0].request
        assert request.headers["authorization"] == "Bearer my-secret-token"
