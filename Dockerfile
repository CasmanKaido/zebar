# Build Stage
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production Stage
FROM node:18-slim

WORKDIR /app

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Expose port (Backend defaults to 3001)
EXPOSE 3001

# Start the bot
CMD ["node", "dist/server.js"]
