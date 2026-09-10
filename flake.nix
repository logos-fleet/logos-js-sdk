{
  description = "logos-js-sdk — the Logos JavaScript SDK: a protocol-native Node build (lp_* over koffi) and a browser build (the web transport over a message channel)";

  inputs = {
    logos-nix.url = "github:logos-co/logos-nix";
    nixpkgs.follows = "logos-nix/nixpkgs";

    # ── the protocol ────────────────────────────────────────────────────────
    # logos-protocol is the WEB TRANSPORT: LogosProtocol::Web, a transport host
    # and connection carrying the plain transport's message set as JSON over an
    # injected message channel. The browser build speaks that wire in
    # JavaScript, and test/web-shim links this to prove it against a real C++
    # provider rather than against a JS imitation of one.
    logos-protocol.url = "github:logos-fleet/logos-protocol";
    logos-protocol.inputs.logos-nix.follows = "logos-nix";

    # A SECOND protocol build, for one job: the Node SDK's provider half.
    #
    # lp_provider_register() on protocol master stores its callbacks and serves
    # nothing — lp_provider_emit_event / lp_provider_save_token return
    # LP_ERR_UNSUPPORTED and no socket is ever opened — so test/e2e.js's
    # provider child needs the branch where the C ABI actually serves. The
    # CONSUMER half of that test, and every part of the browser build, runs
    # against the input above; test/e2e.js takes the two builds separately
    # (LOGOS_E2E_PROVIDER_LIB) for exactly this reason, so a failure is
    # attributable to a half rather than to "the protocol".
    #
    # It is NOT named `logos-protocol-something` by accident: the workspace
    # retargets an input by NAME, and the whole point of this one is to stay on
    # its own branch until the provider ABI lands. Delete it then; nothing else
    # in this flake changes.
    protocol-with-serving-provider.url = "github:logos-co/logos-protocol/feat/protocol-shared-lib";
    protocol-with-serving-provider.inputs.logos-nix.follows = "logos-nix";

    # ── the LIDL frontend ───────────────────────────────────────────────────
    # The shared liblogos_lidl_c exposes lidl_parse_to_json, so codegen reuses
    # the one true grammar instead of reimplementing it in JS. Pinned to the
    # branch that adds the shared-lib target, and named off `logos-lidl` for the
    # same reason as above — re-pin and rename after that branch merges.
    lidl-with-shared-c-abi.url = "github:logos-fleet/logos-lidl/feat/shared-c-abi-lib";
    lidl-with-shared-c-abi.inputs.logos-nix.follows = "logos-nix";
  };

  outputs = { self, nixpkgs, logos-nix, logos-protocol, protocol-with-serving-provider, lidl-with-shared-c-abi }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = import nixpkgs { inherit system; };
      });
      ext = system: if nixpkgs.lib.hasSuffix "darwin" system then "dylib" else "so";

      # The shared liblogos_protocol lives in a different attribute depending on
      # which logos-protocol this is pinned to:
      #   - the provider-ABI stack exposes a dedicated `logos-protocol-shared`
      #     package (the shared target is behind an option there);
      #   - master builds the shared target unconditionally and installs it into
      #     the ordinary `logos-protocol` package.
      # Resolving with `or` means re-pinning either input is a ONE-LINE change.
      sharedOf = flake: system:
        let p = flake.packages.${system};
        in p.logos-protocol-shared or p.logos-protocol;
    in
    {
      packages = forAllSystems ({ system, pkgs }: {
        # The browser build. `nix build .#web-bundle` → dist/logos-web.{mjs,js}
        web-bundle = import ./nix/web-bundle.nix { inherit pkgs; src = ./.; };
        default = import ./nix/web-bundle.nix { inherit pkgs; src = ./.; };

        # The C++ provider on the web transport, bridged to stdio. Useful on its
        # own: point any browser-side experiment at it.
        web-shim = import ./nix/web-shim.nix {
          inherit pkgs;
          src = ./test/web-shim;
          logosProtocol = logos-protocol.packages.${system}.logos-protocol;
        };
      });

      checks = forAllSystems ({ system, pkgs }:
        let
          e = ext system;
          webBundle = import ./nix/web-bundle.nix { inherit pkgs; src = ./.; };
          webShim = import ./nix/web-shim.nix {
            inherit pkgs;
            src = ./test/web-shim;
            logosProtocol = logos-protocol.packages.${system}.logos-protocol;
          };
          lidlShared = lidl-with-shared-c-abi.packages.${system}.logos-lidl;
          providerProtocol = sharedOf protocol-with-serving-provider system;
        in
        {
          # ── the Node build ────────────────────────────────────────────────
          # A Node provider (child process) and consumer exchange calls + events
          # over plain TCP, plus a .lidl→JS codegen round trip — no
          # liblogos_core, no Qt loop. koffi's prebuilt binary ships in the npm
          # package, so no native build is needed inside the sandbox.
          e2e = pkgs.buildNpmPackage {
            pname = "logos-js-sdk-e2e";
            version = "2.0.0";
            src = ./.;
            npmDepsHash = "sha256-CDPBw5lbbuSOkXN7qbkhKcCHTiQ5kN/pdI+JMHPwTgc=";
            dontNpmBuild = true;
            doCheck = true;
            # koffi's prebuilt .node needs libstdc++ resolvable at load time on
            # Linux (nix has no default lib path); harmless on Darwin.
            buildInputs = [ pkgs.stdenv.cc.cc.lib ];
            checkPhase = ''
              runHook preCheck
              export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export LOGOS_PROTOCOL_LIB=${providerProtocol}/lib/liblogos_protocol.${e}
              export LOGOS_LIDL_LIB=${lidlShared}/lib/liblogos_lidl_c.${e}
              node test/e2e.js
              runHook postCheck
            '';
            installPhase = "mkdir -p $out; touch $out/e2e-passed";
          };

          # ── the browser build, JS on both ends ────────────────────────────
          # A JS provider and a JS consumer over a real MessageChannel: async
          # call, object result, {_bytes}, introspection, event, sync call. No
          # native library and no npm dependency is involved at all, which is
          # the point — the browser build's whole dependency is a channel.
          web-e2e = pkgs.runCommand "logos-js-sdk-web-e2e"
            { nativeBuildInputs = [ pkgs.nodejs ]; }
            ''
              cp -r ${./.}/src ${./.}/test .
              chmod -R u+w src test
              node test/web-e2e.js
              mkdir -p $out; touch $out/web-e2e-passed
            '';

          # ── the browser build, against the C++ web transport ──────────────
          # The bundled consumer, loaded in a browser-only context, calling a
          # C++ provider published on logos::web::WebTransportHost through a
          # channel shim — plus a typed client generated from calc.lidl driving
          # that same consumer. koffi is needed here only by the codegen leg
          # (liblogos_lidl_c), never by the browser build.
          web-bundle-e2e = pkgs.buildNpmPackage {
            pname = "logos-js-sdk-web-bundle-e2e";
            version = "2.0.0";
            src = ./.;
            npmDepsHash = "sha256-CDPBw5lbbuSOkXN7qbkhKcCHTiQ5kN/pdI+JMHPwTgc=";
            dontNpmBuild = true;
            doCheck = true;
            buildInputs = [ pkgs.stdenv.cc.cc.lib ];
            checkPhase = ''
              runHook preCheck
              export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export LOGOS_WEB_BUNDLE_DIR=${webBundle}/dist
              export LOGOS_WEB_SHIM=${webShim}/bin/logos-web-shim
              export LOGOS_LIDL_LIB=${lidlShared}/lib/liblogos_lidl_c.${e}
              node test/web-bundle-e2e.js
              runHook postCheck
            '';
            installPhase = "mkdir -p $out; touch $out/web-bundle-e2e-passed";
          };
        }
      );

      devShells = forAllSystems ({ system, pkgs }:
        let
          e = ext system;
          lidlShared = lidl-with-shared-c-abi.packages.${system}.logos-lidl;
          providerProtocol = sharedOf protocol-with-serving-provider system;
          webShim = import ./nix/web-shim.nix {
            inherit pkgs;
            src = ./test/web-shim;
            logosProtocol = logos-protocol.packages.${system}.logos-protocol;
          };
        in
        {
          default = pkgs.mkShell {
            nativeBuildInputs = [ pkgs.nodejs pkgs.esbuild ];
            shellHook = ''
              export LOGOS_PROTOCOL_LIB="${providerProtocol}/lib/liblogos_protocol.${e}"
              export LOGOS_LIDL_LIB="${lidlShared}/lib/liblogos_lidl_c.${e}"
              export LOGOS_WEB_SHIM="${webShim}/bin/logos-web-shim"
              echo "logos-js-sdk dev shell — node $(node --version)"
              echo "  LOGOS_PROTOCOL_LIB=$LOGOS_PROTOCOL_LIB"
              echo "  LOGOS_LIDL_LIB=$LOGOS_LIDL_LIB"
              echo "  LOGOS_WEB_SHIM=$LOGOS_WEB_SHIM"
              echo "  run: npm ci && npm test           (Node build, needs a serving provider ABI)"
              echo "       node test/web-e2e.js         (browser build, JS <-> JS)"
              echo "       npm run build:web && node test/web-bundle-e2e.js"
            '';
          };
        }
      );
    };
}
