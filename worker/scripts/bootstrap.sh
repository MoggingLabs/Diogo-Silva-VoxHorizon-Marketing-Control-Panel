#!/usr/bin/env bash
# bootstrap.sh
# ----------------------------------------------------------------------------
# One-shot install + verify for the worker host.
# Works on:
#   - macOS (Diogo's production host) — uses Homebrew
#   - Linux / WSL2 Ubuntu (Pedro's dev host) — uses apt + user-local installers
#
# Covers:
#   - #3  Tailscale install + bring-up guidance
#   - #4  Claude Code install + auth verify
#   - #9  gog (Google Drive CLI) presence + auth verify (best-effort)
#   - #76 Hyperframes + headless Chromium install + smoke render
#   - dependencies: Node 22 (via nvm), pnpm, uv, yt-dlp, ffmpeg
#
# Idempotent: skip step if the tool/state is already present.
# Exits non-zero on the first failure so partial state is obvious.
#
# Usage:
#   cd <repo>
#   bash worker/scripts/bootstrap.sh
# ----------------------------------------------------------------------------
set -euo pipefail

log()  { printf "\033[1;34m[bootstrap]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ ok      ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[ warn    ]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[ fail    ]\033[0m %s\n" "$*"; exit 1; }

# --- detect platform ---------------------------------------------------------
OS_KIND="unknown"
case "$(uname -s)" in
  Darwin) OS_KIND="mac" ;;
  Linux)
    if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
      OS_KIND="wsl"
    else
      OS_KIND="linux"
    fi
    ;;
esac
log "Detected OS: $OS_KIND"
[[ "$OS_KIND" == "unknown" ]] && fail "Unsupported OS: $(uname -s)"

# --- pkg helpers -------------------------------------------------------------
pkg_install() {
  case "$OS_KIND" in
    mac)
      command -v brew >/dev/null 2>&1 || {
        log "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      }
      brew install "$@"
      ;;
    wsl|linux)
      if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y "$@"
      else
        warn "sudo not available without password. Run manually: sudo apt-get install -y $*"
      fi
      ;;
  esac
}

# --- 1. Node 22 via nvm ------------------------------------------------------
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  ok "nvm present"
else
  log "Installing nvm (user-local)..."
  curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" 2>/dev/null || true

# On WSL, nvm.sh sometimes prints "WSL 1 is not supported" even on WSL 2 — pass through.
NODE_BIN="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin"
if [[ -d "$NODE_BIN" ]] && [[ -x "$NODE_BIN/node" ]]; then
  CURRENT_MAJOR=$("$NODE_BIN/node" -p "process.versions.node.split('.')[0]")
fi
if [[ "${CURRENT_MAJOR:-0}" -ge 22 ]]; then
  ok "Node $("$NODE_BIN/node" --version) already installed"
else
  log "Installing Node 22..."
  nvm install 22 --no-progress
  NODE_BIN="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" | sort -V | tail -1)/bin"
fi
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"
# Mirror into ~/.local/bin so non-interactive shells pick it up
mkdir -p "$HOME/.local/bin"
for t in node npm npx corepack; do
  [[ -e "$NODE_BIN/$t" ]] && ln -sf "$NODE_BIN/$t" "$HOME/.local/bin/$t"
done
ok "node $(node --version), npm $(npm --version)"

# --- 2. pnpm via npm (corepack on Windows-interop Node is unreliable) -------
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm present ($(pnpm --version))"
else
  log "Installing pnpm via npm..."
  npm install -g pnpm
  [[ -e "$NODE_BIN/pnpm" ]] && ln -sf "$NODE_BIN/pnpm" "$HOME/.local/bin/pnpm"
fi

# --- 3. uv (Python project manager) -----------------------------------------
if command -v uv >/dev/null 2>&1; then
  ok "uv present ($(uv --version))"
else
  log "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# --- 4. yt-dlp + ffmpeg (b-roll scraping deps) ------------------------------
need_pkgs=()
command -v yt-dlp >/dev/null 2>&1 || need_pkgs+=("yt-dlp")
command -v ffmpeg  >/dev/null 2>&1 || need_pkgs+=("ffmpeg")
if (( ${#need_pkgs[@]} )); then
  log "Installing: ${need_pkgs[*]}"
  pkg_install "${need_pkgs[@]}"
fi
command -v yt-dlp >/dev/null 2>&1 && ok "yt-dlp present"
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg present"

# --- 5. Tailscale (#3) -------------------------------------------------------
case "$OS_KIND" in
  mac)
    if command -v tailscale >/dev/null 2>&1; then
      ok "tailscale present"
    else
      log "Installing Tailscale via Homebrew..."
      brew install tailscale
    fi
    if pgrep -x tailscaled >/dev/null 2>&1; then
      ok "tailscaled running"
    else
      warn "tailscaled not running. Run: sudo tailscaled install-system-daemon && sudo tailscale up --hostname=voxhorizon-worker --advertise-tags=tag:worker"
    fi
    ;;
  wsl)
    # On WSL, Tailscale runs as a Windows app. Check for the Windows binary.
    if [[ -x "/mnt/c/Program Files/Tailscale/tailscale.exe" ]]; then
      ok "Tailscale (Windows app) installed at C:\\Program Files\\Tailscale\\"
      warn "WSL talks to Tailscale over the Windows network. To reach tailnet hosts from WSL, just use their tailnet hostnames — no extra setup."
      warn "If you want a Tailscale-Funnel URL for this worker to expose to Vercel, run from a Windows PowerShell: \"& 'C:\\Program Files\\Tailscale\\tailscale.exe' funnel 8000\""
    else
      warn "Tailscale not found on Windows. Install from https://tailscale.com/download/windows"
    fi
    ;;
  linux)
    if command -v tailscale >/dev/null 2>&1; then
      ok "tailscale present"
    else
      log "Installing Tailscale (Linux)..."
      curl -fsSL https://tailscale.com/install.sh | sh
    fi
    ;;
esac

# --- 6. Claude Code (#4) -----------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code present"
else
  log "Installing Claude Code..."
  npm i -g @anthropic-ai/claude-code
  [[ -e "$NODE_BIN/claude" ]] && ln -sf "$NODE_BIN/claude" "$HOME/.local/bin/claude"
fi
# Auth probe (just check the config dir; a real probe `claude -p ping` may consume credits/usage)
if [[ -d "$HOME/.claude" ]]; then
  ok "Claude Code config dir exists"
else
  warn "Claude Code is installed but not yet authenticated. Run: claude auth login"
fi

# --- 7. gog (Google Drive CLI) (#9) -----------------------------------------
if command -v gog >/dev/null 2>&1; then
  ok "gog present"
  if gog drive ls --account diogo@voxhorizon.com --parent 15WwyDWgVOxoqqj5QxjXR8tS354WQZ0go >/dev/null 2>&1; then
    ok "gog can list the marketing dept Drive folder"
  else
    warn "gog installed but auth is missing/expired. Run: gog drive auth --account diogo@voxhorizon.com"
  fi
else
  warn "gog not installed. This is normally shipped by the upstream Hermes runtime."
  warn "Skip during local Windows/WSL dev — Diogo's Mac already has it via Hermes."
fi

# --- 8. Hyperframes + Playwright Chromium (#76) -----------------------------
# Hyperframes is published as the bare `hyperframes` package on npm.
# Install globally so `npx hyperframes ...` works from anywhere.
if command -v hyperframes >/dev/null 2>&1; then
  ok "hyperframes present ($(hyperframes --version 2>&1 | head -1))"
else
  log "Installing hyperframes globally..."
  npm i -g hyperframes
  [[ -e "$NODE_BIN/hyperframes" ]] && ln -sf "$NODE_BIN/hyperframes" "$HOME/.local/bin/hyperframes"
fi

# Playwright Chromium for the renderer. Install in a scratch project so we get
# a persistent browser cache, but don't bother with a full Hyperframes scaffold.
HF_DIR="$HOME/.voxhorizon/playwright-cache"
mkdir -p "$HF_DIR"
if [[ ! -f "$HF_DIR/package.json" ]]; then
  log "Bootstrapping Playwright cache project at $HF_DIR..."
  (cd "$HF_DIR" && pnpm init >/dev/null 2>&1 && pnpm add playwright >/dev/null 2>&1)
fi

# Detect existing Chromium install
HAS_CHROMIUM=false
if [[ "$OS_KIND" == "mac" ]] && [[ -d "$HOME/Library/Caches/ms-playwright" ]]; then
  HAS_CHROMIUM=true
elif [[ -d "$HOME/.cache/ms-playwright" ]]; then
  HAS_CHROMIUM=true
fi

if [[ "$HAS_CHROMIUM" == "true" ]]; then
  ok "Playwright Chromium cache exists"
else
  if [[ "$OS_KIND" == "mac" ]]; then
    (cd "$HF_DIR" && pnpm exec playwright install chromium 2>&1 | tail -3)
  else
    # On Linux/WSL, --with-deps tries `apt-get install`; needs sudo
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      (cd "$HF_DIR" && pnpm exec playwright install --with-deps chromium 2>&1 | tail -3)
    else
      warn "Playwright Chromium system deps need sudo. Doing chromium-only install (may need libs to run)."
      (cd "$HF_DIR" && pnpm exec playwright install chromium 2>&1 | tail -3) || true
      warn "If render fails on WSL: sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64"
    fi
  fi
fi
ok "Hyperframes + Chromium ready"

# --- 9. Summary --------------------------------------------------------------
log ""
log "================================================================"
log "Bootstrap complete on: $OS_KIND"
log ""
log "Next steps:"
if [[ "$OS_KIND" == "wsl" ]]; then
  log "  - Tailscale: use the existing Windows app at C:\\Program Files\\Tailscale"
  log "  - Tailscale Funnel (to expose worker to Vercel): see Windows PowerShell snippet above"
else
  log "  - Tailscale: sudo tailscale up --hostname=voxhorizon-worker --advertise-tags=tag:worker"
fi
log "  - Claude Code: claude auth login  (if config dir missing)"
log "  - Drive (gog): gog drive auth --account diogo@voxhorizon.com  (Mac only — gog ships with Hermes)"
log "  - Hermes secrets: bash worker/scripts/import-hermes-secrets.sh"
log "  - Worker: cd worker && uv sync --extra dev && bash scripts/serve.sh"
log "================================================================"
