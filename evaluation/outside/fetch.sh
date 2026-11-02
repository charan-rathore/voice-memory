#!/usr/bin/env bash
# Fetches the two outside-authored datasets for evaluation/outside-bench.mjs
# into .cache/outside (not committed), pinned to the commits benchmarked.
#   QMSum (Zhong et al., NAACL 2021; MIT): real meeting transcripts (AMI,
#     ICSI, Welsh Parliament committees) with annotator-written queries and
#     the transcript turns that answer them.
#   CUAD v1 (Hendrycks et al., NeurIPS 2021; CC BY 4.0): real commercial
#     contracts from SEC EDGAR, with lawyer-annotated clause spans for 41
#     question types, including "not in this contract".
set -euo pipefail
dir="${1:-.cache/outside}"
mkdir -p "$dir"
fetch() { # repo sha dest
  if [ ! -d "$dir/$3/.git" ]; then git clone -q https://github.com/$1.git "$dir/$3"; fi
  git -C "$dir/$3" fetch -q --depth 1 origin "$2" 2>/dev/null || true
  git -C "$dir/$3" checkout -q "$2"
}
fetch Yale-LILY/QMSum 83d7768c1f2b4dfeb091385d3dc7e239b8e5bb7e QMSum
fetch TheAtticusProject/cuad 67faa0e6023b04fcaae6cc09497ab00e5d63a2a2 cuad
[ -f "$dir/cuad-data/test.json" ] || (mkdir -p "$dir/cuad-data" && unzip -o -q "$dir/cuad/data.zip" -d "$dir/cuad-data")
echo "outside data ready in $dir"
