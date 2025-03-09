import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CLAUDE.md is the vault-authored master copy (see its header); don't let
  // `next dev` append its auto-generated agent-rules block to it.
  // Next 16 bundles its own docs at node_modules/next/dist/docs/.
  agentRules: false,
};

export default nextConfig;
