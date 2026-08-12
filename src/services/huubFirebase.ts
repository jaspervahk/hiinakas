// A second, independently-named Firebase app instance pointed at Huub's
// project (a separate live multiplayer OFC app, separate Firebase project),
// so the Live Coach page can read the user's own live Huub game directly via
// the normal client SDK — no bridge, no new backend. Huub's own
// firestore.rules already scope games/{id} and games/{id}/playerHands/{uid}
// reads to request.auth.uid being a participant, so a plain client sign-in
// here gets exactly the same read access Huub's own GameContext.tsx relies
// on. Hardcoded (not env-var'd like src/firebase.ts's own config) because
// this is Huub's *public* web config, not a secret — Huub's own repo commits
// these same values in plain text in src/services/firebase.ts.
import { initializeApp, getApps, getApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const HUUB_APP_NAME = 'huub'

const huubConfig = {
  apiKey: 'AIzaSyAFNZ46R7ZlccSQ3sC52Oao26NHJv5c4T4',
  authDomain: 'huub-c4e5b.firebaseapp.com',
  projectId: 'huub-c4e5b',
  storageBucket: 'huub-c4e5b.firebasestorage.app',
  messagingSenderId: '453674862477',
  appId: '1:453674862477:web:6a44f1efdb9c8083b81fc4',
}

const huubApp = getApps().some(a => a.name === HUUB_APP_NAME)
  ? getApp(HUUB_APP_NAME)
  : initializeApp(huubConfig, HUUB_APP_NAME)

export const huubAuth = getAuth(huubApp)
export const huubDb = getFirestore(huubApp)
export const huubGoogleProvider = new GoogleAuthProvider()
