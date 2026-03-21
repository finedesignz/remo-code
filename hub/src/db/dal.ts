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

// -- Sessions (server-level, no RLS — used by channel WS auth) --

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

// -- API Keys (server-level, bypasses RLS) --

export async function createApiKey(userId: string, keyHash: string) {
  // Revoke any existing active key
  await supabaseAdmin
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null)

  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .insert({ user_id: userId, key_hash: keyHash })
    .select('id, name, created_at')
    .single()
  if (error) throw error
  return data
}

export async function listApiKeys(sb: SupabaseClient) {
  const { data, error } = await sb
    .from('api_keys')
    .select('id, name, created_at, last_used_at, revoked_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function revokeApiKey(sb: SupabaseClient, id: string) {
  const { error } = await sb
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function verifyApiKey(keyHash: string) {
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('id, user_id, revoked_at')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .single()
  if (error || !data) return null
  // Update last_used_at (fire-and-forget)
  supabaseAdmin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id)
  return data
}

// -- Sessions (server-level, for plugin auto-registration) --

export async function findOrCreateSession(userId: string, projectDir: string, tokenHash: string) {
  const name = projectDir.split(/[/\\]/).filter(Boolean).pop() || 'unnamed'

  // Check for existing session with same project_dir
  const { data: existing } = await supabaseAdmin
    .from('sessions')
    .select('id, name')
    .eq('user_id', userId)
    .eq('project_dir', projectDir)
    .maybeSingle()

  if (existing) {
    // Rotate token on existing session
    await supabaseAdmin
      .from('sessions')
      .update({ token_hash: tokenHash })
      .eq('id', existing.id)
    return { id: existing.id, name: existing.name, created: false }
  }

  // Create new session
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .insert({ user_id: userId, name, project_dir: projectDir, token_hash: tokenHash })
    .select('id, name')
    .single()
  if (error) throw error
  return { id: data.id, name: data.name, created: true }
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
