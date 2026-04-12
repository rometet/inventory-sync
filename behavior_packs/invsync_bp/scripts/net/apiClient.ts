import {
  HttpHeader,
  HttpRequest,
  HttpRequestMethod,
  type HttpResponse,
  http,
} from "@minecraft/server-net";
import {
  type ApiOkResponse,
  type InventoryAuditRecordAction,
  type InventoryAuditRecordRequest,
  type IdentityType,
  type InventoryLoadResponse,
  type InventorySaveResponse,
  type InventorySnapshot,
  type InventoryStatusResponse,
  isApiOkResponse,
  isInventoryLoadResponse,
  isInventorySaveResponse,
  isInventoryStatusResponse,
} from "../domain/types";
import { config } from "../util/config";

type ApiErrorKind =
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "invalid_json"
  | "network"
  | "unexpected_status";

export class ApiClientError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  get playerMessage(): string {
    switch (this.kind) {
      case "timeout":
        return "API リクエストがタイムアウトしました。";
      case "unauthorized":
        return "API 認証に失敗しました。";
      case "not_found":
        return "保存済みのインベントリスナップショットが見つかりません。";
      case "rate_limited":
        return "API のレート制限に達しました。少し待ってから再試行してください。";
      case "server_error":
        return "API 側でサーバーエラーが発生しました。";
      case "invalid_json":
        return "API 応答の形式が不正です。";
      case "network":
      case "unexpected_status":
      default:
        return "API リクエストに失敗しました。";
    }
  }
}

function toTimeoutSeconds(requestTimeoutMs: number): number {
  return Math.max(1, Math.ceil(requestTimeoutMs / 1000));
}

function buildUrl(path: string, query?: Record<string, string>): string {
  const trimmedBaseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;

  if (!query || Object.keys(query).length === 0) {
    return `${trimmedBaseUrl}${trimmedPath}`;
  }

  const queryString = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  return `${trimmedBaseUrl}${trimmedPath}?${queryString}`;
}

function createRequest(
  method: HttpRequestMethod,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): HttpRequest {
  const request = new HttpRequest(buildUrl(path, query));
  request.method = method;
  request.timeout = toTimeoutSeconds(config.requestTimeoutMs);
  request.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("Authorization", `Bearer ${config.apiToken}`),
  ];

  if (body !== undefined) {
    request.body = JSON.stringify(body);
  }

  return request;
}

function mapStatusError(response: HttpResponse): ApiClientError {
  switch (response.status) {
    case 401:
    case 403:
      return new ApiClientError("unauthorized", "Inventory API rejected the bearer token.", response.status);
    case 404:
      return new ApiClientError("not_found", "Inventory API route or resource was not found.", response.status);
    case 429:
      return new ApiClientError("rate_limited", "Inventory API rate limit was reached.", response.status);
    default:
      if (response.status >= 500) {
        return new ApiClientError("server_error", "Inventory API returned a server error.", response.status);
      }

      return new ApiClientError("unexpected_status", "Inventory API returned an unexpected HTTP status.", response.status);
  }
}

function parseJson<T>(response: HttpResponse, validator: (value: unknown) => value is T): T {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new ApiClientError("invalid_json", "Inventory API response body was not valid JSON.", response.status);
  }

  if (!validator(payload)) {
    throw new ApiClientError("invalid_json", "Inventory API response body shape was invalid.", response.status);
  }

  return payload;
}

async function sendRequest<T>(request: HttpRequest, validator: (value: unknown) => value is T): Promise<T> {
  let response: HttpResponse;

  try {
    response = await http.request(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      throw new ApiClientError("timeout", message);
    }

    throw new ApiClientError("network", message);
  }

  if (response.status < 200 || response.status >= 300) {
    throw mapStatusError(response);
  }

  return parseJson(response, validator);
}

export async function saveSnapshot(snapshot: InventorySnapshot): Promise<InventorySaveResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Post, "/api/inventory/save", snapshot),
    isInventorySaveResponse,
  );
}

export async function backupSnapshotBeforeLoad(snapshot: InventorySnapshot): Promise<InventorySaveResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Post, "/api/inventory/backup-before-load", snapshot),
    isInventorySaveResponse,
  );
}

export async function loadSnapshot(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<InventoryLoadResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Get, "/api/inventory/load", undefined, {
      namespace,
      identityType,
      playerKey,
    }),
    isInventoryLoadResponse,
  );
}

export async function loadBackupSnapshot(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<InventoryLoadResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Get, "/api/inventory/load", undefined, {
      namespace,
      identityType,
      playerKey,
      source: "backup",
    }),
    isInventoryLoadResponse,
  );
}

export async function fetchSnapshotStatus(
  namespace: string,
  identityType: IdentityType,
  playerKey: string,
): Promise<InventoryStatusResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Get, "/api/inventory/status", undefined, {
      namespace,
      identityType,
      playerKey,
    }),
    isInventoryStatusResponse,
  );
}

function buildAuditRecordRequest(
  action: InventoryAuditRecordAction,
  snapshot: InventorySnapshot,
): InventoryAuditRecordRequest {
  return {
    action,
    namespace: snapshot.namespace,
    identityType: snapshot.identityType,
    playerKey: snapshot.playerKey,
    occurredAt: new Date().toISOString(),
    snapshotId: snapshot.snapshotId,
    snapshotSavedAt: snapshot.savedAt,
    source: snapshot.source,
    executedSource: {
      serverId: config.serverId,
      worldId: config.worldId,
      worldName: config.worldName,
    },
  };
}

export async function recordLoadApplied(snapshot: InventorySnapshot): Promise<ApiOkResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Post, "/api/inventory/audit/load", buildAuditRecordRequest("load", snapshot)),
    isApiOkResponse,
  );
}

export async function recordLoadBackupApplied(snapshot: InventorySnapshot): Promise<ApiOkResponse> {
  return sendRequest(
    createRequest(HttpRequestMethod.Post, "/api/inventory/audit/load", buildAuditRecordRequest("load_backup", snapshot)),
    isApiOkResponse,
  );
}
