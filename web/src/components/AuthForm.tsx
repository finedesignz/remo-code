import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '../lib/supabase'

export function AuthForm() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-900">
      <div className="w-full max-w-md p-8">
        <h1 className="text-3xl font-bold text-center mb-2 text-white">Remo Code</h1>
        <p className="text-center text-slate-400 mb-8">
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
          theme="dark"
          providers={[]}
        />
      </div>
    </div>
  )
}
