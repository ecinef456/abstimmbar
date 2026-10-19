# Production image: builds the SPA and bundles it with the Django backend.
# The backend copies /app/frontend_dist into a shared volume for Caddy to
# serve directly (see docker-compose.prod.yml) — this image is the single
# versioned artifact for a release; Caddy itself does no building.

FROM node:22-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ .
# Optional build-time override of the in-app guide link (see docs/deployment.md).
ARG VITE_GUIDE_URL
ARG VITE_GUIDE_URL_EN
RUN npm run build

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# System dependencies: psycopg build deps + gettext (for compilemessages)
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev gcc gettext \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=frontend-build /frontend/dist /app/frontend_dist

EXPOSE 8000

CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
