# Builds the Windows installer into dist/release (run from anywhere; CI runs it on a v* tag):
#   yadbc-win-Setup.exe     per-user install into %LocalAppData%\yadbc: no admin, Start menu + desktop
#                           shortcuts, an entry in Apps for uninstalling. Running a newer one updates.
#   yadbc-win-Portable.zip  the same app without installing: unzip anywhere and run yadbc.exe
# The app is self-contained (no .NET to install); Setup installs the WebView2 runtime if it's missing.
param([string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

function Run([string]$exe) {
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$exe $args failed ($LASTEXITCODE)" }
}

Push-Location (Join-Path $root 'web')
try {
    if (-not (Test-Path node_modules)) { Run npm ci }
    Run npx ng build
} finally { Pop-Location }

Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
Run dotnet publish (Join-Path $root 'src/Yadbc.Host') -c Release -r win-x64 --self-contained `
    "-p:Version=$Version" -o (Join-Path $dist 'publish')

Push-Location $root
try {
    Run dotnet tool restore
    Run dotnet vpk pack --packId yadbc --packVersion $Version --runtime win-x64 --packTitle yadbc --packAuthors 'Jan Svimbersky' `
        --packDir (Join-Path $dist 'publish') --mainExe Yadbc.Host.exe --icon src/Yadbc.Host/yadbc.ico `
        --framework webview2 --outputDir (Join-Path $dist 'release')
} finally { Pop-Location }
Get-ChildItem (Join-Path $dist 'release') | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
