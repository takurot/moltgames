"""Tests for the WebSocket client."""
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from moltgames.ws_client import MoltgamesWsClient
from moltgames.models import TurnEvent


def make_turn_event_msg(turn: int = 1) -> str:
    return json.dumps({
        "type": "turn_event",
        "event": {
            "eventId": f"e{turn}",
            "matchId": "m1",
            "turn": turn,
            "actor": "a1",
            "action": {"move": "up"},
            "result": {"ok": True},
            "actionLatencyMs": 100,
            "timestamp": "2026-01-01T00:00:00Z",
            "actionType": "move",
            "seat": "first",
            "ruleVersion": "1.0.0",
            "phase": "main",
            "scoreDiffBefore": 0.0,
            "scoreDiffAfter": 1.0,
        },
    })


def make_match_ended_msg() -> str:
    return json.dumps({"type": "match/ended", "reason": "FINISHED"})


def make_draining_msg(reconnect_after_ms: int = 0) -> str:
    return json.dumps({"type": "DRAINING", "reconnect_after_ms": reconnect_after_ms})


def make_mock_ws(messages: list[str]) -> MagicMock:
    """Create a mock WebSocket context manager that yields the given messages."""
    async def async_gen(_self=None):
        for msg in messages:
            yield msg

    mock_ws = MagicMock()
    mock_ws.__aiter__ = async_gen
    mock_ws.__aenter__ = AsyncMock(return_value=mock_ws)
    mock_ws.__aexit__ = AsyncMock(return_value=False)
    return mock_ws


class TestMoltgamesWsClientWatch:
    async def test_watch_yields_turn_events(self) -> None:
        messages = [make_turn_event_msg(1), make_turn_event_msg(2), make_match_ended_msg()]
        mock_ws = make_mock_ws(messages)

        with patch("moltgames.ws_client.websockets.connect", return_value=mock_ws):
            client = MoltgamesWsClient(base_url="wss://api.moltgames.io", access_token="tok")
            events = []
            async for event in client.watch("m1"):
                events.append(event)

        assert len(events) == 2
        assert isinstance(events[0], TurnEvent)
        assert events[0].turn == 1
        assert events[1].turn == 2

    async def test_watch_stops_on_match_ended(self) -> None:
        # match/ended appears before the second turn event
        messages = [make_turn_event_msg(1), make_match_ended_msg(), make_turn_event_msg(2)]
        mock_ws = make_mock_ws(messages)

        with patch("moltgames.ws_client.websockets.connect", return_value=mock_ws):
            client = MoltgamesWsClient(base_url="wss://api.moltgames.io", access_token="tok")
            events = []
            async for event in client.watch("m1"):
                events.append(event)

        # Should stop after match/ended, not yield the third event
        assert len(events) == 1

    async def test_watch_handles_draining_reconnect(self) -> None:
        """DRAINING message should trigger reconnect after the specified delay."""
        call_count = 0
        first_messages = [make_draining_msg(reconnect_after_ms=0)]
        second_messages = [make_turn_event_msg(1), make_match_ended_msg()]

        mock_ws_first = make_mock_ws(first_messages)
        mock_ws_second = make_mock_ws(second_messages)
        ws_instances = [mock_ws_first, mock_ws_second]

        def connect_side_effect(*args, **kwargs):
            nonlocal call_count
            ws = ws_instances[call_count]
            call_count += 1
            return ws

        with patch("moltgames.ws_client.websockets.connect", side_effect=connect_side_effect):
            client = MoltgamesWsClient(base_url="wss://api.moltgames.io", access_token="tok")
            events = []
            async for event in client.watch("m1"):
                events.append(event)

        assert call_count == 2
        assert len(events) == 1
        assert events[0].turn == 1

    async def test_watch_ignores_unknown_message_types(self) -> None:
        messages = [
            json.dumps({"type": "unknown_event", "data": "ignored"}),
            make_turn_event_msg(1),
            make_match_ended_msg(),
        ]
        mock_ws = make_mock_ws(messages)

        with patch("moltgames.ws_client.websockets.connect", return_value=mock_ws):
            client = MoltgamesWsClient(base_url="wss://api.moltgames.io", access_token="tok")
            events = []
            async for event in client.watch("m1"):
                events.append(event)

        assert len(events) == 1


class TestMoltgamesWsClientConnectAsAgent:
    async def test_connect_as_agent_uses_connect_token(self) -> None:
        mock_ws = MagicMock()
        mock_ws.__aenter__ = AsyncMock(return_value=mock_ws)
        mock_ws.__aexit__ = AsyncMock(return_value=False)

        connect_calls: list[str] = []

        def capture_connect(url, **kwargs):
            connect_calls.append(url)
            return mock_ws

        with patch("moltgames.ws_client.websockets.connect", side_effect=capture_connect):
            client = MoltgamesWsClient(base_url="wss://api.moltgames.io", access_token="tok")
            await client.connect_as_agent("my-connect-token")

        assert len(connect_calls) == 1
        assert "connect_token=my-connect-token" in connect_calls[0]

    async def test_connect_as_agent_uses_moltgame_protocol(self) -> None:
        mock_ws = MagicMock()
        mock_ws.__aenter__ = AsyncMock(return_value=mock_ws)
        mock_ws.__aexit__ = AsyncMock(return_value=False)

        connect_kwargs_list: list[dict] = []

        def capture_connect(url, **kwargs):
            connect_kwargs_list.append(kwargs)
            return mock_ws

        with patch("moltgames.ws_client.websockets.connect", side_effect=capture_connect):
            client = MoltgamesWsClient(base_url="wss://api.moltgames.io", access_token="tok")
            await client.connect_as_agent("token")

        assert len(connect_kwargs_list) == 1
        assert "moltgame.v1" in connect_kwargs_list[0].get("subprotocols", [])
