# Urban Company AI Interviewer

An intelligent, conversational AI-powered screening and skill-assessment platform designed for **Urban Company salon and beauty service professionals**. The application features real-time bidirectional voice interaction, progressive Hindi/English captioning, dynamic follow-up questioning, candidate interruption (barge-in) handling, and an administrative portal for candidate provisioning, real-time analytics, and PDF assessment report generation.

- **Live Application (Frontend)**: [https://uc-project-nu.vercel.app/](https://uc-project-nu.vercel.app/)
- **Live Backend Health Check**: [https://uc-project-o71w.onrender.com/api/health](https://uc-project-o71w.onrender.com/api/health)

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [System Architecture](#system-architecture)
3. [Prerequisites](#prerequisites)
4. [Clone the Repository](#clone-the-repository)
5. [Install Dependencies](#install-dependencies)
6. [Environment Variables (.env Configuration)](#environment-variables-env-configuration)
7. [Example Environment Files](#example-environment-files)
8. [Local Development Setup](#local-development-setup)
9. [API Documentation](#api-documentation)
10. [Gemini AI & Voice Integration](#gemini-ai--voice-integration)
11. [Database & Question Bank](#database--question-bank)
12. [Testing](#testing)
13. [Troubleshooting](#troubleshooting)
14. [Deployment Information](#deployment-information)
15. [Security Notes](#security-notes)

---

## Project Overview

### Purpose
The Urban Company AI Interviewer automates the initial screening of beauty and salon service partners. Instead of static multiple-choice questionnaires or rigid chatbots, it acts as an empathetic, adaptive interviewer capable of understanding spoken Hindustani/Hindi and English, answering candidate counter-questions, probing ambiguous responses, and evaluating candidates against salon professional standards.

### Major Features
- **Real-Time Bidirectional Voice**: Built with Gemini Live (`gemini-3.8-live`) for low-latency voice-to-voice interaction.
- **Natural Candidate Barge-In / Interruption**: Candidate speech immediately halts AI voice playback, discarding buffered chunks without state corruption.
- **Synchronized Progressive Captions**: Real-time caption pacing synced with AI audio playback and candidate transcription.
- **Conversational Inquiries & Counter-Questions**: Candidates can ask questions about salon tools, customer handling, safety, or interview progress; the AI answers naturally and steers back to the assessment.
- **Graceful Quota-Exhaustion Protection**: Explicit HTTP 429 (`RESOURCE_EXHAUSTED`) detection, circuit-breaker cooldown, and safe candidate notification preserving the active interview question.
- **Browser TTS Fallback**: Automatic speech synthesis fallback if Gemini Live audio arrival times out or encounters network degradation.
- **Candidate Account Provisioning**: Admin-controlled candidate credentials with salted scrypt password hashing.
- **First-Admin Tokenized Setup**: Single-use tokenized setup flow for the initial administrator.
- **Admin Dashboard & Analytics**: Interview metrics, question-by-question breakdown, manual review flagging, and GridFS-stored PDF report downloads with HarfBuzz Devanagari font shaping.
- **Optional Google Sheets Sync**: Idempotent background synchronization of candidate responses to Google Sheets.

### Technology Stack
- **Frontend**: React 19, Vite 8, Tailwind CSS 4, Web Audio API (AudioWorklet PCM capture, Web Audio Analyser).
- **Backend**: Node.js, Express 5 (CommonJS), Mongoose 9 (MongoDB Atlas / local MongoDB), PDFKit with HarfBuzz.js.
- **AI Integration**: `@google/genai` SDK (`gemini-3.8-live` for voice, `gemini-3.6-flash` for answer interpretation and inquiry responses).
- **Hosting**: Vercel (Frontend), Render (Backend).

---

## System Architecture

```mermaid
flowchart TD
    subgraph Client["Frontend (React 19 + Vite)"]
        UI["Interview & Admin UI"]
        AudioWorklet["AudioWorklet (16kHz PCM Mic Capture)"]
        AudioQueue["Audio Playback Queue & Barge-In Detector"]
        TTS["SpeechSynthesis (TTS Fallback)"]
    end

    subgraph Server["Backend (Node.js + Express 5)"]
        API["Express Router & Controllers"]
        AuthService["Auth Service (Scrypt Passwords & Cookies)"]
        InterviewService["Interview Engine (50-Question State Machine)"]
        GeminiService["Gemini Service & Circuit Breaker"]
        Persistence["Mongoose & GridFS Layer"]
        SheetsService["Google Sheets Sync Service (Optional)"]
    end

    subgraph External["External Services"]
        GeminiAPI["Google Gemini AI Studio (gemini-3.6-flash)"]
        GeminiLiveWS["Gemini Live WebSocket (gemini-3.8-live)"]
        MongoDB[("MongoDB Database (Atlas / Local)")]
        GSheets[("Google Sheets API (Optional)")]
    end

    UI -->|"Fetch /api/interview/*"| API
    AudioWorklet -->|"PCM Stream"| AudioQueue
    UI -->|"WebSocket Live Connect"| GeminiLiveWS
    API -->|"Token Minting (/api/voice/session)"| GeminiLiveWS
    API -->|"Answer Interpretation & Inquiries"| GeminiAPI
    API --> AuthService
    API --> InterviewService
    InterviewService --> GeminiService
    GeminiService --> GeminiAPI
    API --> Persistence
    Persistence --> MongoDB
    API -.-> SheetsService
    SheetsService -.-> GSheets
    AudioQueue -.->|"Fallback on Audio Timeout"| TTS
```

### Communication Flow
1. **Authentication**: Admin and Candidate sign in via `/api/admin/login` or `/api/candidate/login`, receiving `HttpOnly` session cookies (`SameSite=Lax` for development, `SameSite=None; Secure` for production).
2. **Interview Initialization**: The frontend calls `/api/voice/session` to obtain a single-use ephemeral token generated by the backend via `ai.authTokens.create`, then calls `/api/interview/start`.
3. **Voice Interaction**: The frontend connects to `gemini-3.8-live` using `@google/genai` over WebSockets. Microphone audio is streamed at 16kHz PCM via an AudioWorklet.
4. **Answer Submission & Interpretation**: Candidate answers are submitted to `POST /api/interview/answer`. The backend evaluates the response using `gemini-3.6-flash`, determines progression, handles follow-ups, or processes candidate questions.
5. **State & Reporting**: Every state change is persisted to MongoDB. Completed sessions generate formatted PDF reports stored via GridFS.

---

## Prerequisites

Before running the application locally, ensure you have installed:

| Tool | Minimum Version | Recommended | Notes |
| :--- | :--- | :--- | :--- |
| **Node.js** | `v18.0.0` | `v20.x` or `v22.x` | Required for both frontend and backend |
| **npm** | `v9.0.0` | `v10.x` | Bundled with Node.js |
| **Git** | `v2.30.0` | Latest | For repository management |
| **MongoDB** | `v6.0.0` | MongoDB Atlas (Free M0 cluster) or local daemon | Required for persistence |
| **Google Gemini API Key** | — | Valid Google AI Studio key | Required for AI interview features |

---

## Clone the Repository

Clone the project from GitHub:

```bash
git clone https://github.com/optimisticaakash/UC-Project.git
cd UC-Project
```

Verify you are on the active development branch:

```bash
git branch --show-current
# Recommended active branch: feature-interview-enhancements
```

---

## Install Dependencies

The repository uses separate `package.json` files for the `server` and `client` directories. There is no root `package.json`.

Install dependencies for both projects from the repository root:

```bash
# 1. Install backend dependencies
npm --prefix server install

# 2. Install frontend dependencies
npm --prefix client install
```

Alternatively, navigate into each directory individually:

```bash
cd server && npm install && cd ..
cd client && npm install && cd ..
```

---

## Environment Variables (.env Configuration)

### Backend Environment Variables (`server/.env`)

Create `server/.env` based on `server/.env.example`.

| Variable Name | Required? | Where to Obtain | Description & Example |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Optional | Set manually | `development` (enables HTTP dev cookies, permissive CORS) or `production`. Default: `development`. |
| `PORT` | Optional | Set manually | Local backend port. Default: `5001`. |
| `MONGODB_URI` | **Required** | [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) or local MongoDB | Connection URI: `mongodb+srv://<user>:<password>@cluster0.abc.mongodb.net/uc_interviewer?retryWrites=true&w=majority` |
| `ADMIN_ALLOWED_ORIGIN` | Optional | Set manually | Deployed frontend origin (e.g. `https://uc-project-nu.vercel.app`). In development, all `localhost` and `127.0.0.1` origins are automatically permitted. |
| `ADMIN_SETUP_TOKEN` | **Required for Setup** | Generate locally | A secure random string (minimum 32 characters) used to register the initial admin. Generate via: `openssl rand -hex 32` |
| `GEMINI_API_KEY` | **Required** | [Google AI Studio](https://aistudio.google.com/app/apikey) | Gemini API key used for answer evaluation, counter-questions, and voice token generation. |
| `GEMINI_MODEL` | Optional | Google Gemini docs | Model for text interpretation. Default: `gemini-3.6-flash`. |
| `GEMINI_INTERPRETATION_TIMEOUT_MS` | Optional | Set manually | Timeout in milliseconds for answer classification. Default: `15000` (min: `1000`). |
| `GEMINI_INQUIRY_TIMEOUT_MS` | Optional | Set manually | Timeout in milliseconds for counter-question responses. Default: `15000` (min: `1000`). |
| `ADMIN_USERNAME` | Optional | Set manually | Legacy admin username fallback for initial database seeding. |
| `ADMIN_PASSWORD` | Optional | Set manually | Legacy admin password fallback for initial database seeding. |
| `GOOGLE_SHEET_ID` | Optional | Google Sheets URL | Spreadsheet ID for optional response synchronization. If empty, sync safely no-ops. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Optional | Google Cloud Console | Service account email with Editor permissions to the spreadsheet. |
| `GOOGLE_PRIVATE_KEY` | Optional | Google Cloud Service Key | Service account RSA private key formatted with newline escapes (`"-----BEGIN PRIVATE KEY-----\n..."`). |

> [!NOTE]
> Third-party services like Clerk, ImageKit, or Inngest are **not** used by this codebase. Authentication relies on built-in salted scrypt hashing with HTTP session cookies.

### Frontend Environment Variables (`client/.env`)

Create `client/.env` based on `client/.env.example`.

| Variable Name | Required? | Description & Example |
| :--- | :---: | :--- |
| `VITE_API_URL` | Optional in Dev | Backend API URL. In local development, automatically defaults to `http://localhost:5001` (or `http://127.0.0.1:5001`). For production builds, set to your backend origin (e.g. `https://uc-project-o71w.onrender.com`) without a trailing slash. |
| `VITE_BACKEND_WAIT_ANNOUNCEMENT_MS` | Optional | Milliseconds to wait before the AI speaks a thinking audio reminder during slow network turns. Default: `3000` (min: `500`). |

---

## Example Environment Files

Templates with safe placeholder values are provided in the repository:

- [`server/.env.example`](file:///Users/sachin/Desktop/UC%20company%20Ai%20agent%20prject/server/.env.example)
- [`client/.env.example`](file:///Users/sachin/Desktop/UC%20company%20Ai%20agent%20prject/client/.env.example)

To configure your local environment, copy the template files:

```bash
# Copy backend template
cp server/.env.example server/.env

# Copy frontend template
cp client/.env.example client/.env
```

Edit `server/.env` and insert your actual `MONGODB_URI`, `GEMINI_API_KEY`, and a generated `ADMIN_SETUP_TOKEN`.

---

## Local Development Setup

Follow these exact steps to run the application locally:

### Step 1: Generate an Admin Setup Token
Run the following in your terminal:
```bash
openssl rand -hex 32
```
Paste this token into `server/.env` as `ADMIN_SETUP_TOKEN`.

### Step 2: Configure MongoDB & Gemini
In `server/.env`, verify:
```ini
NODE_ENV=development
PORT=5001
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/uc_interviewer
GEMINI_API_KEY=your_gemini_api_key_here
ADMIN_SETUP_TOKEN=your_generated_32_char_token_here
```

### Step 3: Start the Backend Server
Open Terminal 1:
```bash
npm --prefix server run dev
```
*Expected terminal output:*
```text
Server running on port 5001
[UC Persistence] MongoDB connected; restored 0 interview sessions.
Loaded 50 questions from questionBank.json
```

### Step 4: Verify Backend Health
Open Terminal 2 or your browser:
```bash
curl http://localhost:5001/api/health
```
*Expected JSON response:*
```json
{
  "success": true,
  "message": "Urban Company Interviewer API is running",
  "totalQuestions": 50,
  "storageMode": "mongodb",
  "storageConnected": true
}
```

### Step 5: Start the Frontend Application
In Terminal 2:
```bash
npm --prefix client run dev
```
Vite will start the client on `http://localhost:5173`.

### Step 6: Set Up the First Administrator Account
1. In your browser, navigate to: `http://localhost:5173/admin/login`
2. Click **Set up the first admin account**.
3. Fill in:
   - **Admin Name**: `Admin User`
   - **Login Identifier**: `admin@urbancompany.com`
   - **Password**: At least 12 characters (e.g. `AdminPassword!2026`)
   - **Setup Token**: Paste the exact `ADMIN_SETUP_TOKEN` from `server/.env`.
4. Submit. The backend registers the administrator and stores a salted scrypt hash in MongoDB. Subsequent setup attempts are permanently locked.

### Step 7: Provision a Candidate & Run an Interview
1. Log in to the Admin Dashboard (`http://localhost:5173/internal-assessment`).
2. In the **Candidate Accounts** section, provision a candidate (e.g. name `Pooja Sharma`, identifier `pooja@example.com`, password `Password1234`).
3. Open `http://localhost:5173/candidate/login` in an Incognito window.
4. Sign in as the candidate and click **Start Voice Interview**.
5. Allow microphone permissions in your browser.

---

## API Documentation

### Public Endpoints

| Method | Endpoint | Description | Auth Required | Request Body / Params | Expected Response |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/health` | Service & database health | None | None | `{ success: true, storageConnected: true, totalQuestions: 50 }` |

### Candidate Authentication (`/api/candidate/*`)

| Method | Endpoint | Description | Auth Required | Request Body | Expected Response |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/candidate/login` | Candidate sign-in | None | `{ loginIdentifier, password }` | `{ success: true, candidate: { candidateId, name, loginIdentifier } }` (Sets session cookie) |
| `POST` | `/api/candidate/logout` | Candidate sign-out | Candidate | None | `{ success: true, message: "Logged out successfully" }` |
| `GET` | `/api/candidate/me` | Current session info | Candidate | None | `{ success: true, candidate: { ... } }` |
| `GET` | `/api/candidate/interviews` | List current candidate's interviews | Candidate | None | `{ success: true, interviews: [ ... ] }` |

### Voice Token Endpoint

| Method | Endpoint | Description | Auth Required | Request Body | Expected Response |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/voice/session` | Mint single-use Gemini Live WebSocket token | Candidate | None | `{ success: true, token: "authTokens/..." }` |

### Interview Session Endpoints (`/api/interview/*`)

| Method | Endpoint | Description | Auth Required | Request Body | Expected Response |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/interview/start` | Start interview session | Candidate | `{ candidateName?: string }` | `{ success: true, sessionId, question: { id: "A2_NAME", text, ... } }` |
| `POST` | `/api/interview/answer` | Submit spoken/text answer | Candidate | `{ sessionId, expectedQuestionId, answer }` | `{ success: true, question, clarificationRequired, followUpRequired, completed }` |
| `POST` | `/api/interview/pause` | Pause active interview | Candidate | `{ sessionId }` | `{ success: true, session: { ... } }` |
| `POST` | `/api/interview/resume` | Resume paused interview | Candidate | `{ sessionId }` | `{ success: true, question: { ... } }` |
| `GET` | `/api/interview/active` | Get active/paused session | Candidate | Query: `?sessionId=...` | `{ success: true, activeSession: { ... } }` |
| `POST` | `/api/interview/update-name` | Update candidate name | Candidate | `{ sessionId, candidateName }` | `{ success: true, candidateName }` |
| `POST` | `/api/interview/end` | Prematurely terminate session | Candidate | `{ sessionId, reason?: string }` | `{ success: true, completed: true }` |

### Admin Endpoints (`/api/admin/*` & Admin `/api/interview/*`)

All admin routes require an active admin session cookie (`adminAuth.requireAdmin`).

| Method | Endpoint | Description | Request Body / Params | Expected Response |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/admin/setup` | Register first admin account | `{ name, loginIdentifier, password, setupToken }` | `{ success: true, admin: { ... } }` |
| `POST` | `/api/admin/login` | Admin sign-in | `{ loginIdentifier, password }` | `{ success: true, admin: { ... } }` |
| `POST` | `/api/admin/logout` | Admin sign-out | None | `{ success: true }` |
| `GET` | `/api/admin/me` | Current admin session info | None | `{ success: true, admin: { ... } }` |
| `GET` | `/api/admin/stats` | Aggregate dashboard statistics | None | `{ success: true, stats: { totalInterviews, completed, rejected, ... } }` |
| `GET` | `/api/admin/candidates` | List all provisioned candidates | None | `{ success: true, candidates: [ ... ] }` |
| `POST` | `/api/admin/candidates` | Provision new candidate | `{ name, loginIdentifier, password }` | `{ success: true, candidate: { ... } }` |
| `PATCH` | `/api/admin/candidates/:id/deactivate` | Deactivate candidate | None | `{ success: true }` |
| `PATCH` | `/api/admin/candidates/:id/activate` | Activate candidate | None | `{ success: true }` |
| `DELETE` | `/api/admin/candidates/:id` | Soft-delete candidate account | None | `{ success: true }` |
| `GET` | `/api/interview/sessions` | List all interview reports | None | `{ success: true, sessions: [ ... ] }` |
| `GET` | `/api/interview/:sessionId/report` | Retrieve full interview report JSON | None | `{ success: true, report: { candidate, answers, score, ... } }` |
| `GET` | `/api/interview/:sessionId/report.pdf` | Download formatted PDF assessment | None | Binary PDF stream (`application/pdf`) |
| `DELETE` | `/api/interview/:sessionId/report` | Delete an interview report | None | `{ success: true }` |

---

## Gemini AI & Voice Integration

### Configuration
- **Gemini Live Model**: `gemini-3.8-live` (configured in `client/src/config/geminiConfig.js` and `server/src/server.js`).
- **Answer Interpretation Model**: `gemini-3.6-flash` (configurable via `GEMINI_MODEL`).
- **System Instructions**: Spoken voice prompt rules are governed by [`server/src/services/liveVoiceInstructions.js`](file:///Users/sachin/Desktop/UC%20company%20Ai%20agent%20prject/server/src/services/liveVoiceInstructions.js).

### Quota-Exhaustion & Circuit-Breaker Handling
Google AI Studio's Free Tier enforces a strict quota (e.g. 20 requests per day for flash models). If this limit is exceeded, the API responds with **HTTP 429 (`RESOURCE_EXHAUSTED`)**.

The application handles quota exhaustion gracefully:
1. **Circuit-Breaker Activation**: An internal cooldown blocks subsequent outbound requests for 30–60 seconds, preventing redundant API calls.
2. **Safe Spoken Response**: The candidate is informed naturally in Hindi or English:
   > *"Maaf kijiye, abhi mujhe jawab dene mein technical dikkat aa rahi hai. Aapka interview question safe hai. Hum thodi der baad dobara koshish kar sakte hain."*
3. **No State Corruption**: The pending assessment question is preserved. Question index, score, invalid attempts, and retries are **not** penalized.
4. **Operator Diagnostic**: Emits `[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED` in the server logs.

> [!TIP]
> For production deployments, upgrade your Google AI Studio project to **Pay-As-You-Go (Tier 1)** to eliminate the 20 requests/day Free Tier ceiling.

---

## Database & Question Bank

### Database Collections (MongoDB)
- `AdminAccount`: Administrator profiles and salted scrypt password hashes.
- `CandidateAccount`: Candidate profiles, status (`active` / `deactivated` / `deleted`), and credentials.
- `AdminSession` & `CandidateSession`: Session tokens, user agent metadata, and expiration timestamps.
- `InterviewSession`: Complete turn-by-turn interview state, scores, flags, and memory.
- `fs.files` & `fs.chunks`: GridFS buckets holding generated assessment report PDFs.

### Question Bank (`server/src/data/questionBank.json`)
The interview assessment engine is driven by [`server/src/data/questionBank.json`](file:///Users/sachin/Desktop/UC%20company%20Ai agent prject/server/src/data/questionBank.json).

> [!IMPORTANT]
> **Question Bank Constraints**:
> - The question bank must contain **exactly 50 questions**.
> - Each question must have a valid `id` (or `Step`), `text` (or `Bot says (primary)`), and `category` (or `Block`).
> - The sequence covers Candidate Name (`A2_NAME`), Name Confirmation (`A2_NAME_CONFIRM`), Consent & Language (`A0`), Location & Travel (`A1`), Family Background (`A3`), Industry Experience (`B1`–`B12`), Situational Judgment (`C1`–`C12`), Safety & Hygiene (`D1`–`D12`), and Final Readiness (`E1`–`E2`).
> - Do not delete or reorder question IDs in `questionBank.json` without updating the dependent logic in `server/src/services/interview.js`.

---

## Testing

The project maintains extensive unit, integration, and regression test suites for both frontend and backend.

### Run Backend Tests (Node.js Test Runner)
```bash
npm --prefix server test
```
*Scope*: Runs tests across 8 suites:
- `interviewTest.js`: Core interview engine state machine.
- `adminAuth.test.js`: Admin registration, scrypt hashing, and session revocation.
- `candidateAuth.test.js`: Candidate provisioning and authorization.
- `persistence.test.js`: MongoDB connection and GridFS storage.
- `reportPdf.test.js`: PDF generation and Devanagari text shaping.
- `geminiService.test.js`: Answer interpretation and unified intents.
- `googleSheetsService.test.js`: Optional Google Sheets sync and schema formatting.
- `quotaExhaustion.test.js`: HTTP 429 quota exhaustion and circuit-breaker behavior.

*Expected result*: `361 tests passed, 0 failed`.

### Run Frontend Tests (Node.js Test Runner)
```bash
npm --prefix client test
```
*Scope*: Runs tests across client utility suites:
- `interviewResponse.test.js`: Prompt handoff and recovery.
- `liveDialoguePrompt.js`: Candidate dialogue prompt generators.
- `voiceInterruption.test.js`: Mic gating, barge-in, multi-chunk streaming, and playback cancellation.
- `stage6SpeechExperience.test.js`: Progressive captioning and settle timers.

*Expected result*: `224 tests passed, 0 failed`.

### Run All Tests
```bash
npm --prefix server test && npm --prefix client test
```
*Combined Result*: **585 / 585 tests passing**.

---

## Troubleshooting

### 1. `GEMINI_API_KEY is missing` or `AI service unavailable`
- **Cause**: Missing or invalid `GEMINI_API_KEY` in `server/.env`.
- **Fix**: Verify your key from Google AI Studio. Restart the backend after updating `.env`.

### 2. Candidate receives "Maaf kijiye, abhi mujhe jawab dene mein technical dikkat aa rahi hai"
- **Cause**: Google AI Studio Free Tier daily limit (20 requests/day) has been exhausted (`HTTP 429 RESOURCE_EXHAUSTED`).
- **Fix**: Check server logs for `[UC Diagnostics] GEMINI_FREE_TIER_QUOTA_EXHAUSTED`. Switch to a billing-enabled Google AI Studio API key or wait for the daily quota reset window.

### 3. MongoDB connection failure at startup
- **Symptom**: Server logs `[UC Persistence] MongoDB startup connection failed.`
- **Cause**: Incorrect connection string, IP address not whitelisted in MongoDB Atlas Network Access, or missing credentials.
- **Fix**: Verify `MONGODB_URI` in `server/.env`. Ensure your current IP is whitelisted (`0.0.0.0/0` for development).

### 4. Port 5001 or 5173 Already in Use
- **Fix**: Identify and kill the process holding the port:
  ```bash
  lsof -ti :5001 | xargs kill -9
  lsof -ti :5173 | xargs kill -9
  ```

### 5. CORS Errors or Unauthorized Cookies in Browser
- **Symptom**: Browser blocks requests with CORS errors or candidate/admin login redirects back to login page.
- **Fix**:
  - In local development, verify `NODE_ENV=development` in `server/.env`. Localhost is automatically permitted without strict HTTPS cookie flags.
  - In production, set `ADMIN_ALLOWED_ORIGIN=https://uc-project-nu.vercel.app` (matching the frontend origin exactly with no trailing slash).

### 6. Microphone / Voice Not Working in Browser
- **Fix**:
  - Ensure the browser has permission to access your microphone.
  - Use `http://localhost:5173` rather than local IP addresses (browsers treat `localhost` as a secure context for AudioWorklet and MediaDevices).

---

## Deployment Information

### Production Architecture
- **Frontend Hosting**: Vercel ([https://uc-project-nu.vercel.app/](https://uc-project-nu.vercel.app/))
  - Build command: `vite build`
  - Output directory: `dist`
  - Environment variable: `VITE_API_URL=https://uc-project-o71w.onrender.com`
- **Backend Hosting**: Render Web Service ([https://uc-project-o71w.onrender.com](https://uc-project-o71w.onrender.com))
  - Build command: `npm install`
  - Start command: `node src/server.js`
  - Environment variables configured in Render Dashboard:
    - `NODE_ENV=production`
    - `MONGODB_URI=...`
    - `GEMINI_API_KEY=...`
    - `ADMIN_SETUP_TOKEN=...`
    - `ADMIN_ALLOWED_ORIGIN=https://uc-project-nu.vercel.app`

---

## Security Notes

1. **Never Commit Secrets**: Never commit `.env`, `.env.local`, API keys, or database credentials. Verify with `git status` before committing.
2. **Setup Token Protection**: Keep `ADMIN_SETUP_TOKEN` private. Once the first administrator is created, the setup endpoint automatically locks.
3. **Password Storage**: Passwords are never stored in plaintext. They are hashed using Node.js's built-in `crypto.scrypt` with individual random 16-byte salts.
4. **Cookie Security**:
   - In production (`NODE_ENV=production`): Session cookies use `HttpOnly`, `SameSite=None`, and `Secure`.
   - In development: Cookies use `SameSite=Lax` without `Secure` so testing over standard HTTP succeeds seamlessly.
5. **No Secret Exposure in Frontend**: Frontend code never receives the primary `GEMINI_API_KEY`. It receives only single-use, time-limited tokens minted by the backend at `/api/voice/session`.
