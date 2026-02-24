import asyncio
import json
import websockets
import logging

logger = logging.getLogger(__name__)

class MoltgameClient:
    def __init__(self, url, token=None, session_id=None):
        self.url = url
        self.token = token
        self.session_id = session_id
        self.ws = None
        self.tools = []

    async def connect(self):
        url = self.url
        if self.session_id:
            url += f"?session_id={self.session_id}"
        elif self.token:
            url += f"?connect_token={self.token}"
        else:
            raise ValueError("Either token or session_id must be provided")

        async for websocket in websockets.connect(url, subprotocols=["moltgame.v1"]):
            self.ws = websocket
            logger.info("Connected to Moltgame server")
            try:
                async for message in websocket:
                    await self._handle_message(message)
            except websockets.ConnectionClosed:
                logger.warning("Connection closed, reconnecting...")
                continue

    async def _handle_message(self, message_str):
        try:
            message = json.loads(message_str)
            msg_type = message.get("type")
            
            if msg_type == "session/ready":
                self.session_id = message.get("session_id")
                logger.info(f"Session ready: {self.session_id}")
            elif msg_type == "tools/list" or msg_type == "tools/list_changed":
                self.tools = message.get("tools", [])
                logger.info(f"Tools updated: {[t.get('name') for t in self.tools]}")
            elif msg_type == "match/ended":
                logger.info(f"Match ended: {message.get('reason')}")
                await self.close()
            # Add more handlers as needed
        except Exception as e:
            logger.error(f"Error handling message: {e}")

    async def call_tool(self, tool_name, request_id, args):
        if not self.ws:
            raise RuntimeError("Not connected")
        
        payload = {
            "tool": tool_name,
            "request_id": request_id,
            "args": args
        }
        await self.ws.send(json.dumps(payload))

    async def close(self):
        if self.ws:
            await self.ws.close()
            self.ws = None
