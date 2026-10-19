export const API_RESOURCES = ['payments', 'customers', 'api_keys'] as const;
export type ApiResource = (typeof API_RESOURCES)[number];
export type ApiAction = 'read' | 'write';

export const FULL_ACCESS = '*';
export const API_SCOPES = [
  FULL_ACCESS,
  ...API_RESOURCES.flatMap((resource) => [`${resource}:read`, `${resource}:write`]),
] as const;

export function resourceForRoute(routeUrl: string | undefined): ApiResource | undefined {
  const segment = routeUrl?.split('/')[2]?.replace(/-/g, '_');
  return API_RESOURCES.find((resource) => resource === segment);
}

export function actionForMethod(method: string): ApiAction {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

export function isAllowed(
  scopes: readonly string[],
  resource: ApiResource,
  action: ApiAction,
): boolean {
  if (scopes.includes(FULL_ACCESS)) return true;
  if (scopes.includes(`${resource}:write`)) return true;
  return action === 'read' && scopes.includes(`${resource}:read`);
}
