# Authentication setup

The backend reads its configuration from `server/.env`. Keep the file local and do not commit its values.

Required values:

- `MONGODB_URI` for persistent accounts, sessions, interviews, and reports.
- `GEMINI_API_KEY` for the existing Gemini voice interview.
- `ADMIN_ALLOWED_ORIGIN` for the deployed frontend origin. Local `localhost` and `127.0.0.1` origins are allowed outside production.
- `VITE_API_URL` for a deployed frontend build when the backend is not at the default `http://localhost:5001` origin. Set it in the client build environment; do not put server secrets in client variables.

For the first-admin setup page, configure `ADMIN_SETUP_TOKEN` with a private random value at least 32 characters long. For example, generate a token locally with `openssl rand -hex 32`; do not paste it into chat or commit it. Open `/admin/login`, choose **Set up the first admin account**, and submit the token with the admin name, login identifier, and a password of at least 12 characters. The backend permits setup once and stores only a salted scrypt password hash. There is no default admin password or general public admin registration route.

The previous `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment credentials remain supported for migration. If no MongoDB admin exists, a successful login with those credentials creates a hashed MongoDB admin record; subsequent logins use that record.

Start the app from the project root in separate terminals:

```sh
npm --prefix server run dev
npm --prefix client run dev
```

Use `http://localhost:5173` for the frontend and `http://localhost:5001` for the backend. Use the same host spelling in both URLs so the browser sends the session cookie consistently.

After signing in, open `/internal-assessment` for the admin dashboard.
