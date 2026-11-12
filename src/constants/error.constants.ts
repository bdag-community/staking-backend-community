export const STATUS_CODES = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
};

export const ERROR_MESSAGES = {
  SOMETHING_WENT_WRONG: "Something went wrong",
  BLOCKCHAIN_DECODE_ERROR: "Blockchain response could not be decoded.",
  BLOCKCHAIN_FETCH_ERROR:
    "Failed to fetch data from the blockchain. Node might be out of sync.",
  BLOCKCHAIN_NETWORK_ERROR: "Blockchain network is currently unreachable.",
  MISSING_PARAM: (key: string) => `Missing required parameter: ${key}`,
  MISSING_PARAMS: (params: string[]) =>
    `Missing required parameters: ${params.join(", ")}`,
  INVALID_ADDRESS: (key: string, value: string) =>
    `Invalid Ethereum address provided for ${key}: ${value}`,
  TOO_MANY_ATTEMPTS: (path: string) =>
    `Too many attempts for ${path.split("/").pop()}. Please try again in a minute.`,
};
