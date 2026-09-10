# The BROWSER BUILD: src/web bundled into two single files.
#
#   dist/logos-web.mjs  an ES module, for `import` from a page or a worker
#   dist/logos-web.js   an IIFE exposing a `LogosWeb` global, for a <script> tag
#                       and for the Wasm host's glue, which has no loader
#
# esbuild with --platform=browser is also the GATE on the browser build staying
# browser code: src/web/node-channel.js is the only file under src/web that
# touches a Node builtin, nothing in the entry reaches it, and if that ever
# changes this derivation fails to resolve `node:...` rather than shipping a
# bundle that throws in a page.
{ pkgs, src, version ? "2.0.0" }:

pkgs.stdenv.mkDerivation {
  pname = "logos-js-sdk-web-bundle";
  inherit version src;

  nativeBuildInputs = [ pkgs.esbuild ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    mkdir -p dist
    esbuild src/web/index.mjs --bundle --platform=browser --target=es2020 \
      --format=esm --outfile=dist/logos-web.mjs
    esbuild src/web/index.js --bundle --platform=browser --target=es2020 \
      --format=iife --global-name=LogosWeb --outfile=dist/logos-web.js
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r dist $out/dist
    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "logos-js-sdk browser build (lp_* consumer + provider over a message channel)";
    platforms = platforms.all;
  };
}
