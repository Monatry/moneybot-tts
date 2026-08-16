#!/bin/sh
# Fetch the model files on first start, then hand off to the server.
#
# They live on a bind mount rather than in the image so a rebuild does not
# re-download ~350 MB.
set -eu

BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODEL_PATH="${MODEL_PATH:-/models/kokoro-v1.0.onnx}"
VOICES_PATH="${VOICES_PATH:-/models/voices-v1.0.bin}"

fetch() {
	url="$1"
	dest="$2"
	[ -s "$dest" ] && return 0
	echo "fetching $(basename "$dest") ..."
	mkdir -p "$(dirname "$dest")"
	# Download beside the target so an interrupted run cannot leave a
	# truncated file that looks complete on the next start.
	curl -fL --retry 3 -o "$dest.part" "$url"
	mv "$dest.part" "$dest"
}

fetch "$BASE/kokoro-v1.0.onnx" "$MODEL_PATH"
fetch "$BASE/voices-v1.0.bin" "$VOICES_PATH"

exec "$@"
