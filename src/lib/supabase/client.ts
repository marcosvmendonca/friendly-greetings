import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The Lovable preview renders the app inside a cross-site iframe.
      // Modern browsers refuse to persist cookies written via
      // `document.cookie` from a third-party context unless they are
      // explicitly SameSite=None; Secure. Without this, `signInWithPassword`
      // returns 200, but the browser drops the sb-*-auth-token cookies,
      // the full-page nav to /dashboard has no session, and middleware
      // bounces the user back to /login (form clears — looks like a reload).
      cookieOptions: {
        sameSite: 'none',
        secure: true,
        path: '/',
      },
    }
  )

  return browserClient
}
