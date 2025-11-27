# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install wget for health check
RUN apk add --no-cache wget

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built files from builder (includes dist/index.cjs and dist/public/)
COPY --from=builder /app/dist ./dist

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R node:node /app/data

# Use non-root user for security
USER node

# Set environment variables
ENV NODE_ENV=production
ENV PORT=45001
ENV DATA_DIR=/app/data

# Expose port
EXPOSE 45001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:45001/api/stats || exit 1

# Start the application
CMD ["node", "dist/index.cjs"]
