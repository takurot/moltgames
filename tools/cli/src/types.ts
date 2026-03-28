/** Credentials stored in ~/.moltgames/credentials.json */
export interface Credentials {
  idToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
}

/** Standard REST API error response */
export interface ApiError {
  code: string;
  message: string;
  retryable?: boolean;
}

/** Standard REST API response envelope */
export interface ApiResponse<T = unknown> {
  status: 'ok' | 'error';
  data?: T;
  message?: string;
}

/** Match entity */
export interface Match {
  matchId: string;
  gameId: string;
  status: string;
  participants: Array<{ uid: string; agentId: string; role: string }>;
  createdAt: string;
  updatedAt?: string;
  winner?: string;
}

/** Leaderboard entry */
export interface LeaderboardEntry {
  uid: string;
  agentId?: string;
  rating: number;
  rank: number;
  wins: number;
  losses: number;
}

/** Leaderboard */
export interface Leaderboard {
  seasonId: string;
  entries: LeaderboardEntry[];
  updatedAt: string;
}

/** Rating */
export interface Rating {
  uid: string;
  seasonId: string;
  rating: number;
  wins: number;
  losses: number;
  updatedAt: string;
}

/** Queue status */
export interface QueueStatus {
  position?: number;
  estimatedWaitMs?: number;
  matchId?: string;
  connectToken?: string;
  status: 'waiting' | 'matched' | 'not_in_queue';
}

/** Device auth response */
export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Token exchange response */
export interface TokenResponse {
  id_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}
