#!/usr/bin/env bash
# [DOC: oracle-weights]
set -euo pipefail

DCE=https://raw.githubusercontent.com/Li-Chongyi/Zero-DCE_extension/09f202b690f82da939b8e6ec8535960ae97ad8bd/Zero-DCE%2B%2B/snapshots_Zero_DCE%2B%2B/Epoch99.pth
DCE_SHA=ca8855b90df9a80fa4195a831f33d3476b1964f787eb70602797c773067f3b84
VIT=https://huggingface.co/opencv/opencv_zoo/resolve/39a1451d0f9b23fc4ebaed06a277127efa0374d0/models/object_tracking_vittrack/object_tracking_vittrack_2023sep.onnx
VIT_SHA=2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d

fetch() {
  echo "$2  $3" | sha256sum -c --status 2>/dev/null && return 0
  sudo curl -fsSL --create-dirs -o "$3" "$1"
  echo "$2  $3" | sha256sum -c
}

fetch "$DCE" "$DCE_SHA" /opt/repair/zerodce.pth
fetch "$VIT" "$VIT_SHA" /opt/track/vittrack.onnx
