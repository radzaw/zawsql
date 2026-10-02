# Builds self-contained single-file executables of ZawSQL.
# Usage: ./publish.ps1 [-Runtimes win-x64,linux-x64,osx-arm64] [-FrameworkDependent]
param(
    [string[]]$Runtimes = @('win-x64', 'linux-x64', 'linux-arm64', 'osx-x64', 'osx-arm64'),
    [switch]$FrameworkDependent
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'src/ZawSQL/ZawSQL.csproj'
foreach ($rid in $Runtimes) {
    $out = Join-Path $PSScriptRoot "dist/$rid"
    Write-Host "Publishing $rid -> $out" -ForegroundColor Cyan
    dotnet publish $project -c Release -r $rid -o $out `
        --self-contained $(if ($FrameworkDependent) { 'false' } else { 'true' }) `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none
    if ($LASTEXITCODE -ne 0) { throw "Publishing $rid failed" }
}
