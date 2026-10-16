/**
 * @fileoverview Cloud Run Production Server for Pisto Open-Source Personal Finance Manager.
 *
 * Features:
 * - Listens on process.env.PORT || 8080 (Google Cloud Run standard)
 * - Serves static ES2025+ modules & modern CSS from /public
 * - Exposes token-optimized Firebase Genkit endpoints (/api/ai/*)
 * - Graceful SIGTERM shutdown for Cloud Run container lifecycle
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import {
  executeSmartParse,
  executeFinancialInsights,
  getAiTelemetryStatus,
} from './ai/genkitFlows.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// Load .env if present (Node 20.6+ native or fallback parser)
await loadEnvFileIfPresent(path.resolve(__dirname, '../.env'));

const PORT = Number.parseInt(process.env.PORT || '8080', 10);

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
});

/**
 * Loads environment variables from a .env file without requiring external packages if not installed.
 * @param {string} envPath
 */
async function loadEnvFileIfPresent(envPath) {
  try {
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env file is optional in Cloud Run (injected via environment variables)
  }
}

/**
 * Sets standard security headers for all responses.
 * @param {http.ServerResponse} res
 */
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Sends a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 */
function sendJson(res, statusCode, payload) {
  applySecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * Reads and parses a JSON request body with a strict 32KB size cap to prevent abuse and token bloat.
 * @param {http.IncomingMessage} req
 * @returns {Promise<Record<string, any>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const MAX_BYTES = 32 * 1024;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BYTES) {
        reject(new Error('Payload demasiado grande (máximo 32KB para optimización de tokens).'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON inválido en la solicitud.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Main HTTP request handler.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
export async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Cloud Run Healthcheck
  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'pisto-personal-finance',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  // 2. Genkit & Token Optimizer Status
  if (req.method === 'GET' && pathname === '/api/ai/status') {
    return sendJson(res, 200, getAiTelemetryStatus());
  }

  // 3. On-Demand Genkit NLP Transaction Parser
  if (req.method === 'POST' && pathname === '/api/ai/parse') {
    try {
      const body = await readJsonBody(req);
      const headerKey = String(req.headers['x-gemini-api-key'] || '').trim();
      const apiKey = headerKey || String(body.apiKey || '').trim() || undefined;
      const result = await executeSmartParse({
        text: body.text,
        categories: body.categories,
        apiKey,
      });
      return sendJson(res, 200, { ok: true, ...result, telemetry: getAiTelemetryStatus() });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }
  }

  // 4. On-Demand Genkit Financial Advisor (Micro-Payload)
  if (req.method === 'POST' && pathname === '/api/ai/insights') {
    try {
      const body = await readJsonBody(req);
      const headerKey = String(req.headers['x-gemini-api-key'] || '').trim();
      const apiKey = headerKey || String(body.apiKey || '').trim() || undefined;
      const result = await executeFinancialInsights({
        compactPayload: body.compactPayload,
        lang: body.lang || 'es',
        apiKey,
      });
      return sendJson(res, 200, { ok: true, ...result, telemetry: getAiTelemetryStatus() });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }
  }

  // 5. Static File Serving from /public (with native TypeScript type-stripping for .ts modules)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const safeRelative = path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(PUBLIC_DIR, safeRelative);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }

    try {
      const stat = await fs.stat(filePath);
      const targetFile = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      if (ext === '.ts' && typeof stripTypeScriptTypes === 'function') {
        const tsSource = await fs.readFile(targetFile, 'utf8');
        const jsOutput = stripTypeScriptTypes(tsSource);
        applySecurityHeaders(res);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(req.method === 'HEAD' ? undefined : jsOutput);
        return;
      }

      const content = await fs.readFile(targetFile);

      applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
      return;
    } catch {
      // SPA Fallback to index.html for navigation routes
      if (!path.extname(pathname)) {
        try {
          const indexContent = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
          applySecurityHeaders(res);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexContent);
          return;
        } catch {
          // Fallthrough to 404
        }
      }
      return sendJson(res, 404, { error: 'Recurso no encontrado' });
    }
  }

  return sendJson(res, 405, { error: 'Método no permitido' });
}

// Start server only when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const server = http.createServer(handleRequest);

  server.listen(PORT, '0.0.0.0', () => {
    const status = getAiTelemetryStatus();
    console.log(`🚀 Pisto Open-Finance ejecutándose en http://localhost:${PORT}`);
    console.log(`⚡ Motor Genkit (${status.model}): ${status.genkitConfigured ? 'ACTIVO (GEMINI_API_KEY detectada)' : 'MODO 0-TOKENS LOCAL (Sin GEMINI_API_KEY)'}`);
  });

  // Cloud Run Graceful Shutdown
  const shutdown = (signal) => {
    console.log(`\n[${signal}] Cerrando servidor de forma segura...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
