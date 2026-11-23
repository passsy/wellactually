// Vitest global setup: write the embedded SDK source before any test file loads the core.
export async function setup() {
  await import("./embed-sdk.mjs");
}
