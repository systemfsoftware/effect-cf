{
  description = "Effect-native primitives for Cloudflare Workers and Durable Objects, published as the effect-cf and effect-webtransport packages.";


  inputs = {
    core.url = "github:systemfsoftware/systemfsoftware/15b4d2ab1e2af0a154fad2b9af7bd1f6449b3606";
    nixpkgs.follows = "core/nixpkgs";
    pnpm-release-management.url = "github:systemfsoftware/pnpm-release-management/3da32f4fa6f01af0a9a0cdab5cc8eb5d134b2de3";
  };

  outputs = { self, nixpkgs, pnpm-release-management, ... }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = fn: lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});

      workspaceOf = pkgs:
        pnpm-release-management.lib.mkPnpmWorkspacePackages {
          inherit pkgs;
          src = self;
          pname = "effect-cf";
          pnpm = pkgs.pnpm_12;
        };
    in
    {
      packages = forEachSystem (pkgs: workspaceOf pkgs);

      checks = forEachSystem (pkgs: {
        consumer-store = pnpm-release-management.lib.mkPnpmConsumerStore {
          inherit pkgs;
          src = self;
          pname = "effect-cf";
          pnpm = pkgs.pnpm_12;
        };
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_26
            pkgs.pnpm_12
          ];
        };
      });
    };
}
