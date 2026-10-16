#!/usr/bin/env bash
# =============================================================================
# Script de Despliegue Automatizado en Google Cloud Run — Pisto — Open-Finance & Control Financiero Personal
# =============================================================================
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-one-money-finance}"
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ Error: Google Cloud SDK (gcloud) no está instalado en este equipo."
  echo ""
  echo "Instálalo en Ubuntu/Debian ejecutando:"
  echo "  sudo snap install google-cloud-cli --classic"
  echo "o visita: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "⚠️  No hay un PROJECT_ID activo en gcloud."
  echo "Ejecuta primero:"
  echo "  gcloud auth login"
  echo "  gcloud config set project TU_PROJECT_ID"
  exit 1
fi

echo "🚀 Desplegando '${SERVICE_NAME}' en el proyecto '${PROJECT_ID}' (región: ${REGION})..."

echo "1️⃣ Habilitando APIs necesarias (Cloud Run, Cloud Build, Artifact Registry)..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project="${PROJECT_ID}"

ENV_VARS="NODE_ENV=production,GENKIT_MODEL=${GENKIT_MODEL:-gemini-2.5-flash},GENKIT_MAX_OUTPUT_TOKENS=${GENKIT_MAX_OUTPUT_TOKENS:-250}"
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  ENV_VARS="${ENV_VARS},GEMINI_API_KEY=${GEMINI_API_KEY}"
fi

echo "2️⃣ Construyendo contenedor y publicando en Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "${ENV_VARS}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
echo ""
echo "✅ ¡Sitio publicado exitosamente en Google Cloud Run!"
echo "🌐 URL pública: ${SERVICE_URL}"
