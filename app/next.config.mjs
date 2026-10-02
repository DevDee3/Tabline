/** @type {import('next').NextConfig} */
const nextConfig = {
  // @tabline/sdk is an npm workspace package (symlinked from ../sdk, TS source not pre-built) -- Next skips
  // transpiling node_modules by default, so it has to be listed explicitly here.
  transpilePackages: ["@tabline/sdk"],
};

export default nextConfig;
