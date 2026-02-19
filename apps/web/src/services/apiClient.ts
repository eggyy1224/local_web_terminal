export const DEFAULT_GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE ?? "http://127.0.0.1:8787";

export function createApiClient(baseUrl = DEFAULT_GATEWAY_BASE) {
  return async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API ${path} failed: ${body}`);
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error(`API ${path} returned invalid JSON: ${String(error)}`);
    }
  };
}
