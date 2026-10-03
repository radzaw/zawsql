# Builds self-contained single-file executables of ZawSQL.
# Usage: ./publish.ps1 [-Runtimes win-x64,linux-x64,osx-arm64] [-FrameworkDependent] [-Version 1.2.0]
param(
    [string[]]$Runtimes = @('win-x64', 'linux-x64', 'linux-arm64', 'osx-x64', 'osx-arm64'),
    [switch]$FrameworkDependent,
    [string]$Version = $env:VERSION
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'src/ZawSQL/ZawSQL.csproj'
$extra = @()
if ($Version) { $extra += "-p:Version=$Version" }
foreach ($rid in $Runtimes) {
    $out = Join-Path $PSScriptRoot "dist/$rid"
    Write-Host "Publishing $rid -> $out" -ForegroundColor Cyan
    dotnet publish $project -c Release -r $rid -o $out `
        --self-contained $(if ($FrameworkDependent) { 'false' } else { 'true' }) `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none @extra
    if ($LASTEXITCODE -ne 0) { throw "Publishing $rid failed" }
}
