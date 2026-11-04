declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    MCP_BRIDGE_URL?: string;
    MCP_BRIDGE_TOKEN?: string;
  }
}
