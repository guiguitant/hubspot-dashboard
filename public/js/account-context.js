/**
 * Account Context Manager
 * Handles account selection, storage, and API header injection
 */

class AccountContext {
  constructor() {
    this.currentAccount = null;
    this.accounts = [];
    this.loadFromSession();
  }

  // Load account from session storage
  loadFromSession() {
    const stored = sessionStorage.getItem('releaf_account');
    if (stored) {
      try {
        this.currentAccount = JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse stored account:', e);
        sessionStorage.removeItem('releaf_account');
      }
    }
  }

  // Save account to session storage
  saveToSession() {
    if (this.currentAccount) {
      sessionStorage.setItem('releaf_account', JSON.stringify(this.currentAccount));
    }
  }

  // Set current account
  setAccount(account) {
    this.currentAccount = account;
    this.saveToSession();
    document.dispatchEvent(new CustomEvent('account-changed', { detail: account }));
  }

  // Get current account
  getAccount() {
    return this.currentAccount;
  }

  // Get account ID for API headers
  getAccountId() {
    return this.currentAccount?.id || null;
  }

  // Fetch all available accounts
  async fetchAccounts() {
    try {
      const response = await fetch('/api/accounts');
      if (!response.ok) throw new Error('Failed to fetch accounts');
      this.accounts = await response.json();
      return this.accounts;
    } catch (error) {
      console.error('Error fetching accounts:', error);
      return [];
    }
  }

  // Check if account is selected
  isAccountSelected() {
    return !!this.currentAccount;
  }
}

// Global instance
const accountContext = new AccountContext();

/**
 * API Client with automatic account header injection
 */
class APIClient {
  static async fetch(url, options = {}) {
    const accountId = accountContext.getAccountId();

    if (!accountId) {
      throw new Error('No account selected. Please select an account first.');
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-Account-Id': accountId,
      ...(options.headers || {})
    };

    const fetchOptions = {
      ...options,
      headers
    };

    const response = await fetch(url, fetchOptions);

    // If unauthorized (account mismatch), clear session
    if (response.status === 400 || response.status === 404) {
      const json = await response.json();
      if (json.error && json.error.includes('account')) {
        accountContext.currentAccount = null;
        accountContext.saveToSession();
      }
    }

    return response;
  }

  static async get(url) {
    return this.fetch(url, { method: 'GET' });
  }

  static async post(url, data) {
    return this.fetch(url, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  static async put(url, data) {
    return this.fetch(url, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  static async delete(url) {
    return this.fetch(url, { method: 'DELETE' });
  }
}

// Export for global use
window.AccountContext = AccountContext;
window.accountContext = accountContext;
window.APIClient = APIClient;
