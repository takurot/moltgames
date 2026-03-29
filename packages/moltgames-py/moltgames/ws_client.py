"""Async WebSocket client for real-time match streaming and agent participation."""
import asyncio
import json
import logging
from typing import AsyncGenerator, Optional

import websockets

from .auth import load_credentials
from .exceptions import ConnectionError as MoltgamesConnectionError
from .models import TurnEvent

logger = logging.getLogger(__name__)

_DEFAULT_WS_URL = "wss://api.moltgames.io"
_DEFAULT_RECONNECT_DELAY_S = 1.0
_DEFAULT_RECONNECT_MAX_DELAY_S = 8.0


class MoltgamesWsClient:
    """Async WebSocket client for the Moltgames platform.

    Supports two usage patterns:

    1. **Spectating** — :meth:`watch` streams :class:`~moltgames.models.TurnEvent`
       objects for an in-progress match and handles ``DRAINING`` reconnects
       transparently.

    2. **Agent participation** — :meth:`connect_as_agent` opens a raw WebSocket
       connection using a ``connect_token`` so an AI agent can call MCP tools.
    """

    def __init__(
        self,
        base_url: str = _DEFAULT_WS_URL,
        access_token: Optional[str] = None,
    ) -> None:
        """Create a new WebSocket client.

        Args:
            base_url: WebSocket base URL. Defaults to the production endpoint.
            access_token: Bearer token used for authentication. If omitted,
                credentials are loaded from ``~/.moltgames/credentials.json``.
        """
        if access_token is None:
            creds = load_credentials()
            access_token = creds.id_token
        self._token = access_token
        self._base_url = base_url.rstrip("/")

    async def watch(self, match_id: str) -> AsyncGenerator[TurnEvent, None]:
        """Stream live :class:`~moltgames.models.TurnEvent` objects for *match_id*.

        Connects to the spectator WebSocket endpoint and yields events as they
        arrive. Handles ``DRAINING`` messages by reconnecting after the
        server-specified delay (defaulting to 1 second).

        The generator terminates when a ``match/ended`` message is received or
        the connection closes normally.

        Args:
            match_id: The ID of the match to spectate.

        Yields:
            :class:`~moltgames.models.TurnEvent` for each turn action.
        """
        reconnect_delay_s = _DEFAULT_RECONNECT_DELAY_S

        while True:
            url = f"{self._base_url}/v1/matches/{match_id}/watch?token={self._token}"
            draining = False
            reconnect_after_s = reconnect_delay_s

            try:
                async with websockets.connect(url) as ws:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("Received non-JSON message, skipping")
                            continue

                        msg_type = msg.get("type")

                        if msg_type == "turn_event":
                            event_data = msg.get("event", msg)
                            yield TurnEvent.model_validate(event_data)

                        elif msg_type == "match/ended":
                            logger.info("Match ended: %s", msg.get("reason"))
                            return

                        elif msg_type == "DRAINING":
                            reconnect_ms = msg.get("reconnect_after_ms", 1000)
                            reconnect_after_s = reconnect_ms / 1000.0
                            logger.info(
                                "Server is draining; reconnecting after %.1fs", reconnect_after_s
                            )
                            draining = True
                            break  # close this connection and reconnect

                        else:
                            logger.debug("Ignored message type: %s", msg_type)

            except websockets.exceptions.ConnectionClosed as exc:
                logger.warning("WebSocket closed unexpectedly: %s", exc)
                if not draining:
                    # Unexpected close — apply exponential backoff
                    reconnect_delay_s = min(
                        reconnect_delay_s * 2, _DEFAULT_RECONNECT_MAX_DELAY_S
                    )
                    reconnect_after_s = reconnect_delay_s

            if draining or True:
                await asyncio.sleep(reconnect_after_s)
                # Reset backoff after a successful draining reconnect
                if draining:
                    reconnect_delay_s = _DEFAULT_RECONNECT_DELAY_S
                continue

            return  # pragma: no cover

    async def connect_as_agent(self, connect_token: str) -> websockets.WebSocketClientProtocol:
        """Open a WebSocket connection to participate as an agent.

        Uses the ``connect_token`` issued by the Gateway (single-use, TTL 5 min)
        to authenticate and bind to the match. The ``moltgame.v1`` sub-protocol
        is negotiated.

        Args:
            connect_token: Single-use token obtained from the Queue API or CLI.

        Returns:
            An open :class:`websockets.WebSocketClientProtocol` ready for MCP
            tool calls. The caller is responsible for closing the connection.

        Raises:
            :class:`~moltgames.exceptions.ConnectionError`: If the WebSocket
                handshake fails.
        """
        url = f"{self._base_url}/ws?connect_token={connect_token}"
        try:
            cm = websockets.connect(url, subprotocols=["moltgame.v1"])
            ws = await cm.__aenter__()
            return ws
        except Exception as exc:
            raise MoltgamesConnectionError(
                f"Failed to connect to {url}: {exc}"
            ) from exc
