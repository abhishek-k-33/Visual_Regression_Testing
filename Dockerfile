# ==============================================================================
# Visual Regression Testing & CI Tool - Standardized Container Environment
# Base Image: Microsoft Playwright Official Container (Chromium + Ubuntu Noble)
# Ensures 100% deterministic font kerning & sub-pixel rendering across macOS, Windows, Linux
# ==============================================================================

FROM mcr.microsoft.com/playwright:v1.50.1-noble

# Set working directory
WORKDIR /app

# Install standard Linux typography packages to guarantee cross-OS rendering consistency
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-color-emoji \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package.json package-lock.json ./

# Install dependencies (better-sqlite3 compiles native bindings during install)
RUN npm ci

# Copy application source code and configuration
COPY src/ ./src/
COPY visual.config.json ./

# Initialize storage directories
RUN mkdir -p /app/storage/baselines /app/storage/runs

# Environment defaults
ENV NODE_ENV=production
ENV PORT=4000
# Listen on all interfaces inside the container so the published port works
ENV HOST=0.0.0.0

# Expose Web Review Dashboard port
EXPOSE 4000

# Default action: start the Web Review Dashboard server
CMD ["node", "src/server/app.js"]
