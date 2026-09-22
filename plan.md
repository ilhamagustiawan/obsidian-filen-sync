# Plan: Migrate to Obsidian Secret Storage

This plan outlines the steps to migrate sensitive authentication data (API keys, master keys, RSA keys, and passwords) from the plain-text `data.json` file to Obsidian's secure `localStorage` API.

## 1. Goals

- Remove `FilenAuth` from `data.json`.
- Securely store credentials using `app.saveLocalStorage` (vault-scoped).
- Provide a seamless migration for existing users.
- Add an optional "Remember Password" feature.
- Maintain compatibility with mobile and desktop.

## 2. Architecture Changes

### A. Data Separation

- **`data.json`**: Will only contain non-sensitive configuration (sync intervals, ignore patterns, vault name, etc.).
- **Secret Storage**: Will contain the `FilenAuth` object and the optional `sessionPassword`.

### B. New Module: `src/secrets.ts`

Create a utility module to encapsulate all secret management:

- `getSecret(key: string): any`
- `setSecret(key: string, value: any): void`
- `storeAuth(auth: FilenAuth): void`
- `getAuth(): FilenAuth | null`
- `clearSecrets(): void`

## 3. Implementation Steps

### Step 1: Update Types and Settings (`src/settings.ts`)

- Remove `auth` field from `FilenSyncSettings`.
- Add `hasAuth: boolean` to track connection status without storing keys.
- Add `rememberPassword: boolean` to the settings interface.
- Update `DEFAULT_SETTINGS` and `fromSaved` logic.

### Step 2: Create Secrets Utility (`src/secrets.ts`)

- Implement wrapper functions around `this.app.loadLocalStorage` and `this.app.saveLocalStorage`.
- Use a unique prefix for keys to avoid collisions (e.g., `filen-sync:auth`).

### Step 3: Migration Logic (`src/main.ts`)

- In `onload()`, check if `auth` exists in the object returned by `this.loadData()`.
- If present:
    1. Move it to Secret Storage.
    2. Set `settings.hasAuth = true`.
    3. Delete `auth` from the settings object.
    4. Call `this.saveData()` immediately to overwrite the plain-text file.

### Step 4: Update Lifecycle and Auth Flow

- **Login**: After successful `testConnection`, store the `FilenAuth` in Secret Storage.
- **Logout**: Ensure `clearSecrets()` is called to wipe both auth and passwords.
- **Remember Password**: If enabled, store the password in Secret Storage; otherwise, keep it in a private class variable (in-memory).

### Step 5: Update UI (`src/settings.ts`)

- Update the "Connected" card to reflect the `hasAuth` status.

## 4. Security Considerations

- **Vault Scoping**: By using `app.saveLocalStorage`, Obsidian automatically scopes the data to the specific vault ID.
- **Plain-text Scrubbing**: The migration must ensure that `saveData` is called as soon as the secrets are moved to prevent them from lingering in `data.json`.
- **Key naming**: Keys will be prefixed with the plugin ID to follow Obsidian's best practices.

## 5. Timeline / Task List

- [ ] Create `src/secrets.ts`.
- [ ] Modify `src/settings.ts` types and UI.
- [ ] Implement migration logic in `src/main.ts`.
- [ ] Refactor `FilenRemoteFs` to load credentials from the new secret manager.
- [ ] Test migration from old `data.json`.
- [ ] Test "Remember Password" functionality.
