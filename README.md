# Mouawa for iPhone and Android

The Mouawa social app as a native mobile app, built with **Expo (React Native)** and **Supabase**.

The app is a React Native shell around Mouawa's interface, which runs in a WebView. The shell adds:

- **Native features:** the status bar follows the app's theme, haptics, the system share sheet, the Android back button, and email links that open the app.
- **Supabase backend:** real email sign-up with a confirmation link, log in with email or username, password reset by email, shared posts with realtime updates, and photo and video storage.

## Try it on your phone (about 5 minutes)

You need a computer with [Node.js 20 or newer](https://nodejs.org) and the **Expo Go** app on your phone ([iPhone](https://apps.apple.com/app/expo-go/id982107779) · [Android](https://play.google.com/store/apps/details?id=host.exp.exponent)).

```bash
git clone https://github.com/oddane/mouawa.git
cd mouawa
npm install
npx expo install --fix        # lines package versions up with your Expo SDK
npx expo start
```

Scan the QR code. On iPhone, use the Camera app; on Android, scan from inside Expo Go. Your phone and computer need to be on the same Wi-Fi network. If they aren't, run `npx expo start --tunnel`.

> **"Project is incompatible with this version of Expo Go"?** Expo Go only runs the newest Expo SDK. Run `npx expo install expo@latest` and then `npx expo install --fix`, and start again.

## One-time Supabase settings (dashboard)

These two settings can't be changed through the API this project was set up with, so you set them by hand:

1. **Redirect URLs** (Authentication → URL Configuration): https://supabase.com/dashboard/project/qmqdznhtdhpbtgxtovcq/auth/url-configuration
   - Add `mouawa://**` (installed builds) and `exp://**` (Expo Go).
   - Without these, links in confirmation and reset emails open a browser page instead of the app. The email still gets confirmed, and you can then log in by hand.
2. **Email sending** (Authentication → Emails → SMTP Settings): Supabase's built-in email sender only sends a handful of emails per hour and is meant for testing. Before real people sign up, connect your own SMTP provider (Resend, Postmark, SES, …).
   - For quick solo testing, you can instead turn off **Confirm email** under Authentication → Sign In / Providers → Email.

**The first person to sign up becomes the admin.** The admin can approve organization checkmarks under Moderation.

## Install it like a real app (EAS Build)

```bash
npm install -g eas-cli
eas login
eas build --profile preview --platform android   # an .apk you can install directly
eas build --profile preview --platform ios       # needs an Apple Developer account ($99/year)
```

When it's ready for the stores, use `eas build --profile production` and then `eas submit`. Before submitting, change `ios.bundleIdentifier` and `android.package` in `app.json` (currently `com.oddane.mouawa`) to identifiers you own.

## How it's put together

| Path | What it is |
|---|---|
| `App.js` | The native shell: WebView, saved session (AsyncStorage), deep links, haptics, share, back button, theme-aware status bar |
| `src/mouawaHtml.js` | The Mouawa interface as a string module (generated, don't edit) |
| `web/mouawa.html` | The full Mouawa page built for the app |
| `web/src/shim.js` | Connects Mouawa's data layer to Supabase (documents, realtime, storage, auth) |
| `web/src/native.js` | App-only account flows: email confirmation, email or username log in, password reset, log out |
| `supabase/` | Database migrations and the `login` edge function (username → account, done on the server) |

To update the interface, replace `web/mouawa.html` and run `npm run build:web`.

### Data model

Mouawa stores everything as documents (`posts/abc`, `profiles/xyz`, `convos/c1/msgs/m9`) in one `docs` table, with row-level security:

- **Private data:** anything under `data/users/<your user id>/` (your session, settings and email) is readable and writable only by you.
- **Everything else:** readable by signed-in people. Profiles are also readable before sign-in, so the sign-up form can check whether a username is free.
- **Realtime:** posts, likes, messages and alerts arrive live through Supabase Realtime.
- **Media:** photos and videos go to the public `blobs` storage bucket.

### Known limits in this version

- **Write access is too open for a public launch.** Any signed-in account can write shared documents, matching how the original Mouawa prototype worked. Before opening to the public, tighten the `docs` policies so people can only edit their own posts and profiles.
- **Some features aren't available in the app yet.** Ask Mouawa (the AI assistant), live typing and "who's here" presence, and file exports depended on Claude's artifact runtime.
- **Fonts need internet the first time.** The interface loads Inter from Google Fonts and Supabase's client library from a CDN on first launch, so it needs a connection. Without one, it shows an offline screen with a retry button.
