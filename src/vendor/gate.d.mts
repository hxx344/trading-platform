// 复制自 project-aggregation 工作台 server/exchange-transport/gate.d.mts（提交 255a9a3），未改动。
export type GateCredentials = { apiKey: string; apiSecret: string };
/** path includes /api/v4; query is the exact encoded query without '?'; timestamp is in seconds. */
export function gateAuthHeaders(credentials: GateCredentials, request: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; path: string; query?: string; body?: string; timestamp: string;
}): { KEY: string; Timestamp: string; SIGN: string };
