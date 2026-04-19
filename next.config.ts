import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WebXR requires HTTPS. Next.js 13.5+ supports --experimental-https
  // We'll also disable server-side rendering for Three.js components if needed
  // using dynamic imports in page.tsx
};

export default nextConfig;
