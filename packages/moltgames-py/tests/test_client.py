"""Tests for the async REST client using respx to mock httpx."""
import pytest
import httpx
import respx
from moltgames.client import MoltgamesClient
from moltgames.exceptions import APIError
from moltgames.models import Match, LeaderboardEntry, MatchHistoryEntry, TurnEvent, QueueStatus


BASE_URL = "https://api.moltgames.io"


def make_client(token: str = "test-token") -> MoltgamesClient:
    return MoltgamesClient(base_url=BASE_URL, access_token=token)


class TestQueue:
    @respx.mock
    async def test_queue_returns_match(self) -> None:
        match_data = {
            "matchId": "m1",
            "gameId": "prompt-injection",
            "status": "waiting",
            "participants": [],
            "ruleId": "pia-v1",
            "ruleVersion": "1.0.0",
            "region": "us-central1",
        }
        respx.post(f"{BASE_URL}/v1/matches/queue").mock(
            return_value=httpx.Response(200, json={"status": "ok", "data": match_data})
        )
        client = make_client()
        match = await client.queue("prompt-injection", agent_id="agent-1")
        assert isinstance(match, Match)
        assert match.match_id == "m1"

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
            return_value=httpx.Response(200, json={"status": "ok", "data": match_data})
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
        respx.get(f"{BASE_URL}/v1/ratings/leaderboard").mock(
            return_value=httpx.Response(200, json={"status": "ok", "data": leaderboard_data})
        )
        client = make_client()
        entries = await client.leaderboard()
        assert len(entries) == 2
        assert isinstance(entries[0], LeaderboardEntry)
        assert entries[0].rank == 1

    @respx.mock
    async def test_leaderboard_with_game_filter(self) -> None:
        leaderboard_data = {"seasonId": "s1", "generatedAt": "2026-01-01T00:00:00Z", "entries": []}
        route = respx.get(f"{BASE_URL}/v1/ratings/leaderboard").mock(
            return_value=httpx.Response(200, json={"status": "ok", "data": leaderboard_data})
        )
        client = make_client()
        await client.leaderboard(game="prompt-injection", limit=10)
        assert route.called
        request = route.calls[0].request
        assert b"game=prompt-injection" in request.url.query
        assert b"limit=10" in request.url.query


class TestHistory:
    @respx.mock
    async def test_history_returns_entries(self) -> None:
        history_data = [
            {
                "matchId": "m1",
                "gameId": "game",
                "opponentId": "u2",
                "result": "win",
                "ratingChange": 15.0,
                "playedAt": "2026-01-01T00:00:00Z",
            }
        ]
        respx.get(f"{BASE_URL}/v1/matches/history").mock(
            return_value=httpx.Response(200, json={"status": "ok", "data": history_data})
        )
        client = make_client()
        entries = await client.history()
        assert len(entries) == 1
        assert isinstance(entries[0], MatchHistoryEntry)
        assert entries[0].result == "win"


class TestReplay:
    @respx.mock
    async def test_replay_returns_turn_events(self) -> None:
        jsonl_content = "\n".join([
            '{"eventId":"e1","matchId":"m1","turn":1,"actor":"a1","action":{"move":"up"},"result":{"ok":true},"actionLatencyMs":100,"timestamp":"2026-01-01T00:00:00Z","actionType":"move","seat":"first","ruleVersion":"1.0.0","phase":"main","scoreDiffBefore":0.0,"scoreDiffAfter":1.0}',
            '{"eventId":"e2","matchId":"m1","turn":2,"actor":"a2","action":{"move":"down"},"result":{"ok":true},"actionLatencyMs":150,"timestamp":"2026-01-01T00:00:01Z","actionType":"move","seat":"second","ruleVersion":"1.0.0","phase":"main","scoreDiffBefore":1.0,"scoreDiffAfter":0.5}',
        ])
        respx.get(f"{BASE_URL}/v1/matches/m1/replay").mock(
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
        respx.get(f"{BASE_URL}/v1/matches/m1/replay").mock(
            return_value=httpx.Response(200, text="")
        )
        client = make_client()
        events = await client.replay("m1")
        assert events == []


class TestQueueStatus:
    @respx.mock
    async def test_queue_status_returns_waiting(self) -> None:
        respx.get(f"{BASE_URL}/v1/matches/queue/status").mock(
            return_value=httpx.Response(
                200,
                json={"status": "ok", "data": {"status": "waiting", "position": 2}},
            )
        )
        client = make_client()
        qs = await client.queue_status()
        assert isinstance(qs, QueueStatus)
        assert qs.status == "waiting"
        assert qs.position == 2

    @respx.mock
    async def test_leave_queue(self) -> None:
        respx.delete(f"{BASE_URL}/v1/matches/queue").mock(
            return_value=httpx.Response(204)
        )
        client = make_client()
        # Should not raise
        await client.leave_queue()


class TestAuthorizationHeader:
    @respx.mock
    async def test_bearer_token_sent(self) -> None:
        respx.get(f"{BASE_URL}/v1/ratings/leaderboard").mock(
            return_value=httpx.Response(
                200,
                json={"status": "ok", "data": {"seasonId": "s1", "entries": []}},
            )
        )
        client = make_client(token="my-secret-token")
        await client.leaderboard()
        request = respx.calls[0].request
        assert request.headers["authorization"] == "Bearer my-secret-token"
