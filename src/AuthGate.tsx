import { useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import { auth, googleProvider, ALLOWED_UID } from './firebase'

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'denied'; email: string | null; uid: string }
  | { status: 'allowed'; user: User }

function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      if (!user) {
        setState({ status: 'signed-out' })
      } else if (user.uid === ALLOWED_UID) {
        setState({ status: 'allowed', user })
      } else {
        setState({ status: 'denied', email: user.email, uid: user.uid })
      }
    })
  }, [])

  return state
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const state = useAuthState()

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-gray-400 text-sm">Loading…</div>
      </div>
    )
  }

  if (state.status === 'signed-out') {
    return <SignInScreen />
  }

  if (state.status === 'denied') {
    return <DeniedScreen email={state.email} uid={state.uid} />
  }

  return <>{children}</>
}

function SignInScreen() {
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn() {
    setError(null)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="bg-gray-900 rounded-2xl p-10 flex flex-col items-center gap-6 shadow-xl max-w-sm w-full mx-4">
        <h1 className="text-white text-2xl font-semibold tracking-tight">Hiinakas</h1>
        <button
          onClick={() => void handleSignIn()}
          className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-900 font-medium py-3 px-6 rounded-xl transition-colors"
        >
          <GoogleIcon />
          Sign in with Google
        </button>
        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
      </div>
    </div>
  )
}

function DeniedScreen({ email, uid }: { email: string | null; uid: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="bg-gray-900 rounded-2xl p-10 flex flex-col items-center gap-6 shadow-xl max-w-sm w-full mx-4">
        <h1 className="text-white text-xl font-semibold">Access Denied</h1>
        <p className="text-gray-400 text-sm text-center">
          {email ? `${email} is not authorized.` : 'This account is not authorized.'}
        </p>
        <div className="w-full bg-gray-800 rounded-lg p-3">
          <p className="text-gray-500 text-xs mb-1">Your UID (copy this):</p>
          <p className="text-gray-300 text-xs font-mono break-all select-all">{uid}</p>
        </div>
        <button
          onClick={() => void signOut(auth)}
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.615 24 12.255 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 000 10.76l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.64 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
      />
    </svg>
  )
}
