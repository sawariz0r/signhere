# Development and contributions

[Back to README](../README.md) · [Self-hosting](self-hosting.md) · [Architecture](architecture.md)

PRs are welcome. Useful contributions include bug fixes, clearer docs, accessibility, design improvements, deployment feedback and tests. Open an issue before a large change so we can agree on the direction.

Signhere is an AI-driven project: AI tools are used extensively in design, implementation and documentation. Contributions are welcome with or without AI assistance. Review what you submit and explain what changed and how you checked it. Keep identity and verification claims consistent with what the code actually proves.

## Local setup

You'll need Node.js 22.16+, Python 3.11+ and PostgreSQL 17+. Docker bundles these for [self-hosting](self-hosting.md); the instructions here run the app directly.

1. Clone the repository and install JavaScript dependencies:

   ```sh
   git clone https://github.com/sawariz0r/signhere.git
   cd signhere
   npm ci
   ```

2. Create a dedicated development database owned by a non-superuser role. Add its connection string to a private `.env` file:

   ```dotenv
   DATABASE_URL=postgresql://signhere_dev:YOUR_URL_SAFE_PASSWORD@127.0.0.1:5432/signhere_dev
   TEST_DATABASE_URL=postgresql://signhere_dev:YOUR_URL_SAFE_PASSWORD@127.0.0.1:5432/signhere_dev
   ```

   The app applies migrations at startup. Use a development database; tests create and remove isolated schemas. The production Compose database's runtime role cannot run migrations by itself.

3. Install the PDF sealing dependencies:

   ```sh
   python3 -m venv .local/seal-python
   .local/seal-python/bin/python -m pip install --require-hashes -r scripts/pdf-seal/requirements.txt
   ```

   In Windows PowerShell, use `python -m venv .local/seal-python` and `.local/seal-python/Scripts/python.exe -m pip install --require-hashes -r scripts/pdf-seal/requirements.txt`.

4. Start the app:

   ```sh
   npm run dev
   ```

5. Open `http://localhost:5173`. Retrieve the first-owner installation key with `cat data/setup-token` (PowerShell: `Get-Content data/setup-token`) and enter it during signup.

The launcher reads `.env` and, if present, `.local/postgres.env`. The UI proxies API requests to port 3000. `DEV_BASE_URL` overrides the browser origin. The app discovers `.local/seal-python` automatically; `SIGNHERE_SEAL_PYTHON` can select another absolute interpreter path. If you change `DATA_DIR`, look there for the setup token. Keep private keys outside public code/runtime directories.

Native development does not establish the Linux container's parser sandbox guarantees. Validate sandbox changes in the actual Docker image; see [the isolation notes](deployment.md#pdf-parser-boundary-in-the-linux-image).

## Checks

Run checks appropriate to your change. For application changes:

```sh
npm run typecheck
node --env-file=.env --run test
npm run build
```

The test command loads `.env` before running the package's test script. Set `TEST_DATABASE_URL` so all database-backed tests run; some older tests also accept `DATABASE_URL`. Tests exercise real PostgreSQL transactions in isolated schemas. If the variables are already exported in your shell, `npm test` works directly.

For UI or signing-flow changes, also run:

```sh
npx playwright install chromium
npm run test:browser
```

Windows browser tests use installed Edge. Browser tests save screenshots under the ignored `.test-artifacts/browser` directory. CI also has a Docker lifecycle job covering setup, signing, sandbox isolation, key recovery and restore behavior; local tests don't replace it.

To serve a production build locally, run `npm run build` followed by `npm start` with the appropriate `BASE_URL` and database configuration.

## Submitting a PR

Keep the change focused. Explain the problem, resulting behavior and relevant checks; include screenshots when they help review a UI change. Never include `.env`, private keys, personal signing links or real document evidence. Code contributions use the project's [AGPL-3.0-only license](../LICENSE).

For signing or verification changes, read [signing security](signing-security.md), [signing methods](signing-methods.md) and the [implementation status](sealing-implementation.md) first.
