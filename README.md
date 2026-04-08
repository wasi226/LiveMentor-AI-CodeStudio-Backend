# LiveMentor AI CodeStudio Backend

Backend API for the LiveMentor platform, built with Express and a hybrid data approach.

This service handles authentication, classroom management, coding workflows, analytics, and integration with external services such as Piston and optional AI providers.

## Highlights

- JWT based authentication and role-aware access control
- Classroom creation and student join by invite code
- Assignment and submission APIs
- Code execution endpoints with Piston integration
- Analytics and health endpoints
- MongoDB primary storage for core user and classroom flows
- Base44 compatibility in selected modules

## Tech Stack

- Node.js 18+
- Express
- MongoDB with Mongoose
- Joi validation
- JWT and bcrypt
- Piston API integration
- Optional Base44 integration for selected routes

## Project Structure

- src/index.js: app bootstrap, middleware, route mounting
- src/routes: API route modules
- src/models: Mongoose schemas and models
- src/middleware: auth, validation, error handling
- src/services: database init, code execution, user service, cache, websocket
- src/config: MongoDB and related config

## Prerequisites

- Node.js 18 or newer
- npm 9 or newer
- MongoDB instance (local or Atlas)

## Environment Setup

Copy env template and set values:

```bash
cp .env.example .env
```

Minimum required variables for stable local and production usage:

```env
NODE_ENV=development
PORT=3001
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/<db>?retryWrites=true&w=majority
JWT_SECRET=<strong-random-secret>
CORS_ORIGIN=http://localhost:5173
```

For a Vercel-hosted frontend, you can also use a wildcard origin such as:

```env
CORS_ORIGIN=http://localhost:5173,https://*.vercel.app
```

Useful optional variables:

```env
PISTON_API_URL=http://localhost:2000/api/v2/piston
PISTON_API_TOKEN=<optional-public-piston-token>
OPENAI_API_KEY=<optional>
BASE44_PROJECT_ID=<optional-or-required-for-base44-routes>
BASE44_API_KEY=<optional-or-required-for-base44-routes>
ENABLE_SWAGGER_DOCS=false
ENABLE_REQUEST_LOGGING=true
```

## Install and Run

```bash
npm install
npm run dev
```

Server defaults:

- API: http://localhost:3001
- Health: http://localhost:3001/health

## Available Scripts

- npm run dev: start development server with nodemon
- npm start: start production server
- npm run lint: run eslint
- npm run lint:fix: run eslint with autofix
- npm test: run jest tests
- npm run test:coverage: run test coverage

## API Overview

Main route groups:

- /api/auth
- /api/classrooms
- /api/assignments
- /api/submissions
- /api/chat
- /api/code
- /api/analytics
- /health

Example endpoints:

- POST /api/auth/register
- POST /api/auth/login
- GET /api/auth/me
- POST /api/classrooms
- POST /api/classrooms/join
- POST /api/code/execute

## Deployment

Recommended free stack:

- Backend hosting: Render (free web service)
- Database: MongoDB Atlas M0 (free)
- Frontend: Vercel (free)

Render settings:

- Root directory: Backend
- Build command: npm install
- Start command: npm start
- Health check path: /health

Set production env vars in your host dashboard, including:

- NODE_ENV=production
- MONGODB_URI
- JWT_SECRET
- CORS_ORIGIN (your frontend URL)
- CORS_ORIGIN (your frontend URL, or a wildcard like `https://*.vercel.app` if you deploy on Vercel)
- PISTON_API_URL (if code execution is enabled)
- PISTON_API_TOKEN (optional for authorized public Piston)

## Important Notes

- Some route modules still use Base44 client calls. If Base44 credentials are not configured, those modules may not behave as expected in full production scenarios.
- The initialization service creates a default admin account in some startup flows. Change default credentials immediately in production.

## Troubleshooting

- If you see authentication failures, verify JWT_SECRET and token flow.
- If classrooms or users do not persist, verify MONGODB_URI and MongoDB network access.
- If code execution fails, verify PISTON_API_URL and any required PISTON_API_TOKEN, or confirm your self-hosted Piston instance is running.

## License

MIT
