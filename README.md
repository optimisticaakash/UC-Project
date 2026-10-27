Urban Company AI Interviewer
A web-based professional skill assessment platform designed for Urban
Company service professionals. The application supports candidate
interviews and an internal admin workflow for managing candidates and
reviewing interview reports.

Live application: https://uc-project-nu.vercel.app/
Overview
The project contains a React frontend and a Node.js/Express backend. The
backend uses MongoDB for persistent storage and provides APIs for
authentication, interview sessions, and reports.
Tech Stack
- Frontend: React, Vite
- Backend: Node.js, Express.js (CommonJS)
- Database: MongoDB
- AI integration: Google Gemini
- Frontend hosting: Vercel
- Backend hosting: Render
Main Features
- Candidate sign-in and authenticated interview access
- Admin sign-in and first-admin setup flow
- Interview question bank loaded from JSON data
- Interview session and answer APIs
- AI-assisted answer interpretation using Gemini
- Interview report retrieval
- Persistent storage for accounts, sessions, and interview data
  through MongoDB
- Separate admin and candidate authentication sessions
Live Deployment
- Frontend: https://uc-project-nu.vercel.app/
- Backend health check:
  https://uc-project-o71w.onrender.com/api/health
The health endpoint can be used to verify that the backend is running
and that its storage connection is available.
Project Structure
The repository is organized into frontend and backend folders:
.
├── client/                 # React + Vite frontend
└── server/                 # Express backend
    └── src/
        ├── data/            # Question bank and assessment data
        ├── routes/          # API route definitions
        └── services/        # Authentication and application services
Exact files may vary as the project evolves.
Local Development
Prerequisites
- Node.js and npm
- MongoDB connection string
- Google Gemini API key if using AI-powered functionality
1. Clone the repository
git clone https://github.com/optimisticaakash/UC-Project.git
cd UC-Project
2. Configure the backend
Create a .env file inside server/ and set the required environment
variables:
NODE_ENV=development
MONGODB_URI=your_mongodb_connection_string
GEMINI_API_KEY=your_gemini_api_key
ADMIN_SETUP_TOKEN=generate_a_long_random_secret_token
Optional variables, depending on your configuration:
GEMINI_MODEL=gemini-3.6-flash
ADMIN_USERNAME=your_legacy_admin_username
ADMIN_PASSWORD=your_legacy_admin_password
ADMIN_ALLOWED_ORIGIN=http://localhost:5173
Use your own secret values. Do not commit .env files, API keys,
passwords, or setup tokens to GitHub. Generate a long random value for
ADMIN_SETUP_TOKEN; the backend requires at least 32 characters for
first-admin setup.

Install dependencies and start the backend:
cd server
npm install
npm start
The backend uses the port configured by the hosting environment or its
server configuration. Check the server output for the local address.
3. Configure the frontend
Create a .env file inside client/:
VITE_API_URL=http://localhost:5001
Use the actual local backend URL and port if they differ. Install
dependencies and start Vite:
cd client
npm install
npm run dev
Open the local URL printed by Vite in your terminal.
Deployment Configuration
Backend (Render)
Configure the environment variables in the Render service settings
rather than committing them to the repository. At minimum, verify:
- MONGODB_URI
- GEMINI_API_KEY
- ADMIN_SETUP_TOKEN
- NODE_ENV=production
- ADMIN_ALLOWED_ORIGIN=https://uc-project-nu.vercel.app
ADMIN_ALLOWED_ORIGIN should match the deployed frontend origin
exactly, without a trailing slash. Render supplies the PORT
environment variable; normally you should not hard-code it in the
deployment dashboard.
Frontend (Vercel)
Set the following environment variable for the production deployment:
VITE_API_URL=https://uc-project-o71w.onrender.com
Redeploy the frontend after changing Vercel environment variables.
First Admin Setup
1. Confirm the backend is deployed and the health endpoint reports that
   storage is connected.
2. Configure ADMIN_SETUP_TOKEN in the backend environment.
3. Complete the backend deployment if the environment variable was
   changed.
4. Open the app and use Set up the first admin account.
5. Create the first admin with a valid login identifier and a password
   of at least 12 characters.
The first-admin setup endpoint is intended for initial setup and will
reject subsequent setup attempts once an admin account exists. Keep the
setup token private.
Important API Endpoints
The backend exposes these application endpoints:

  Method   Endpoint                   Purpose
  GET    /api/health              Backend and storage health check
  POST   /api/admin/login         Admin sign-in
  POST   /api/admin/setup         First-admin setup
  GET    /api/admin/me            Verify the current admin session
  POST   /api/admin/logout        Admin sign-out
  POST   /api/candidate/login     Candidate sign-in
  GET    /api/candidate/me        Verify the current candidate session
  POST   /api/candidate/logout    Candidate sign-out
  POST   /api/start               Start an interview session
  POST   /api/answer              Submit an interview answer
  POST   /api/interpret           Interpret an answer
  POST   /api/manual-review       Request/record manual review
  GET    /api/:sessionId/report   Retrieve a session report

Interview routes may have authentication or request requirements; refer
to the backend route definitions for exact payloads and access rules.
Security Notes
- Keep all API keys, MongoDB credentials, admin passwords, and setup
  tokens private.
- Never commit .env files.
- Use HTTPS for deployed frontend and backend.
- Restrict CORS to the intended frontend origin.
- The admin setup token should be rotated if it is exposed.
- Production authentication cookies should use secure attributes
  appropriate for cross-site frontend/backend deployments.
Troubleshooting
- Health endpoint returns an error: Check Render deployment logs
  and the MongoDB connection string.
- Login succeeds but the app returns to the login page: Check
  browser Network tools for the Set-Cookie response and whether
  /api/admin/me or /api/candidate/me returns 200 or 401.
- CORS errors: Verify ADMIN_ALLOWED_ORIGIN matches the exact
  deployed frontend origin.
- AI requests fail: Verify GEMINI_API_KEY, the configured model,
  and the backend logs.
- Frontend calls localhost in production: Verify VITE_API_URL in
  Vercel and redeploy.
Status
The deployed frontend and backend health endpoint are available at the
links above. Feature behavior may change as development continues.