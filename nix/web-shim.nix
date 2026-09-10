# logos-web-shim — a C++ module published on the WEB transport, reachable over
# stdio. The far end of the browser SDK's e2e (test/web-bundle-e2e.js); see
# test/web-shim/main.cpp for what a "channel shim" is and why this exists.
#
# It links logos-protocol's STATIC archive, like every other out-of-process
# consumer: this is its own process, so its own copy of the runtime singletons
# is the correct one.
{ pkgs, src, logosProtocol }:

pkgs.stdenv.mkDerivation {
  pname = "logos-web-shim";
  version = "1.0.0";

  inherit src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.pkg-config
    pkgs.qt6.wrapQtAppsNoGuiHook
  ];

  buildInputs = [
    pkgs.qt6.qtbase
    # logos-protocolConfig.cmake re-resolves the whole link interface of the
    # static archive (find_dependency Qt6 Core + RemoteObjects, Boost, OpenSSL,
    # nlohmann_json), so every one of them has to be findable here even though
    # this program's own code touches none but Qt Core.
    pkgs.qt6.qtremoteobjects
    pkgs.boost
    pkgs.openssl
    pkgs.nlohmann_json
    logosProtocol
  ];

  cmakeFlags = [
    "-GNinja"
    "-DLOGOS_PROTOCOL_ROOT=${logosProtocol}"
  ];

  meta = with pkgs.lib; {
    description = "C++ provider on the Logos web transport, bridged to stdio";
    platforms = platforms.unix;
  };
}
