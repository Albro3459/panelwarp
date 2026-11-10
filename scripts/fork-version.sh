#!/bin/bash
# Prints the version for a build of this fork: package.json's version plus the commit it was built
# from, like 0.1.18-fork.g21753e3. The g keeps an all-digit hash valid semver.
#   scripts/fork-version.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "$(node -p 'require("./package.json").version')-fork.g$(git rev-parse --short HEAD)"
