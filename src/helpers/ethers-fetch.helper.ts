import { FetchRequest } from "ethers";

// Ethers v6 uses Node's https module (HTTP/1.1) by default. Some ALB/WAF
// configurations block HTTP/1.1, so we override the transport to use the
// global fetch API (undici, HTTP/2) which is available in Node 18+.
FetchRequest.registerGetUrl(async (req, signal) => {
  const abort = new AbortController();
  if (signal) {
    if (signal.cancelled) abort.abort();
    signal.addListener(() => abort.abort());
  }

  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.body ?? undefined,
    signal: abort.signal,
  });

  const body = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers,
    body,
  };
});
