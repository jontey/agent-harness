# Context

## Original requirement

Trace how authentication state reaches the API client.

## Scope

- Inspect `src/auth` and `src/api`.
- Do not modify repository files.
- Exclude vendored and generated code.

## Known evidence

- The application initializes authentication before constructing the API client.
- The exact transformation and refresh path remain unknown.

## Acceptance criteria

- Identify the state owner.
- Identify each transformation boundary.
- Cite files and symbols.
- Separate verified evidence from inference.

## Unknowns

- Whether refresh tokens use the same path as initial credentials.
- Whether request middleware reads state directly or receives a snapshot.
