/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep ffmpeg-static out of the server bundle so its binary path resolves
  // correctly at runtime (the package points at a native binary in node_modules).
  serverExternalPackages: ["ffmpeg-static"],
};

export default nextConfig;
