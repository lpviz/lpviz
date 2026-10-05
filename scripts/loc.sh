#!/bin/sh
# Line counts by area, the same way every time. Run from the repo root.
cd "$(dirname "$0")/.." || exit 1
count() { git ls-files "$@" | xargs cat 2>/dev/null | wc -l | tr -d ' '; }
ts_src() { git ls-files "$@" | grep -E '\.ts$' | grep -v '\.test\.ts$' | xargs cat 2>/dev/null | wc -l | tr -d ' '; }
printf '%-40s %7s\n' "area" "lines"
for area in packages/solver-engine/src packages/math/src packages/polytope/src packages/viewport/src apps/web/src/features apps/web/src/app apps/web/src/three apps/web/src/ui; do
  printf '%-40s %7s\n' "$area" "$(ts_src "$area")"
done
printf '%-40s %7s\n' "non-test TS total" "$(git ls-files | grep -E '\.ts$' | grep -v '\.test\.ts$' | xargs cat | wc -l | tr -d ' ')"
printf '%-40s %7s\n' "tests" "$(git ls-files | grep -E '\.test\.ts$' | xargs cat | wc -l | tr -d ' ')"
printf '%-40s %7s\n' "apps/web/src/style.css" "$(count apps/web/src/style.css)"
printf '%-40s %7s\n' "public/docs (html+css)" "$(count 'public/docs/*')"
