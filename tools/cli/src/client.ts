import { EventEmitter } from 'node:events';
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

export class Client extends EventEmitter {
  private socket: WebSocket | null = null;
  private tools: MCPToolDefinition[] = [];
  private sessionId: string | null = null;
  private reconnectDelayMs: number;
  private reconnecting: boolean = false;

  constructor(private options: ClientOptions) {
    super();
    this.reconnectDelayMs = options.reconnectInitialDelayMs || 1000;
    this.sessionId = options.sessionId || null;
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

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
        this.reconnecting = false;
        this.reconnectDelayMs = this.options.reconnectInitialDelayMs || 1000;
        this.emit('connected');
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
        this.emit('disconnected', { code, reason });
        
        if (code !== 1000 && code !== 1001) {
          this.scheduleReconnect();
        }
      });

      socket.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.emit('error', error);
        reject(error);
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = message as any;
    switch (msg.type) {
      case 'session/ready':
        this.sessionId = msg.session_id as string;
        console.log(`Session ready: ${this.sessionId}`);
        this.emit('session/ready', msg);
        break;
      case 'session/resumed':
        console.log('Session resumed');
        this.emit('session/resumed', msg);
        break;
      case 'tools/list':
        this.tools = msg.tools as MCPToolDefinition[];
        console.log('Received tools:', this.tools.map((t) => t.name).join(', '));
        this.emit('tools/list', this.tools);
        break;
      case 'tools/list_changed':
        this.tools = msg.tools as MCPToolDefinition[];
        console.log('Tools updated:', this.tools.map((t) => t.name).join(', '));
        this.emit('tools/list_changed', this.tools);
        break;
      case 'match/ended':
        console.log('Match ended:', msg.reason as string);
        this.emit('match/ended', msg);
        this.close();
        break;
      case 'DRAINING': {
        const delay = msg.reconnect_after_ms || 1000;
        console.log(`Server is draining, reconnecting after ${delay}ms...`);
        this.reconnectDelayMs = delay;
        this.emit('draining', msg);
        break;
      }
      default:
        // Handle tool responses or other messages
        if (msg.status === 'ok' || msg.status === 'error') {
          console.log('Tool response:', msg);
          this.emit('tool_response', msg);
        } else {
          console.log('Unhandled message:', msg);
        }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    console.log(`Reconnecting in ${this.reconnectDelayMs}ms...`);
    setTimeout(() => {
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.options.reconnectMaxDelayMs || 8000,
      );
      this.connect()
        .then(() => {
          this.reconnecting = false;
        })
        .catch((err) => {
          console.error('Reconnection failed:', err.message);
          this.reconnecting = false;
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
