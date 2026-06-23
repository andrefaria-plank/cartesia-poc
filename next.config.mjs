/** @type {import('next').NextConfig} */
const nextConfig = {
  // The voice client + SSE/upload API are served by the custom Express server
  // (src/server.ts). Next only owns the /login page and its assets.
  reactStrictMode: true,
};

export default nextConfig;
