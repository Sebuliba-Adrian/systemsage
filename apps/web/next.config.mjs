/** @type {import('next').NextConfig} */
const nextConfig = {
  // Our workspace packages ship raw TypeScript (no build step of their own),
  // so Next has to transpile them itself rather than treating them as
  // pre-built node_modules.
  transpilePackages: ['@systemsage/engine', '@systemsage/lesson-planner', '@systemsage/narrator'],
};

export default nextConfig;
