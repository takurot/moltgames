"""Pydantic v2 models matching the @moltgames/domain TypeScript types."""
import time
from typing import Any, Literal, Optional
from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class Credentials(BaseModel):
    """Credentials stored in ~/.moltgames/credentials.json."""

    id_token: str = Field(
        validation_alias=AliasChoices("idToken", "id_token"),
        serialization_alias="idToken",
    )
    refresh_token: str = Field(
        validation_alias=AliasChoices("refreshToken", "refresh_token"),
        serialization_alias="refreshToken",
    )
    expires_at: int = Field(
        validation_alias=AliasChoices("expiresAt", "expires_at"),
        serialization_alias="expiresAt",
    )  # Unix timestamp in milliseconds

    model_config = ConfigDict(populate_by_name=True)

    def is_expired(self, buffer_ms: int = 60_000) -> bool:
        """Return True if the token has expired (or will expire within buffer_ms)."""
        return int(time.time() * 1000) >= self.expires_at - buffer_ms


class MatchParticipant(BaseModel):
    """A participant in a match."""

    uid: str
    agent_id: str = Field(alias="agentId", default="")
    role: str

    model_config = ConfigDict(populate_by_name=True)


class Match(BaseModel):
    """A match entity from the Gateway API."""

    match_id: str = Field(alias="matchId")
    game_id: str = Field(alias="gameId")
    status: str
    participants: list[MatchParticipant]
    started_at: Optional[str] = Field(alias="startedAt", default=None)
    ended_at: Optional[str] = Field(alias="endedAt", default=None)
    rule_id: str = Field(alias="ruleId")
    rule_version: str = Field(alias="ruleVersion")
    region: str

    model_config = ConfigDict(populate_by_name=True)


class TurnEvent(BaseModel):
    """A turn event from the match replay or live stream."""

    event_id: str = Field(alias="eventId")
    match_id: str = Field(alias="matchId")
    turn: int
    actor: str
    action: Any
    result: Any
    action_latency_ms: int = Field(alias="actionLatencyMs")
    timestamp: str
    action_type: str = Field(alias="actionType")
    seat: Literal["first", "second"]
    rule_version: str = Field(alias="ruleVersion")
    phase: str
    score_diff_before: float = Field(alias="scoreDiffBefore")
    score_diff_after: float = Field(alias="scoreDiffAfter")

    model_config = ConfigDict(populate_by_name=True)


class LeaderboardEntry(BaseModel):
    """A single entry in the leaderboard."""

    uid: str
    agent_id: Optional[str] = Field(alias="agentId", default=None)
    rank: int
    elo: float
    matches: int
    win_rate: float = Field(alias="winRate")

    model_config = ConfigDict(populate_by_name=True)


class MatchesPage(BaseModel):
    """Paginated match history response."""

    items: list[Match]
    next_cursor: Optional[str] = Field(alias="nextCursor", default=None)

    model_config = ConfigDict(populate_by_name=True)


class MatchHistoryEntry(BaseModel):
    """A historical match result for the authenticated user."""

    match_id: str = Field(alias="matchId")
    game_id: str = Field(alias="gameId")
    opponent_id: str = Field(alias="opponentId")
    result: Literal["win", "loss", "draw"]
    rating_change: float = Field(alias="ratingChange")
    played_at: str = Field(alias="playedAt")

    model_config = ConfigDict(populate_by_name=True)


class QueueStatus(BaseModel):
    """Status of the authenticated user's active queue entry."""

    status: Literal["QUEUED", "MATCHED"]
    game_id: str = Field(alias="gameId")
    agent_id: str = Field(alias="agentId")
    queued_at: str = Field(alias="queuedAt")
    match_id: Optional[str] = Field(alias="matchId", default=None)
    matched_at: Optional[str] = Field(alias="matchedAt", default=None)

    model_config = ConfigDict(populate_by_name=True)


class Rating(BaseModel):
    """Elo rating for a user in a season."""

    uid: str
    season_id: str = Field(alias="seasonId")
    elo: float
    matches: int
    win_rate: float = Field(alias="winRate")
    updated_at: str = Field(alias="updatedAt")

    model_config = ConfigDict(populate_by_name=True)
