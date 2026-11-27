# bhaJami Public Launch & Production Deployment Checklist

Reference checklist for taking `bhaJami` (`saibhajanverse`) from local LAN preview to public Web, Android, and iOS release.

---

## 1. Web Hosting (Firebase App Hosting — Next.js SSR)

- **Configuration files added**:
  - `apphosting.yaml` (Cloud Run sizing, build/runtime env vars, Secret Manager references)
  - `firebase.json` (`apphosting.backendId: "bhajami-web"`, `rootDir: "/"`)
- **Prerequisites**:
  1. Ensure `saibhajanverse` is on the Firebase **Blaze** billing plan:
     `https://console.firebase.google.com/project/saibhajanverse/overview?purchaseBillingPlan=metered`
  2. Set required Secret Manager secrets via Firebase CLI before first deploy:
     ```sh
     npx -y firebase-tools@latest apphosting:secrets:set NEXT_PUBLIC_FIREBASE_API_KEY --project saibhajanverse
     npx -y firebase-tools@latest apphosting:secrets:set NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID --project saibhajanverse
     npx -y firebase-tools@latest apphosting:secrets:set NEXT_PUBLIC_FIREBASE_APP_ID --project saibhajanverse
     npx -y firebase-tools@latest apphosting:secrets:set FIREBASE_SERVICE_ACCOUNT_JSON --project saibhajanverse
     npx -y firebase-tools@latest apphosting:secrets:set RESEND_API_KEY --project saibhajanverse
     ```
  3. Create & connect the App Hosting backend (`bhajami-web` on `eezyal/bhajami` branch `main`) or run:
     ```sh
     npx -y firebase-tools@latest deploy --only apphosting --project saibhajanverse
     ```
  4. Once custom DNS is attached:
     - Update `NEXT_PUBLIC_APP_URL` in `apphosting.yaml` to the canonical `https://...` domain.
     - Add DNS `A` / `AAAA` / `TXT` verification records shown in Firebase Console → App Hosting → Custom Domains.

## 2. Firebase Authentication & Domain Authorization

- Open **Firebase Console → Authentication → Settings → Authorized domains** (`saibhajanverse`):
  - Keep `saibhajanverse.firebaseapp.com`, `saibhajanverse.web.app`, `localhost`.
  - Add the App Hosting backend domain (`*.hosted.app`) and your final custom domain (`bhajami.org` / `www.bhajami.org` or chosen domain).
- Verify Google OAuth brand display name (`bhaJami`), support email (`pschax@gmail.com`), and authorized redirect URIs include `https://<custom-domain>/__/auth/handler`.

## 3. Firestore Security Rules & Composite Indexes

- **Security Rules (`firestore.rules`)**: Already deployed to `saibhajanverse` (`7d4a3b6`).
- **Composite Indexes (`firestore.indexes.json`) Audit**:
  - `lyricCorrections`: `(status ASC, createdAt DESC)` — used by moderation queues.
  - `bhajans`: `(deity ASC, title ASC)` — used by browse/filter queries.
  - `bhajans`: `(matchStatus ASC, updatedAt DESC)` — used by Admin Daily Curation `needs_verification` queue.
  - `bhajans`: `(lyricsMissing ASC, updatedAt DESC)` — used by Admin Daily Curation `missing_lyrics` queue.
  - `ingestionRuns`: `(source ASC, startedAt DESC)` — used by Pipeline Health runs query.
  - Single-field queries (`bhajamiOverride == true` ordered by `__name__`, `entityAliases.source == 'admin_merge'`, `youtubeVideos.classification == 'ambiguous_long'`, `doNotMergePairs` ordered by `createdAt DESC`) are covered automatically by Firestore single-field indexes.
- Deploy/re-verify indexes whenever `firestore.indexes.json` changes:
  ```sh
  npx -y firebase-tools@latest deploy --only firestore:indexes --project saibhajanverse
  ```

## 4. Android & iOS Mobile Production Builds (Expo EAS)

- **Configuration files**:
  - `apps/mobile/app.json` (Bundle ID `com.saibhajanverse.bhajami`, `UIBackgroundModes: ["audio"]`, `expo-splash-screen` dark devotional background `#12101a`, versionCode `1` / buildNumber `1`).
  - `apps/mobile/eas.json` (`development`, `preview` internal APK/TestFlight, `production` AAB/App Store).
- **Pre-build store asset checklist (manual before `eas build --profile production`)**:
  - Generate/add app icon PNG (`1024x1024` RGB no-alpha for iOS, `1024x1024` foreground + `#12101a` background for Android adaptive icon) and splash icon PNG under `apps/mobile/assets/`, referencing them in `apps/mobile/app.json`.
  - Finalize splash screen color theme/photo backdrop once design deliberation concludes.
  - Configure `EXPO_PUBLIC_API_BASE_URL` in EAS environment (`https://<production-web-domain>`).
- **Build & submit commands**:
  ```sh
  cd apps/mobile
  npx eas login
  npx eas build --platform all --profile preview      # Internal APK + TestFlight verification
  npx eas build --platform all --profile production   # Play Store AAB + App Store IPA
  npx eas submit --platform all --profile production
  ```
