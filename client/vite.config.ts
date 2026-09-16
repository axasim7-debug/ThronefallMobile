import { defineConfig } from "vite";

// The client talks to the authoritative .NET server over /ws. Proxying it in
// dev keeps the connection same-origin, so the client code is identical in
// development and in production (where the server serves the built client).
//
// Start the server first: dotnet run --project server/Thronefall.Api
export default defineConfig({
  server: {
    proxy: {
      "/ws": {
        target: process.env.THRONEFALL_SERVER ?? "http://127.0.0.1:5246",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
