import WebSocket from 'ws';
import type { MCPToolDefinition } from '@moltgames/mcp-protocol';

export interface ClientOptions {
  url: string;
  token?: string;
  sessionId?: string;
  protocol?: string;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export class Client {
  private socket: WebSocket | null = null;
  private tools: MCPToolDefinition[] = [];
  private sessionId: string | null = null;
  private reconnectDelayMs: number;

  constructor(private options: ClientOptions) {
    this.reconnectDelayMs = options.reconnectInitialDelayMs || 1000;
    this.sessionId = options.sessionId || null;
  }

  async connect(): Promise<void> {
    const url = new URL(this.options.url);
    if (this.sessionId) {
      url.searchParams.set('session_id', this.sessionId);
    } else if (this.options.token) {
      url.searchParams.set('connect_token', this.options.token);
    } else {
      throw new Error('Either token or sessionId must be provided');
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url.toString(), this.options.protocol || 'moltgame.v1');
      this.socket = socket;

      socket.on('open', () => {
        console.log('Connected to server');
        resolve();
      });

      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      });

      socket.on('close', (code, reason) => {
        console.log(`Disconnected (code: ${code}, reason: ${reason})`);
        this.socket = null;
        if (code !== 1000 && code !== 1001) {
          this.scheduleReconnect();
        }
      });

      socket.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const msg = message as Record<string, unknown>;
    switch (msg.type) {
      case 'session/ready':
        this.sessionId = msg.session_id;
        console.log(`Session ready: ${this.sessionId}`);
        break;
      case 'session/resumed':
        console.log('Session resumed');
        break;
      case 'tools/list':
        this.tools = msg.tools;
        console.log('Received tools:', this.tools.map((t) => t.name).join(', '));
        break;
      case 'tools/list_changed':
        this.tools = msg.tools;
        console.log('Tools updated:', this.tools.map((t) => t.name).join(', '));
        break;
      case 'match/ended':
        console.log('Match ended:', msg.reason);
        this.close();
        break;
      case 'DRAINING':
        console.log('Server is draining, reconnecting soon...');
        break;
      default:
        // Handle tool responses or other messages
        if (msg.status === 'ok' || msg.status === 'error') {
          console.log('Tool response:', msg);
        } else {
          console.log('Unhandled message:', msg);
        }
    }
  }

  private scheduleReconnect(): void {
    console.log(`Reconnecting in ${this.reconnectDelayMs}ms...`);
    setTimeout(() => {
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.options.reconnectMaxDelayMs || 8000,
      );
      this.connect().catch((err) => {
        console.error('Reconnection failed:', err.message);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
  }

  send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    } else {
      console.error('Cannot send: Socket not connected');
    }
  }

  callTool(name: string, requestId: string, args: Record<string, unknown>): void {
    this.send({
      tool: name,
      request_id: requestId,
      args,
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.close(1000, 'Client closing');
      this.socket = null;
    }
  }

  getAvailableTools(): MCPToolDefinition[] {
    return this.tools;
  }
}
