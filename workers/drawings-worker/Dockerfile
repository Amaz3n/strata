# Use Node 20 on Debian Bookworm (stable LTS)
FROM node:20-bookworm-slim

# Install system dependencies for PDF processing
RUN apt-get update && apt-get install -y \
    # MuPDF for PDF rendering (recommended)
    mupdf-tools \
    # Poppler as alternative (also works well)
    poppler-utils \
    # Image processing dependencies for Sharp
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application
COPY dist/ ./dist/

# Create non-root user
RUN useradd --create-home --shell /bin/bash worker
USER worker

# Health check (optional)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('Worker healthy')"

# Start the worker
CMD ["node", "dist/index.js"]