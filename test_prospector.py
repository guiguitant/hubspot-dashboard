"""
Full E2E test of Releaf Prospector as Vincent Mory (via Nathan admin account).
Tests: Login, Dashboard, Prospects, Campaigns, Archive, Imports, Logs, Rappels, Placeholders, Logout.
"""
from playwright.sync_api import sync_playwright
import time
import json
import os

SCREENSHOTS_DIR = '/tmp/prospector_tests'
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

BASE = 'http://localhost:3000'
NATHAN_EMAIL = 'nathangourdin@releafcarbon.com'
NATHAN_PIN = '19970705'
TARGET_ACCOUNT = 'Vincent Mory'

def screenshot(page, name):
    path = f'{SCREENSHOTS_DIR}/{name}.png'
    page.screenshot(path=path, full_page=True)
    print(f'  [screenshot] {path}')

def test_all():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()

        # Collect console errors
        errors = []
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)

        results = {}

        # ============================================================
        # TEST 1: Login as Nathan
        # ============================================================
        print('\n=== TEST 1: Login as Nathan ===')
        try:
            page.goto(f'{BASE}/prospector')
            page.wait_for_load_state('networkidle')
            time.sleep(1)
            screenshot(page, '01_login_page')

            # Should be redirected to login
            assert 'prospector-login' in page.url or page.locator('input[type="email"]').count() > 0, \
                f'Expected login page, got {page.url}'

            page.fill('input[type="email"]', NATHAN_EMAIL)
            page.fill('input[type="password"]', NATHAN_PIN)
            page.click('button[type="submit"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '02_after_login')

            # Should be on /prospector now
            assert 'prospector' in page.url, f'Expected /prospector, got {page.url}'
            results['login'] = 'PASS'
            print('  PASS: Logged in as Nathan')
        except Exception as e:
            results['login'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')
            screenshot(page, '02_login_fail')

        # ============================================================
        # TEST 2: Dashboard loads with stats
        # ============================================================
        print('\n=== TEST 2: Dashboard ===')
        try:
            page.goto(f'{BASE}/prospector#dashboard')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '03_dashboard')

            # Check stat cards exist
            stat_cards = page.locator('.stat-card').count()
            assert stat_cards == 4, f'Expected 4 stat cards, got {stat_cards}'

            # Check sidebar exists
            sidebar = page.locator('.sidebar').count()
            assert sidebar == 1, 'Sidebar not found'

            # Check sidebar links
            links = page.locator('.sidebar-link').count()
            assert links >= 7, f'Expected 7+ sidebar links, got {links}'

            results['dashboard'] = 'PASS'
            print(f'  PASS: Dashboard loaded, {stat_cards} stat cards, sidebar OK')
        except Exception as e:
            results['dashboard'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 3: Switch to Vincent Mory's account
        # ============================================================
        print('\n=== TEST 3: Switch to Vincent Mory ===')
        try:
            # Click account switch button
            switch_btn = page.locator('#accountSwitchBtn')
            assert switch_btn.is_visible(), 'Account switch button not visible (not admin?)'
            switch_btn.click()
            time.sleep(1)
            screenshot(page, '04_account_selector')

            # Find and click Vincent Mory
            vincent = page.locator('.account-selector-item', has_text=TARGET_ACCOUNT)
            assert vincent.count() > 0, f'Account "{TARGET_ACCOUNT}" not found in selector'
            vincent.click()
            time.sleep(2)
            screenshot(page, '05_switched_to_vincent')

            # Verify account name in sidebar
            account_name = page.locator('#currentAccountName').text_content()
            assert TARGET_ACCOUNT.lower() in account_name.lower(), \
                f'Expected "{TARGET_ACCOUNT}" in sidebar, got "{account_name}"'

            results['switch_account'] = 'PASS'
            print(f'  PASS: Switched to {TARGET_ACCOUNT}')
        except Exception as e:
            results['switch_account'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')
            screenshot(page, '05_switch_fail')

        # ============================================================
        # TEST 4: Prospects page
        # ============================================================
        print('\n=== TEST 4: Prospects page ===')
        try:
            page.click('.sidebar-link[data-page="prospects"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '06_prospects')

            # Quick filters should exist
            qf = page.locator('.qf-btn').count()
            assert qf >= 5, f'Expected 5+ quick filters, got {qf}'

            # Table should exist
            table = page.locator('table').count()
            assert table >= 1, 'Prospects table not found'

            results['prospects_page'] = 'PASS'
            print(f'  PASS: Prospects page loaded, {qf} quick filters')
        except Exception as e:
            results['prospects_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 5: Quick filter click
        # ============================================================
        print('\n=== TEST 5: Quick filter click ===')
        try:
            # Click "Nouveau" filter
            nouveau_btn = page.locator('.qf-btn', has_text='Nouveau')
            if nouveau_btn.count() > 0:
                nouveau_btn.click()
                time.sleep(1)
                screenshot(page, '07_filter_nouveau')
                assert nouveau_btn.first.evaluate('el => el.classList.contains("qf-active")'), \
                    'Nouveau filter not active after click'
                results['quick_filter'] = 'PASS'
                print('  PASS: Quick filter works')
            else:
                results['quick_filter'] = 'SKIP: No Nouveau filter found'
                print('  SKIP: No Nouveau filter')

            # Click back to All
            all_btn = page.locator('.qf-btn', has_text='Tous')
            if all_btn.count() > 0:
                all_btn.click()
                time.sleep(1)
        except Exception as e:
            results['quick_filter'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 6: Prospect detail (click first prospect)
        # ============================================================
        print('\n=== TEST 6: Prospect detail ===')
        try:
            first_row = page.locator('tbody tr a.row-link').first
            if first_row.count() > 0:
                first_row.click()
                page.wait_for_load_state('networkidle')
                time.sleep(2)
                screenshot(page, '08_prospect_detail')

                # Profile card should exist
                assert page.locator('.profile-card').count() > 0, 'Profile card not found'
                results['prospect_detail'] = 'PASS'
                print('  PASS: Prospect detail loaded')
            else:
                results['prospect_detail'] = 'SKIP: No prospects to click'
                print('  SKIP: No prospects')
        except Exception as e:
            results['prospect_detail'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 7: Campaigns page + tabs
        # ============================================================
        print('\n=== TEST 7: Campaigns page ===')
        try:
            page.click('.sidebar-link[data-page="campagnes"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '09_campaigns')

            # Check tabs exist
            active_tab = page.locator('.tab-btn', has_text='Actives')
            archived_tab = page.locator('.tab-btn', has_text='Archivées')
            assert active_tab.count() > 0, 'Active tab not found'
            assert archived_tab.count() > 0, 'Archived tab not found'

            # Click Archived tab
            archived_tab.click()
            time.sleep(1)
            screenshot(page, '10_campaigns_archived')

            # Click back to Active
            active_tab.click()
            time.sleep(1)

            results['campaigns_page'] = 'PASS'
            print('  PASS: Campaigns page with tabs OK')
        except Exception as e:
            results['campaigns_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 8: Campaign detail + Archive button
        # ============================================================
        print('\n=== TEST 8: Campaign detail + Archive ===')
        try:
            camp_card = page.locator('.camp-card').first
            if camp_card.count() > 0:
                camp_card.click()
                page.wait_for_load_state('networkidle')
                time.sleep(2)
                screenshot(page, '11_campaign_detail')

                # Check profile card
                assert page.locator('.profile-card').count() > 0, 'Campaign profile card not found'

                # Check archive button exists
                archive_btn = page.locator('button', has_text='Archiver')
                unarchive_btn = page.locator('button', has_text='Désarchiver')
                has_archive = archive_btn.count() > 0 or unarchive_btn.count() > 0
                assert has_archive, 'No Archive/Unarchive button found'

                # Check tabs (Prospects, Séquence, Review)
                tabs = page.locator('.tab-btn').count()
                assert tabs >= 3, f'Expected 3+ tabs in campaign detail, got {tabs}'

                results['campaign_detail'] = 'PASS'
                print(f'  PASS: Campaign detail loaded, archive button present')
            else:
                results['campaign_detail'] = 'SKIP: No campaigns to click'
                print('  SKIP: No campaigns')
        except Exception as e:
            results['campaign_detail'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 9: Imports page
        # ============================================================
        print('\n=== TEST 9: Imports page ===')
        try:
            page.click('.sidebar-link[data-page="imports"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '12_imports')

            # Should have a stepper or dropzone
            has_content = page.locator('.stepper').count() > 0 or page.locator('.dropzone').count() > 0
            assert has_content, 'Imports page has no stepper or dropzone'
            results['imports_page'] = 'PASS'
            print('  PASS: Imports page loaded')
        except Exception as e:
            results['imports_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 10: Logs page
        # ============================================================
        print('\n=== TEST 10: Logs page ===')
        try:
            page.click('.sidebar-link[data-page="logs"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '13_logs')

            # Should have filter selects
            selects = page.locator('select').count()
            assert selects >= 1, 'Logs page has no filter selects'
            results['logs_page'] = 'PASS'
            print('  PASS: Logs page loaded')
        except Exception as e:
            results['logs_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 11: Rappels page
        # ============================================================
        print('\n=== TEST 11: Rappels page ===')
        try:
            page.click('.sidebar-link[data-page="rappels"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '14_rappels')

            # Should have a select filter
            assert page.locator('select').count() >= 1, 'Rappels has no filter'
            results['rappels_page'] = 'PASS'
            print('  PASS: Rappels page loaded')
        except Exception as e:
            results['rappels_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 12: Placeholders page
        # ============================================================
        print('\n=== TEST 12: Placeholders page ===')
        try:
            page.click('.sidebar-link[data-page="placeholders"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '15_placeholders')

            results['placeholders_page'] = 'PASS'
            print('  PASS: Placeholders page loaded')
        except Exception as e:
            results['placeholders_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 13: Open new tab (session persistence)
        # ============================================================
        print('\n=== TEST 13: New tab session persistence ===')
        try:
            page2 = context.new_page()
            page2.goto(f'{BASE}/prospector#prospects')
            page2.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page2, '16_new_tab')

            # Should NOT be redirected to login
            assert 'prospector-login' not in page2.url, \
                f'New tab redirected to login: {page2.url}'
            # Should have the sidebar
            assert page2.locator('.sidebar').count() > 0, 'Sidebar not found in new tab'
            results['new_tab_session'] = 'PASS'
            print('  PASS: New tab preserves session')
            page2.close()
        except Exception as e:
            results['new_tab_session'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 14: Switch back to Nathan (re-switch)
        # ============================================================
        print('\n=== TEST 14: Re-switch account ===')
        try:
            page.goto(f'{BASE}/prospector#dashboard')
            page.wait_for_load_state('networkidle')
            time.sleep(1)

            switch_btn = page.locator('#accountSwitchBtn')
            if switch_btn.is_visible():
                switch_btn.click()
                time.sleep(1)
                screenshot(page, '17_reswitch_selector')

                # Should NOT show 403 error
                error_el = page.locator('.account-selector-error')
                if error_el.count() > 0:
                    results['reswitch'] = f'FAIL: Account selector error: {error_el.text_content()}'
                    print(f'  FAIL: {error_el.text_content()}')
                else:
                    # Click Nathan's account
                    nathan = page.locator('.account-selector-item', has_text='Nathan')
                    if nathan.count() > 0:
                        nathan.click()
                        time.sleep(2)
                        results['reswitch'] = 'PASS'
                        print('  PASS: Re-switched to Nathan')
                    else:
                        results['reswitch'] = 'PASS (selector opened without error)'
                        print('  PASS: Selector opened without 403')
            else:
                results['reswitch'] = 'SKIP: Switch button not visible'
                print('  SKIP: Switch button not visible')
        except Exception as e:
            results['reswitch'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 15: Logout
        # ============================================================
        print('\n=== TEST 15: Logout ===')
        try:
            logout_btn = page.locator('#logoutBtn')
            assert logout_btn.is_visible(), 'Logout button not visible'
            logout_btn.click()
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '18_after_logout')

            # Should be on login page
            assert 'prospector-login' in page.url, f'Expected login page after logout, got {page.url}'

            # localStorage should be cleared
            token = page.evaluate('localStorage.getItem("auth_token")')
            assert token is None, f'Token still in localStorage after logout: {token}'

            results['logout'] = 'PASS'
            print('  PASS: Logged out, redirected to login, localStorage cleared')
        except Exception as e:
            results['logout'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # REPORT
        # ============================================================
        print('\n' + '=' * 60)
        print('TEST RESULTS SUMMARY')
        print('=' * 60)
        pass_count = sum(1 for v in results.values() if v == 'PASS')
        fail_count = sum(1 for v in results.values() if 'FAIL' in str(v))
        skip_count = sum(1 for v in results.values() if 'SKIP' in str(v))

        for test, result in results.items():
            status = 'PASS' if result == 'PASS' else 'SKIP' if 'SKIP' in str(result) else 'FAIL'
            icon = {'PASS': '[OK]', 'FAIL': '[FAIL]', 'SKIP': '[SKIP]'}[status]
            print(f'  {icon} {test}: {result}')

        print(f'\n  Total: {pass_count} passed, {fail_count} failed, {skip_count} skipped')

        if errors:
            print(f'\n  Console errors ({len(errors)}):')
            for e in errors[:10]:
                print(f'    - {e[:120]}')

        screenshot(page, '19_final_state')
        browser.close()

        return fail_count == 0

if __name__ == '__main__':
    success = test_all()
    exit(0 if success else 1)
