export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = any>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  // Only set application/json when there's actually a body. Fastify rejects
  // requests that declare a JSON content-type but send an empty body with 400,
  // which broke buttons like Run/Stop/Restart that POST without a body.
  const hasBody = opts.body !== undefined && opts.body !== null;
  const headers: Record<string, string> = { ...(opts.headers as any || {}) };
  if (hasBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers,
    credentials: "include",
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText;
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

export const API = {
  get: <T = any>(p: string) => api<T>(p),
  post: <T = any>(p: string, data?: any) =>
    api<T>(p, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T = any>(p: string, data?: any) =>
    api<T>(p, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  delete: <T = any>(p: string) => api<T>(p, { method: "DELETE" }),
};
