FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built files
COPY dist ./dist

# Set environment
ENV NODE_ENV=production
ENV HOSTED_MODE=true

# Expose port (if needed for HTTP endpoint)
EXPOSE 3000

# Run the server
CMD ["node", "dist/index.js"]
