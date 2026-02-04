# ==========================================
# Stage 1: Build Frontend
# ==========================================
FROM node:20-alpine AS frontend
WORKDIR /app/client

# Copy frontend manifest and install dependencies
COPY client/package*.json ./
RUN npm install

# Copy source and build
COPY client/ ./
RUN npm run build

# ==========================================
# Stage 2: Build Backend & Runner
# ==========================================
FROM node:20-alpine
WORKDIR /app

# Copy root manifest and install backend dependencies
COPY package*.json ./
RUN npm install

# Copy TypeScript config and source code
COPY tsconfig.json ./
COPY src ./src

# Build Backend (TSC -> dist/)
# Note: We run tsc directly or via a specific script if needed. 
# The root 'build' script installs client too, which we want to avoid re-doing.
# So we assume 'npx tsc' works fine given dependencies are installed.
RUN npx tsc

# Copy built frontend assets from Stage 1 -> /app/client/dist
# This matches the expected path in server.ts: path.join(__dirname, "../client/dist")
COPY --from=frontend /app/client/dist ./client/dist

# Expose the application port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production

# Start the server using the compiled JS
CMD ["node", "dist/server.js"]
