export interface BackendConfig {
  baseUrl: string;
  token: string;
}

export function getBackendConfig(): BackendConfig | null {
  const baseUrl = process.env.BACKEND_API_BASE_URL;
  const token = process.env.BACKEND_API_TOKEN;
  if (!baseUrl || !token) {
    return null;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export function getBackendBaseUrl(): string | null {
  const baseUrl = process.env.BACKEND_API_BASE_URL;
  if (!baseUrl) {
    return null;
  }
  return baseUrl.replace(/\/+$/, "");
}
