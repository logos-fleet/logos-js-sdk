cmake_minimum_required(VERSION 3.16)
project(logos-web-shim CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC OFF)

find_package(Qt6 REQUIRED COMPONENTS Core)
find_package(logos-protocol REQUIRED CONFIG
    PATHS ${LOGOS_PROTOCOL_ROOT}/lib/cmake/logos-protocol
    NO_DEFAULT_PATH)

add_executable(logos-web-shim main.cpp)

# WebTransportHost is reached directly rather than through the transport
# factory, because attaching a channel to a HOST is not something the factory
# can express: a web host is handed channels, never dialled. Its header is not
# in the installed include set (the factory is the supported door), so this
# consumer reads it from logos-protocol's SOURCE EXPORT — the same
# $out/include/cpp/... layout logos-cpp-sdk re-exports.
target_include_directories(logos-web-shim PRIVATE
    ${LOGOS_PROTOCOL_ROOT}/include
    ${LOGOS_PROTOCOL_ROOT}/include/cpp
    ${LOGOS_PROTOCOL_ROOT}/include/cpp/implementations/plain
    ${LOGOS_PROTOCOL_ROOT}/include/cpp/implementations/web
)

target_link_libraries(logos-web-shim PRIVATE
    logos-protocol::logos_protocol
    Qt6::Core
)

install(TARGETS logos-web-shim RUNTIME DESTINATION bin)
