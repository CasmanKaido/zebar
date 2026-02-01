# Build Stage
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files for root (Backend)
COPY package*.json ./
COPY tsconfig.json ./

# Install backend dependencies
RUN npm install

# Copy backend source
COPY src/ ./src/

# Build Backend
RUN npm run build

# Copy package files for client (Frontend)
WORKDIR /app/client
COPY client/package*.json ./
COPY client/tsconfig*.json ./

# Install frontend dependencies
RUN npm install

# Copy frontend source and configs
COPY client/ ./

# Build Frontend
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
