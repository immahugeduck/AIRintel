# ==========================================
# Stage 1: Build the Vite static assets
# ==========================================
FROM node:24-alpine AS builder

WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package*.json ./

# Install development & production dependencies 
# (npm ci is preferred for deterministic CI/CD builds)
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Build the static site (generates the /app/dist directory)
RUN npm run build

# ==========================================
# Stage 2: Serve the assets using Nginx
# ==========================================
FROM nginx:alpine

# Copy the built static files from Stage 1 to Nginx's default public directory
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy a custom Nginx configuration to support Single Page Application (SPA) routing 
# and dynamically listen on the Cloud Run $PORT environment variable
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Cloud Run defaults to port 8080
ENV PORT=8080
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
