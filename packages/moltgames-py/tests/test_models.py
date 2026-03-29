"""Tests for Pydantic models."""
import pytest
from pydantic import ValidationError
from moltgames.models import (
    Credentials,
    Match,
    MatchParticipant,
    TurnEvent,
    LeaderboardEntry,
    MatchHistoryEntry,
    QueueStatus,
    Rating,
)


class TestCredentials:
    def test_valid_credentials(self) -> None:
        creds = Credentials(
            id_token="tok",
            refresh_token="ref",
            expires_at=9999999999000,
        )
        assert creds.id_token == "tok"
        assert creds.refresh_token == "ref"
        assert creds.expires_at == 9999999999000

    def test_missing_required_fields(self) -> None:
        with pytest.raises(ValidationError):
            Credentials(id_token="tok")  # type: ignore[call-arg]

    def test_is_expired_false(self) -> None:
        creds = Credentials(
            id_token="tok",
            refresh_token="ref",
            expires_at=9999999999000,
        )
        assert not creds.is_expired()

    def test_is_expired_true(self) -> None:
        creds = Credentials(
            id_token="tok",
            refresh_token="ref",
            expires_at=1000,  # very old timestamp
        )
        assert creds.is_expired()


class TestMatchParticipant:
    def test_valid_participant(self) -> None:
        p = MatchParticipant(uid="u1", agent_id="a1", role="PLAYER")
        assert p.uid == "u1"
        assert p.role == "PLAYER"


class TestMatch:
    def test_valid_match(self) -> None:
        m = Match(
            match_id="m1",
            game_id="prompt-injection",
            status="active",
            participants=[{"uid": "u1", "agent_id": "a1", "role": "PLAYER"}],
            rule_id="pia-v1",
            rule_version="1.0.0",
            region="us-central1",
        )
        assert m.match_id == "m1"
        assert m.status == "active"
        assert len(m.participants) == 1

    def test_optional_fields(self) -> None:
        m = Match(
            match_id="m1",
            game_id="game",
            status="waiting",
            participants=[],
            rule_id="r1",
            rule_version="1.0.0",
            region="us-central1",
        )
        assert m.started_at is None
        assert m.ended_at is None


class TestTurnEvent:
    def test_valid_turn_event(self) -> None:
        ev = TurnEvent(
            event_id="e1",
            match_id="m1",
            turn=1,
            actor="agent-1",
            action={"move": "up"},
            result={"ok": True},
            action_latency_ms=200,
            timestamp="2026-01-01T00:00:00Z",
            action_type="move",
            seat="first",
            rule_version="1.0.0",
            phase="main",
            score_diff_before=0.0,
            score_diff_after=1.0,
        )
        assert ev.event_id == "e1"
        assert ev.turn == 1


class TestLeaderboardEntry:
    def test_valid_entry(self) -> None:
        entry = LeaderboardEntry(
            uid="u1",
            rank=1,
            elo=1500.0,
            matches=10,
            win_rate=0.6,
        )
        assert entry.rank == 1
        assert entry.elo == 1500.0

    def test_optional_agent_id(self) -> None:
        entry = LeaderboardEntry(uid="u1", rank=1, elo=1200.0, matches=5, win_rate=0.4)
        assert entry.agent_id is None


class TestMatchHistoryEntry:
    def test_valid_entry(self) -> None:
        entry = MatchHistoryEntry(
            match_id="m1",
            game_id="game",
            opponent_id="u2",
            result="win",
            rating_change=15.0,
            played_at="2026-01-01T00:00:00Z",
        )
        assert entry.result == "win"

    def test_invalid_result(self) -> None:
        with pytest.raises(ValidationError):
            MatchHistoryEntry(
                match_id="m1",
                game_id="game",
                opponent_id="u2",
                result="invalid",  # type: ignore[arg-type]
                rating_change=0.0,
                played_at="2026-01-01T00:00:00Z",
            )


class TestQueueStatus:
    def test_waiting_status(self) -> None:
        qs = QueueStatus(status="waiting", position=3)
        assert qs.status == "waiting"
        assert qs.match_id is None

    def test_matched_status(self) -> None:
        qs = QueueStatus(
            status="matched",
            match_id="m1",
            connect_token="tok",
        )
        assert qs.match_id == "m1"
