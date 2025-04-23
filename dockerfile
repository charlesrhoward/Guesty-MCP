# syntax=docker/dockerfile:1

# -------- Stage 1 : install prod dependencies --------
FROM node:20-alpine AS deps
WORKDIR /app

# Install only production dependencies declared in package.json / package-lock.json
COPY package*.json ./
RUN npm ci --omit=dev

# -------- Stage 2 : copy source & run --------
FROM node:20-alpine
WORKDIR /app

# Copy installed node_modules from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the application source code
COPY guesty-mcp-server.js ./
COPY .env.example ./.env.example

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Create a default .env file to prevent errors (values to be overridden at runtime)
RUN echo "# Default placeholder values - override these when deploying" > .env \
    && echo "GUESTY_CLIENT_ID=placeholder" >> .env \
    && echo "GUESTY_CLIENT_SECRET=placeholder" >> .env

# Expose port for health checks & ingress
EXPOSE 3000

# Configure healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://localhost:$PORT/health || exit 1

# Start the server
CMD ["node", "guesty-mcp-server.js"]