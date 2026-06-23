/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serve the existing vanilla client (public/index.html) at the root path.
  async rewrites() {
    return [{ source: "/", destination: "/index.html" }];
  },
};

export default nextConfig;
