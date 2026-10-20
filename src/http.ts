export class HttpError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves with the parsed JSON body; rejects with HttpError on non-2xx or network failure. */
export type GetJson = (
  url: string,
  params?: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<any>;

export const iinaGetJson: GetJson = async (url, params = {}, headers = {}) => {
  // No URLSearchParams: the plugin runs in a bare JavaScriptCore context without Web APIs.
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const describe = `GET ${url}${query ? "?" + query : ""}`;
  let res: IINA.HTTPResponse;
  try {
    res = await iina.http.get(url, { params, headers, data: {} });
  } catch (error) {
    // iina.http rejects with the response object ({ statusCode, reason, text }) for non-2xx.
    const failed = error as Partial<IINA.HTTPResponse> | undefined;
    const status = typeof failed?.statusCode === "number" ? failed.statusCode : undefined;
    const reason = failed?.reason ?? String(error);
    throw new HttpError(status, `${describe} failed: ${status ?? "network error"} ${reason}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new HttpError(res.statusCode, `${describe} returned invalid JSON`);
  }
};

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}
