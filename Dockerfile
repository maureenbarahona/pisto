# -----------------------------------------------------------------------------
# Pisto — Open-Finance & Control Financiero Personal — Cloud Run Production Dockerfile
# -----------------------------------------------------------------------------
FROM node:22-alpine AS base

# Set working directory
WORKDIR /usr/src/app

# Set production environment and default Cloud Run port
ENV NODE_ENV=production
ENV PORT=8080

# Install dependencies with clean cache
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source code
COPY index.html ./index.html
COPY src ./src
COPY server ./server
COPY public ./public

# Use non-root user for security best practices
USER node

# Expose Cloud Run default port
EXPOSE 8080

# Healthcheck for container orchestrators
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

# Start server
CMD ["node", "server/index.js"]
