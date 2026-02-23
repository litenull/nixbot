{
  description = "NanoClaw-inspired agent isolation using nix-bwrapper";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-bwrapper.url = "github:Naxdy/nix-bwrapper";
  };

  outputs = { self, nixpkgs, nix-bwrapper }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ nix-bwrapper.overlays.default ];
      };

      agentTools = with pkgs; [
        bashInteractive
        coreutils
        curl
        jq
        git
        ripgrep
        fd
        bat
        findutils
        gnused
        gawk
        gnugrep
        nodejs
        chromium
        which
      ];

      headlessSandbox = pkgs.writeShellScriptBin "run-in-sandbox" ''
        #!${pkgs.bash}/bin/bash
        set -euo pipefail
        
        COMMAND="$*"
        WORKSPACE="''${WORKSPACE:-$HOME/.bwrapper/nanix/workspace}"
        
        mkdir -p "$WORKSPACE"
        
        exec ${pkgs.bubblewrap}/bin/bwrap \
          --unshare-all \
          --share-net \
          --die-with-parent \
          --new-session \
          --ro-bind /nix/store /nix/store \
          --proc /proc \
          --dev /dev \
          --tmpfs /tmp \
          --tmpfs /run \
          --ro-bind /etc/resolv.conf /etc/resolv.conf \
          --ro-bind /etc/ssl/certs /etc/ssl/certs \
          --bind "$WORKSPACE" /workspace \
          --setenv PATH "${pkgs.lib.makeBinPath agentTools}" \
          --setenv HOME /workspace \
          --setenv CHROMIUM_FLAGS "--no-sandbox --disable-setuid-sandbox" \
          --chdir /workspace \
          -- \
          ${pkgs.bash}/bin/bash -c "$COMMAND"
      '';

      guiSandbox = pkgs.mkBwrapper {
        app = {
          package = pkgs.stdenv.mkDerivation {
            pname = "browser-agent";
            version = "0.1.0";
            src = ./.;
            installPhase = ''
              mkdir -p $out/bin $out/share/applications
              cat > $out/bin/browser-agent << 'SCRIPT'
#!/bin/sh
cd "$HOME/.bwrapper/nanix/workspace" 2>/dev/null || cd "$HOME"
exec $SHELL
SCRIPT
              chmod +x $out/bin/browser-agent
              cat > $out/share/applications/browser-agent.desktop << 'DESKTOP'
[Desktop Entry]
Type=Application
Name=Browser Agent
Exec=browser-agent
Terminal=true
Categories=Development;
DESKTOP
            '';
            meta.mainProgram = "browser-agent";
          };
          runScript = "browser-agent";
          addPkgs = with pkgs; [ chromium nodejs ];
        };
        sockets = { x11 = true; pulseaudio = false; pipewire = false; };
        mounts.readWrite = [ "$HOME/.bwrapper/nanix/workspace" ];
      };

    in {
      packages.${system} = {
        default = headlessSandbox;
        sandbox = headlessSandbox;
        gui-sandbox = guiSandbox;
      };

      apps.${system} = {
        sandbox = {
          type = "app";
          program = "${headlessSandbox}/bin/run-in-sandbox";
        };
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ nodejs nodePackages.npm typescript tsx headlessSandbox ];
        
        shellHook = ''
          export NANIX_SANDBOX_BIN="${headlessSandbox}/bin/run-in-sandbox"
          export NANIX_GROUPS_DIR="$PWD/groups"
          export NANIX_DATA_DIR="$PWD/data"
          
          echo ""
          echo "Nanix Development Environment"
          echo "─────────────────────────────"
          echo "Sandbox: ${headlessSandbox}/bin/run-in-sandbox"
          echo "Run: npm run dev"
          echo ""
        '';
      };
    };
}
