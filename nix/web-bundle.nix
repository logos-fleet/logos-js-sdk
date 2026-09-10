# The BROWSER BUILD: src/web bundled into two single files.
#
#   dist/logos-web.mjs  an ES module, for `import` from a page or a worker
#   dist/logos-web.js   an IIFE exposing a `LogosWeb` global, for a <script> tag
#                       and for the Wasm host's glue, which has no loader
#
# The esbuild invocation is package.json's `build:web`, run here rather than
# copied, so the bundle a developer hand-tests and the one the checks validate
# are built by the same command. Its --platform=browser is also the GATE on the
# browser build staying browser code: src/web/node-channel.js is the only file
# under src/web that touches a Node builtin, nothing in the entry reaches it,
# and if that ever changes this derivation fails to resolve `node:...` rather
# than shipping a bundle that throws in a page.
#
# `src` is the whole package; only src/web and package.json are read, so the
# bundle is rebuilt only when they change.
{ pkgs, src, version ? "2.0.0" }:

pkgs.stdenv.mkDerivation {
  pname = "logos-js-sdk-web-bundle";
  inherit version;
  src = pkgs.lib.fileset.toSource {
    root = src;
    fileset = pkgs.lib.fileset.unions [ (src + "/src/web") (src + "/package.json") ];
  };

  nativeBuildInputs = [ pkgs.nodejs pkgs.esbuild ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR   # npm wants somewhere to put its cache and logs
    npm run build:web
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
