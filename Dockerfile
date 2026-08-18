# Stage 1: Build the React application
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve the app using Nginx
FROM nginx:alpine
# Copy built files from Stage 1. 
# NOTE: If your app uses Vite, change 'build' to 'dist'. If standard Create React App, keep 'build'.
COPY --from=builder /app/build /usr/share/nginx/html

# Copy our custom Nginx config that listens on port 8080
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
