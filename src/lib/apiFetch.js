import { supabase } from './supabase'

// State management for API context
let _activeAccountId = null
let _authAccountIsAdmin = false

export const setApiFetchContext = (activeAccountId, isAdmin) => {
  _activeAccountId = activeAccountId
  _authAccountIsAdmin = isAdmin
}

export const apiFetch = async (url, options = {}) => {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  if (!token) {
    throw new Error('No session available')
  }

  // If admin has switched accounts, send X-Switch-Account header
  const switchHeader = _authAccountIsAdmin && _activeAccountId
    ? { 'X-Switch-Account': _activeAccountId }
    : {}

  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      'Authorization': `Bearer ${token}`,
      ...switchHeader,
    },
  })
}
