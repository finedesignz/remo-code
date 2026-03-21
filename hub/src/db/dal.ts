import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './supabase'

// -- Sessions (user-scoped via RLS) --

export async function listSessions(sb: SupabaseClient) {
  const { data, error } = await sb
    .from('sessions')
    .select('id, name, project_dir, status, last_activity, created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getSession(sb: SupabaseClient, id: string) {
  const { data, error } = await sb
    .from('sessions')
    .select('id, name, project_dir, status, last_activity, created_at')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

export async function createSession(sb: SupabaseClient, userId: string, name: string, projectDir: string | null, tokenHash: string) {
  const { data, error } = await sb
    .from('sessions')
    .insert({ user_id: userId, name, project_dir: projectDir, token_hash: tokenHash })
    .select('id, name, project_dir, status, created_at')
    .single()
  if (error) throw error
  return data
}

export async function deleteSession(sb: SupabaseClient, id: string) {
  const { error } = await sb.from('sessions').delete().eq('id', id)
  if (error) throw error
}

export async function updateSessionToken(sb: SupabaseClient, id: string, tokenHash: string) {
  const { error } = await sb.from('sessions').update({ token_hash: tokenHash }).eq('id', id)
  if (error) throw error
}

// -- Sessions (admin, no RLS — used by channel WS auth) --

export async function verifyChannelToken(sessionId: string) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, user_id, token_hash')
    .eq('id', sessionId)
    .single()
  if (error) return null
  return data
}

export async function setSessionStatus(sessionId: string, status: 'online' | 'offline' | 'thinking') {
  await supabaseAdmin
    .from('sessions')
    .update({ status, last_activity: new Date().toISOString() })
    .eq('id', sessionId)
}

// -- Messages (user-scoped via RLS) --

export async function getMessages(sb: SupabaseClient, sessionId: string, limit = 50, before?: string) {
  let query = sb
    .from('messages')
    .select('id, session_id, role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (before) {
    query = query.lt('created_at', before)
  }

  const { data, error } = await query
  if (error) throw error
  return (data || []).reverse()
}

export async function insertMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({ session_id: sessionId, role, content })
    .select('id, session_id, role, content, created_at')
    .single()
  if (error) throw error
  return data
}
