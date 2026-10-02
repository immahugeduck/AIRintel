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

# Public (browser-safe) build-time configuration. Vite inlines these into the bundle.
# Never pass secrets here. Values come from Cloud Build substitutions (see cloudbuild.yaml).
ARG VITE_MAPBOX_ACCESS_TOKEN=""
ARG VITE_MAPBOX_STYLE="mapbox/streets-v12"
ARG VITE_NEON_AUTH_URL=""
ARG VITE_AIRCRAFT_API_URL=""
ARG VITE_HISTORY_API_URL=""
ARG VITE_PROFILE_API_URL=""
ENV VITE_MAPBOX_ACCESS_TOKEN=$VITE_MAPBOX_ACCESS_TOKEN \
    VITE_MAPBOX_STYLE=$VITE_MAPBOX_STYLE \
    VITE_NEON_AUTH_URL=$VITE_NEON_AUTH_URL \
    VITE_AIRCRAFT_API_URL=$VITE_AIRCRAFT_API_URL \
    VITE_HISTORY_API_URL=$VITE_HISTORY_API_URL \
    VITE_PROFILE_API_URL=$VITE_PROFILE_API_URL

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
