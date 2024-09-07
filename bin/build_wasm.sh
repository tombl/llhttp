#!/usr/bin/env bash

set -e

WASM_SRC="$(dirname "$0")/../"
WASM_OUT="$(dirname "$0")/../build/wasm"

cd "$WASM_SRC"

if [[ -z "$WASM_PLATFORM" && -n "$1" ]]; then
    WASM_PLATFORM=$(docker info -f "{{.OSType}}/{{.Architecture}}")
fi

case "$1" in
    --prebuild)
        exec docker build --platform="$WASM_PLATFORM" -t llhttp_wasm_builder . --load
        ;;
    --setup)
        mkdir -p build
        exit 0
        ;;
    --docker)
        cmd=(docker run --rm --platform="$WASM_PLATFORM")
        if [[ -z "$CI" ]]; then
            cmd+=(-it)
        fi
        # Try to avoid root permission problems on compiled assets
        # when running on linux.
        # It will work flawessly if uid === gid === 1000
        # there will be some warnings otherwise.
        if [[ "$(uname)" == Linux ]]; then
            cmd+=(--user "$(id -u):$(id -g)")
        fi
        cmd+=(--mount "type=bind,source=./build,target=/home/node/llhttp/build" llhttp_wasm_builder npm run wasm)

        echo "> ${cmd[*]}"
        exec "${cmd[@]}"
        ;;
esac

mkdir -p "$WASM_OUT"

npm run build

clang \
    --sysroot=/usr/share/wasi-sysroot \
    -target wasm32-unknown-wasi \
    -Ofast \
    -fno-exceptions \
    -fvisibility=hidden \
    -mexec-model=reactor \
    -Wl,-error-limit=0 \
    -Wl,-O3 \
    -Wl,--lto-O3 \
    -Wl,--strip-all \
    -Wl,--allow-undefined \
    -Wl,--export-dynamic \
    -Wl,--export-table \
    -Wl,--export=malloc \
    -Wl,--export=free \
    -Wl,--no-entry \
    build/c/*.c \
    src/native/*.c \
    -Ibuild \
    -o "$WASM_OUT/llhttp.wasm"

cp lib/llhttp/{constants,utils}.* "$WASM_OUT/"