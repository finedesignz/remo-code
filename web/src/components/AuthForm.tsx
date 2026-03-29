import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '../lib/supabase'
import { useTheme } from '../hooks/useTheme'

export function AuthForm() {
  const { theme } = useTheme()

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8">
        <img src="/logo.png" alt="Remo Code" className="h-12 mx-auto mb-4" />
        <h1 className="text-3xl font-bold text-center mb-2 text-[var(--text-primary)]">Remo Code</h1>
        <p className="text-center text-[var(--text-muted)] mb-8">
          Remote access to your Claude Code sessions
        </p>
        <Auth
          supabaseClient={supabase}
          appearance={{
            theme: ThemeSupa,
            variables: {
              default: {
                colors: {
                  brand: '#6366f1',
                  brandAccent: '#818cf8',
                },
              },
            },
          }}
          theme={theme}
          providers={[]}
        />
      </div>
    </div>
  )
}
