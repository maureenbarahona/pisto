# 🇭🇳 Pisto: Open-Finance para Catrachos

**Pisto** es una plataforma web *open-source* de finanzas personales diseñada específicamente para la realidad económica de los hondureños. Combina una arquitectura **Local-First** (tus datos son tuyos y privados) con asistencia inteligente impulsada por **Firebase Genkit IA**, optimizada para el consumo eficiente de tokens.

### ✨ Características Principales

* 🇭🇳 **100% Adaptado al Contexto Catracho:** Gestión nativa de lempiras (HNL) y dólares (USD), ideal para monitorear cuentas de bancos locales (Banco Atlántida, BAC Credomatic, Ficohsa, etc.), efectivo y tarjetas de crédito.
* 🔒 **Local-First & Privacidad:** Control total de tus finanzas sin comprometer la privacidad de tu información financiera.
* 🤖 **Asistencia Inteligente con Firebase Genkit IA:** Análisis financiero y presupuestos asistidos por IA, con optimización avanzada de tokens.
* 💳 **Gestión Integral de Patrimonio:** Monitorea cuentas bancarias, billeteras, deudas, préstamos a cuotas (0%) y metas de ahorro en tiempo real.
* ⚡ **Diseño Moderno & Clean Code:** Interfaz oscura, rápida, intuitiva y pensada para la mejor experiencia de usuario.

---

### 🚀 Instalación y Ejecución Local

#### 📋 Requisitos Previos
* **Node.js** `>= 20.0.0` (recomendado v22 LTS)
* **npm** (incluido con Node.js)
* *(Opcional)* Una clave de API de **Google Gemini** (`GEMINI_API_KEY`) para habilitar el motor de IA con Firebase Genkit. Si no se configura, Pisto funciona en **Modo 0-Tokens Local** usando su motor determinista integrado.

#### 1. Clonar el repositorio
```bash
git clone https://github.com/tu-usuario/pisto.git
cd pisto
```

#### 2. Instalar dependencias
```bash
npm install
```

#### 3. Configurar variables de entorno *(Opcional)*
Crea un archivo `.env` en la raíz del proyecto si deseas personalizar el puerto o activar las funciones de IA con Gemini:

```env
PORT=8080
GEMINI_API_KEY=tu_clave_de_gemini_aqui
GENKIT_MODEL=gemini-2.5-flash
GENKIT_MAX_OUTPUT_TOKENS=250
```

#### 4. Iniciar la aplicación
Para desarrollo (con recarga automática):
```bash
npm run dev
```

Para producción:
```bash
npm start
```

Luego abre tu navegador en **[http://localhost:8080](http://localhost:8080)**.

---

### 🧪 Pruebas Automatizadas
Para ejecutar la suite de pruebas unitarias e integración:
```bash
npm test
```

---

### 🐳 Ejecución con Docker y Despliegue en Cloud Run

#### Con Docker
```bash
docker build -t pisto-app .
docker run -p 8080:8080 -e GEMINI_API_KEY="tu_clave" pisto-app
```

#### Despliegue directo a Google Cloud Run
Si tienes configurado `gcloud` CLI en tu equipo:
```bash
npm run deploy:cloudrun
```

---

> *"Tu pisto, bien contado y bajo tu control."*