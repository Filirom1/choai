{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    bun
    nodejs
    git
  ];

  shellHook = ''
    echo "choai development shell"
    echo "Run: cd apps/web && bun install && bun run dev"
  '';
}
