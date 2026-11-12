# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy source and config files
COPY . .

# Build the project
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from the builder stage
COPY --from=builder /app/dist ./dist

# Expose the application port
EXPOSE 3001


# Start the application
CMD ["npm", "start"]
