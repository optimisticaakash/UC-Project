# Admin report dashboard setup

## Configuration

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the server environment or secret manager. There is no default password or public admin registration route. The repository `.env` file is not modified by this setup.

Set `ADMIN_ALLOWED_ORIGIN` to the exact frontend origin in production. Local development allows `http://localhost` and `http://127.0.0.1`. Set `VITE_API_URL` at frontend build time when the API does not use the default local origin.

## Access

- Admin sign-in: `/admin/login`
- Internal reports: `/internal-assessment`
- Internal API routes: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`, `GET /api/interview/sessions`, and `GET /api/interview/:sessionId/report`.
- Interview start, answer, end, and voice-session routes use the existing direct prototype flow.

Admin sessions are process-memory sessions stored in `HttpOnly`, `SameSite=Strict` cookies, with `Secure` enabled in production. Sessions expire after eight hours and are invalidated by a backend restart.

## Prototype limitations

Interview sessions and reports are held in memory. They disappear when the backend restarts and are not suitable for durable candidate records. Candidate login and candidate-account management are not part of this prototype flow. The internal dashboard is protected by the configured admin login, but this remains prototype access control; use HTTPS and a reviewed deployment and data-retention policy before storing real candidate data.
