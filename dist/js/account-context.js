/**
 * Account Context Manager
 * Single source of truth for authentication and account state.
 *
 * Keys in localStorage:
 *   auth_token    — JWT Bearer token (never changes after login, even on admin switch)
 *   account_id    — logged-in user's account ID
 *   account_name  — logged-in user's account name
 *   is_admin      — 'true' | 'false'
 *   switch_account_id   — (admin only) ID of the account currently being viewed
 *   switch_account_name — (admin only) name of that account
 */

class AccountContext {
  constructor() {
    // The "own" account (from login)
    this.ownAccountId = localStorage.getItem('account_id') || null;
    this.ownAccountName = localStorage.getItem('account_name') || null;
    this.isAdmin = localStorage.getItem('is_admin') === 'true';

    // Admin switch state (null = viewing own account)
    this.switchedAccountId = localStorage.getItem('switch_account_id') || null;
    this.switchedAccountName = localStorage.getItem('switch_account_name') || null;
  }

  // The account ID used for data queries (own or switched)
  getAccountId() {
    return this.switchedAccountId || this.ownAccountId;
  }

  // The display name for the current account
  getAccountName() {
    return this.switchedAccountName || this.ownAccountName || '';
  }

  // The account object (for header display)
  getAccount() {
    return {
      id: this.getAccountId(),
      name: this.getAccountName(),
    };
  }

  getIsAdmin() {
    return this.isAdmin;
  }

  isAccountSelected() {
    return !!this.getAccountId();
  }

  // Get the X-Switch-Account value (null if viewing own account)
  getSwitchAccountId() {
    return this.switchedAccountId;
  }

  // Called after login to set the own account (no API call needed)
  setOwnAccount(id, name) {
    this.ownAccountId = id;
    this.ownAccountName = name;
    this.switchedAccountId = null;
    this.switchedAccountName = null;
    localStorage.removeItem('switch_account_id');
    localStorage.removeItem('switch_account_name');
    document.dispatchEvent(new CustomEvent('account-changed', { detail: this.getAccount() }));
  }

  // Admin switches to another account (JWT stays the same!)
  switchToAccount(account) {
    if (!this.isAdmin) return;
    this.switchedAccountId = account.id;
    this.switchedAccountName = account.name;
    localStorage.setItem('switch_account_id', account.id);
    localStorage.setItem('switch_account_name', account.name);
    document.dispatchEvent(new CustomEvent('account-changed', { detail: account }));
  }

  // Admin switches back to own account
  switchToOwnAccount() {
    this.switchedAccountId = null;
    this.switchedAccountName = null;
    localStorage.removeItem('switch_account_id');
    localStorage.removeItem('switch_account_name');
    document.dispatchEvent(new CustomEvent('account-changed', { detail: this.getAccount() }));
  }

  // Fetch all accounts (admin only — will 403 for non-admin)
  async fetchAccounts() {
    try {
      const response = await fetch('/api/accounts');
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : (data.accounts || []);
    } catch (error) {
      console.error('Error fetching accounts:', error);
      return [];
    }
  }

  // Check if JWT token is expired (decode payload without verification)
  static isTokenExpired() {
    const token = localStorage.getItem('auth_token');
    if (!token) return true;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 < Date.now();
    } catch (e) {
      return true;
    }
  }

  // Clear everything and redirect to login
  static logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('account_id');
    localStorage.removeItem('account_name');
    localStorage.removeItem('is_admin');
    localStorage.removeItem('switch_account_id');
    localStorage.removeItem('switch_account_name');
    window.location.href = '/prospector-login';
  }

  // Get the Bearer token
  static getToken() {
    return localStorage.getItem('auth_token');
  }
}

// Global instance
const accountContext = new AccountContext();

/**
 * API Client — thin wrapper around fetch for JSON endpoints.
 * Auth headers are injected by the global fetch wrapper in prospector.html.
 */
class APIClient {
  static async fetch(url, options = {}) {
    if (!accountContext.getAccountId()) {
      throw new Error('No account selected.');
    }
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    return fetch(url, { ...options, headers });
  }

  static get(url) { return this.fetch(url, { method: 'GET' }); }
  static post(url, data) { return this.fetch(url, { method: 'POST', body: JSON.stringify(data) }); }
  static put(url, data) { return this.fetch(url, { method: 'PUT', body: JSON.stringify(data) }); }
  static delete(url) { return this.fetch(url, { method: 'DELETE' }); }
}

// Export for global use
window.AccountContext = AccountContext;
window.accountContext = accountContext;
window.APIClient = APIClient;
