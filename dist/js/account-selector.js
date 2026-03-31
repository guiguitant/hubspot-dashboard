/**
 * Account Selector Component
 * Displays account selection UI and handles selection
 */

class AccountSelector {
  constructor() {
    this.container = null;
    this.accounts = [];
  }

  // Create the selector UI
  create() {
    const html = `
      <div id="accountSelectorOverlay" class="account-selector-overlay">
        <div class="account-selector-modal">
          <div class="account-selector-header">
            <h1>🌿 Releaf Prospector</h1>
            <p>Sélectionnez votre compte</p>
          </div>
          <div id="accountList" class="account-selector-list">
            <div class="spinner">Chargement des comptes...</div>
          </div>
          <div class="account-selector-footer">
            <p style="font-size: 12px; color: #666; margin: 0;">
              Aucun compte ? Contactez l'administrateur
            </p>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    this.container = document.getElementById('accountSelectorOverlay');
  }

  // Load and display accounts
  async show() {
    // If selector already exists, remove it
    const existing = document.getElementById('accountSelectorOverlay');
    if (existing) existing.remove();

    this.create();

    try {
      const accounts = await accountContext.fetchAccounts();

      if (!accounts || accounts.length === 0) {
        this.displayError('Aucun compte disponible');
        return;
      }

      this.displayAccounts(accounts);
    } catch (error) {
      console.error('Error loading accounts:', error);
      this.displayError('Erreur lors du chargement des comptes: ' + error.message);
    }
  }

  // Display list of accounts
  displayAccounts(accounts) {
    const accountList = document.getElementById('accountList');

    const html = accounts.map(account => `
      <div class="account-selector-item" data-account-id="${account.id}">
        <div class="account-selector-name">${account.name}</div>
        <div class="account-selector-slug">@${account.slug}</div>
        ${account.email ? `<div class="account-selector-email">${account.email}</div>` : ''}
      </div>
    `).join('');

    accountList.innerHTML = html;

    // Add click handlers
    document.querySelectorAll('.account-selector-item').forEach(item => {
      item.addEventListener('click', async () => {
        const accountId = item.getAttribute('data-account-id');
        const account = accounts.find(a => a.id === accountId);
        try {
          await this.selectAccount(account);
        } catch (error) {
          console.error('Failed to select account:', error);
        }
      });
    });
  }

  // Handle account selection
  async selectAccount(account) {
    await accountContext.setAccount(account);
    this.hide();

    // Notify app that account was selected
    // Note: account-changed is also dispatched by accountContext.setAccount()
    document.dispatchEvent(new CustomEvent('account-selected', { detail: account }));
  }

  // Hide selector
  hide() {
    if (this.container) {
      this.container.remove();
    }
  }

  // Display error message
  displayError(message) {
    const accountList = document.getElementById('accountList');
    accountList.innerHTML = `<div class="account-selector-error">${message}</div>`;
  }

  // Check if we need to show the selector
  static async checkAndShow() {
    if (!accountContext.isAccountSelected()) {
      const selector = new AccountSelector();
      await selector.show();
    }
  }
}

// Export for global use
window.AccountSelector = AccountSelector;

// Auto-show on page load if no account selected
// IMPORTANT: This blocks DOM content from being fully interactive until account is selected
document.addEventListener('DOMContentLoaded', async () => {
  if (!accountContext.isAccountSelected()) {
    // Prevent other scripts from running until account is selected
    const blocker = document.createElement('div');
    blocker.id = 'accountSelectorBlocker';
    blocker.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(255, 255, 255, 0.95);
      z-index: 9998;
    `;
    document.body.appendChild(blocker);

    const selector = new AccountSelector();
    await selector.show();

    // Remove blocker when account is selected
    document.addEventListener('account-selected', () => {
      const blocker = document.getElementById('accountSelectorBlocker');
      if (blocker) blocker.remove();
    });
  }
});
