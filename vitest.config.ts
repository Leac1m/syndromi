import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/server"],
    // The Surfpool fork tests stall when they hit the fork concurrently from a cold cache
    // (Surfpool 1.6 remote fetches time out); run files one at a time.
    fileParallelism: false,
  },
});
