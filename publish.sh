#!/usr/bin/env sh
# Builds self-contained single-file executables of ZawSQL.
# Usage: ./publish.sh [rid ...]      e.g. ./publish.sh linux-x64 win-x64
set -e
cd "$(dirname "$0")"
RIDS=${*:-"win-x64 linux-x64 linux-arm64 osx-x64 osx-arm64"}
for rid in $RIDS; do
  echo "Publishing $rid -> dist/$rid"
  dotnet publish src/ZawSQL/ZawSQL.csproj -c Release -r "$rid" -o "dist/$rid" \
    --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none
done
