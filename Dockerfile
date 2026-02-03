# Build Stage
FROM node:18-slim AS builder

WORKDIR /app

# Copy all source files (Backend + Frontend)
COPY . .

# Install dependencies and Build (using the combined build script in root package.json)
RUN npm install
RUN npm run build

# Production Stage
FROM node:18-slim

WORKDIR /app

# Copy built backend and its production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

# Copy built frontend
COPY --from=builder /app/client/dist ./client/dist

# Expose port (Backend defaults to 3001, Railway uses environment PORT)
EXPOSE 3001

# Start the unified server
CMD ["node", "dist/server.js"]
