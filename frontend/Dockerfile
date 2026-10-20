FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
# Use `npm ci` (clean install strictly from the lockfile): it reliably installs
# the platform-specific optional dependencies (e.g. @rollup/rollup-linux-x64-gnu
# needed by `vite build`), which `npm install` can silently skip (npm/cli#4828).
RUN npm ci

COPY . .

EXPOSE 5174

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5174"]
