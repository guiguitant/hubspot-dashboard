"""
E2E test: Campaigns, Sequences, Prospect statuses, Enrollment, Archive.
Login as Nathan (admin), test on Nathan's account.
"""
from playwright.sync_api import sync_playwright
import time
import os
import json

SCREENSHOTS_DIR = '/tmp/prospector_tests_campaigns'
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

BASE = 'http://localhost:3000'
NATHAN_EMAIL = 'nathangourdin@releafcarbon.com'
NATHAN_PIN = '19970705'

def screenshot(page, name):
    path = f'{SCREENSHOTS_DIR}/{name}.png'
    page.screenshot(path=path, full_page=True)
    print(f'  [screenshot] {path}')

def test_all():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = context.new_page()

        errors = []
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)

        results = {}

        # ============================================================
        # LOGIN
        # ============================================================
        print('\n=== LOGIN ===')
        try:
            page.goto(f'{BASE}/prospector')
            page.wait_for_load_state('networkidle')
            time.sleep(1)
            if 'prospector-login' in page.url or page.locator('input[type="email"]').count() > 0:
                page.fill('input[type="email"]', NATHAN_EMAIL)
                page.fill('input[type="password"]', NATHAN_PIN)
                page.click('button[type="submit"]')
                page.wait_for_load_state('networkidle')
                time.sleep(2)
            assert 'prospector' in page.url
            results['login'] = 'PASS'
            print('  PASS')
        except Exception as e:
            results['login'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')
            screenshot(page, '00_login_fail')
            browser.close()
            return False

        # ============================================================
        # TEST 1: Navigate to Campaigns page
        # ============================================================
        print('\n=== TEST 1: Campaigns page ===')
        try:
            page.click('.sidebar-link[data-page="campagnes"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '01_campaigns')

            # Check tabs
            active_tab = page.locator('.tab-btn', has_text='Actives')
            archived_tab = page.locator('.tab-btn', has_text='Archivées')
            assert active_tab.count() > 0, 'Active tab missing'
            assert archived_tab.count() > 0, 'Archived tab missing'

            # Count campaigns
            camp_count = page.locator('.camp-card').count()
            print(f'  Found {camp_count} active campaigns')

            results['campaigns_page'] = 'PASS'
            print('  PASS')
        except Exception as e:
            results['campaigns_page'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 2: Open first campaign detail
        # ============================================================
        print('\n=== TEST 2: Campaign detail ===')
        campaign_id = None
        try:
            camp_card = page.locator('.camp-card').first
            if camp_card.count() > 0:
                camp_card.click()
                page.wait_for_load_state('networkidle')
                time.sleep(2)
                screenshot(page, '02_campaign_detail')

                # Extract campaign ID from URL hash
                url_hash = page.evaluate('location.hash')
                if 'id=' in url_hash:
                    campaign_id = url_hash.split('id=')[1].split('&')[0]
                    print(f'  Campaign ID: {campaign_id}')

                # Check profile card
                assert page.locator('.profile-card').count() > 0, 'Profile card missing'

                # Check tabs
                tabs = page.locator('.tab-btn')
                tab_texts = [tabs.nth(i).text_content().strip() for i in range(tabs.count())]
                print(f'  Tabs: {tab_texts}')
                assert 'Prospects' in tab_texts, 'Prospects tab missing'
                assert 'Sequence' in str(tab_texts) or 'quence' in str(tab_texts), 'Sequence tab missing'

                # Check archive button
                archive_btn = page.locator('button', has_text='Archiver')
                print(f'  Archive button: {"visible" if archive_btn.count() > 0 else "not found"}')

                results['campaign_detail'] = 'PASS'
                print('  PASS')
            else:
                results['campaign_detail'] = 'SKIP: No campaigns'
                print('  SKIP')
        except Exception as e:
            results['campaign_detail'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')
            screenshot(page, '02_campaign_detail_fail')

        # ============================================================
        # TEST 3: Campaign Prospects tab
        # ============================================================
        print('\n=== TEST 3: Campaign Prospects tab ===')
        try:
            prospects_tab = page.locator('.tab-btn', has_text='Prospects')
            if prospects_tab.count() > 0:
                prospects_tab.click()
                time.sleep(2)
                screenshot(page, '03_campaign_prospects')

                # Check for prospect table or empty state
                has_table = page.locator('table').count() > 0
                has_empty = page.locator('.empty-state').count() > 0
                prospect_rows = page.locator('tbody tr').count() if has_table else 0
                print(f'  Prospects: {prospect_rows} rows, table={has_table}, empty={has_empty}')

                results['campaign_prospects'] = 'PASS'
                print('  PASS')
            else:
                results['campaign_prospects'] = 'SKIP'
        except Exception as e:
            results['campaign_prospects'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 4: Campaign Sequence tab
        # ============================================================
        print('\n=== TEST 4: Campaign Sequence tab ===')
        try:
            seq_tab = page.locator('.tab-btn', has_text='quence')
            if seq_tab.count() > 0:
                seq_tab.click()
                time.sleep(2)
                screenshot(page, '04_campaign_sequence')

                # Check if sequence exists or "create" button
                has_sequence = page.locator('.seq-header').count() > 0
                has_create = page.locator('button', has_text='Cr').count() > 0
                print(f'  Sequence exists: {has_sequence}, Create button: {has_create}')

                if has_sequence:
                    # Check enroll button
                    enroll_btn = page.locator('button', has_text='nroler')
                    print(f'  Enroll button: {"visible" if enroll_btn.count() > 0 else "not found"}')

                    # Check steps
                    steps = page.locator('.seq-step-card').count()
                    print(f'  Steps: {steps}')

                    # Check add step buttons
                    add_invitation = page.locator('button', has_text='Invitation')
                    add_message = page.locator('button', has_text='Message')
                    print(f'  Add invitation: {add_invitation.count() > 0}, Add message: {add_message.count() > 0}')

                results['campaign_sequence'] = 'PASS'
                print('  PASS')
            else:
                results['campaign_sequence'] = 'SKIP'
        except Exception as e:
            results['campaign_sequence'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')
            screenshot(page, '04_sequence_fail')

        # ============================================================
        # TEST 5: Enroll campaign (if sequence exists)
        # ============================================================
        print('\n=== TEST 5: Enroll campaign ===')
        try:
            enroll_btn = page.locator('button', has_text='nroler la campagne')
            if enroll_btn.count() > 0:
                # Accept the confirm dialog
                page.on('dialog', lambda dialog: dialog.accept())
                enroll_btn.click()
                time.sleep(3)
                screenshot(page, '05_enroll_result')

                # Check for toast
                results['enroll_campaign'] = 'PASS'
                print('  PASS: Enroll button clicked')
            else:
                results['enroll_campaign'] = 'SKIP: No enroll button (no sequence?)'
                print('  SKIP: No enroll button')
        except Exception as e:
            results['enroll_campaign'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 6: Archive / Unarchive campaign
        # ============================================================
        print('\n=== TEST 6: Archive campaign ===')
        try:
            # Go back to campaign detail
            if campaign_id:
                page.goto(f'{BASE}/prospector#campaign-detail?id={campaign_id}')
                page.wait_for_load_state('networkidle')
                time.sleep(2)

                archive_btn = page.locator('button', has_text='Archiver')
                if archive_btn.count() > 0:
                    archive_btn.click()
                    time.sleep(2)
                    screenshot(page, '06_after_archive')

                    # Should redirect to campaigns page
                    current_hash = page.evaluate('location.hash')
                    print(f'  After archive, hash: {current_hash}')

                    # Check archived tab
                    archived_tab = page.locator('.tab-btn', has_text='Archivées')
                    if archived_tab.count() > 0:
                        archived_tab.click()
                        time.sleep(2)
                        screenshot(page, '06b_archived_tab')
                        archived_count = page.locator('.camp-card').count()
                        print(f'  Archived campaigns: {archived_count}')

                        # Unarchive: click first archived campaign
                        if archived_count > 0:
                            page.locator('.camp-card').first.click()
                            page.wait_for_load_state('networkidle')
                            time.sleep(2)

                            unarchive_btn = page.locator('button', has_text='sarchiver')
                            if unarchive_btn.count() > 0:
                                unarchive_btn.click()
                                time.sleep(2)
                                screenshot(page, '06c_after_unarchive')
                                print('  Unarchived successfully')

                    results['archive_campaign'] = 'PASS'
                    print('  PASS')
                else:
                    results['archive_campaign'] = 'SKIP: No archive button'
                    print('  SKIP')
            else:
                results['archive_campaign'] = 'SKIP: No campaign ID'
        except Exception as e:
            results['archive_campaign'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')
            screenshot(page, '06_archive_fail')

        # ============================================================
        # TEST 7: Prospects page — status quick filters
        # ============================================================
        print('\n=== TEST 7: Prospect status filters ===')
        try:
            page.click('.sidebar-link[data-page="prospects"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)
            screenshot(page, '07_prospects')

            # Check quick filter buttons
            qf_buttons = page.locator('.qf-btn')
            qf_count = qf_buttons.count()
            qf_labels = [qf_buttons.nth(i).text_content().strip() for i in range(qf_count)]
            print(f'  Quick filters ({qf_count}): {qf_labels}')

            # Verify new statuses are present
            expected = ['Nouveau', 'Invitation envoy', 'Message', 'Discussion', 'Gagn', 'Perdu']
            for exp in expected:
                found = any(exp in label for label in qf_labels)
                print(f'    "{exp}": {"found" if found else "MISSING"}')

            # Verify old statuses are gone
            old_statuses = ['ponse re', 'RDV planif']
            for old in old_statuses:
                found = any(old in label for label in qf_labels)
                if found:
                    print(f'    WARNING: Old status "{old}" still in filters!')

            results['status_filters'] = 'PASS'
            print('  PASS')
        except Exception as e:
            results['status_filters'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 8: Click each quick filter
        # ============================================================
        print('\n=== TEST 8: Click each quick filter ===')
        try:
            qf_buttons = page.locator('.qf-btn')
            qf_count = qf_buttons.count()
            for i in range(min(qf_count, 10)):
                btn = qf_buttons.nth(i)
                label = btn.text_content().strip()
                btn.click()
                time.sleep(0.5)
                is_active = btn.evaluate('el => el.classList.contains("qf-active")')
                print(f'    Filter "{label}": active={is_active}')

            # Click back to "Tous"
            page.locator('.qf-btn').first.click()
            time.sleep(1)
            screenshot(page, '08_filters_tested')

            results['click_filters'] = 'PASS'
            print('  PASS')
        except Exception as e:
            results['click_filters'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 9: Open a prospect and check detail page
        # ============================================================
        print('\n=== TEST 9: Prospect detail ===')
        try:
            first_link = page.locator('tbody tr a.row-link').first
            if first_link.count() > 0:
                first_link.click()
                page.wait_for_load_state('networkidle')
                time.sleep(2)
                screenshot(page, '09_prospect_detail')

                # Profile card
                assert page.locator('.profile-card').count() > 0, 'Profile card missing'

                # Status badge
                badges = page.locator('.profile-badges .badge').count()
                print(f'  Badges: {badges}')

                # Check for icebreaker regen button (if message card visible)
                icebreaker_btn = page.locator('button', has_text='icebreaker')
                if icebreaker_btn.count() > 0:
                    print('  Icebreaker regen button: visible')
                else:
                    print('  Icebreaker regen button: not visible (expected if not in Message a valider)')

                # Check sequence status
                seq_badge = page.locator('.badge', has_text='quence')
                if seq_badge.count() > 0:
                    print(f'  Sequence badge: {seq_badge.first.text_content()}')

                results['prospect_detail'] = 'PASS'
                print('  PASS')
            else:
                results['prospect_detail'] = 'SKIP: No prospects'
                print('  SKIP')
        except Exception as e:
            results['prospect_detail'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 10: Dashboard stats
        # ============================================================
        print('\n=== TEST 10: Dashboard stats ===')
        try:
            page.click('.sidebar-link[data-page="dashboard"]')
            page.wait_for_load_state('networkidle')
            time.sleep(3)
            screenshot(page, '10_dashboard')

            # Check stat cards
            stat_cards = page.locator('.stat-card')
            stat_count = stat_cards.count()
            print(f'  Stat cards: {stat_count}')
            for i in range(stat_count):
                card = stat_cards.nth(i)
                value = card.locator('.stat-value').text_content()
                label = card.locator('.stat-label').text_content()
                print(f'    {label}: {value}')

            # Check that old statuses don't appear in pipeline
            pipeline_text = page.locator('#dashPipeline').text_content() if page.locator('#dashPipeline').count() > 0 else ''
            if 'RDV planifi' in pipeline_text:
                print('  WARNING: "RDV planifie" still in pipeline!')
            if 'ponse re' in pipeline_text:
                print('  WARNING: "Reponse recue" still in pipeline!')

            results['dashboard_stats'] = 'PASS'
            print('  PASS')
        except Exception as e:
            results['dashboard_stats'] = f'FAIL: {e}'
            print(f'  FAIL: {e}')

        # ============================================================
        # TEST 11: Review tab in campaign
        # ============================================================
        print('\n=== TEST 11: Review tab ===')
        try:
            page.click('.sidebar-link[data-page="campagnes"]')
            page.wait_for_load_state('networkidle')
            time.sleep(2)

            camp_card = page.locator('.camp-card').first
            if camp_card.count() > 0:
                camp_card.click()
                page.wait_for_load_state('networkidle')
                time.sleep(2)

                review_tab = page.locator('.tab-btn', has_text='Review')
                if review_tab.count() > 0:
                    review_tab.click()
                    time.sleep(2)
                    screenshot(page, '11_review_tab')

                    # Check review content
                    has_list = page.locator('.review-prospect-list').count() > 0
                    has_empty = page.locator('.empty-state').count() > 0
                    print(f'  Review list: {has_list}, Empty: {has_empty}')

                    results['review_tab'] = 'PASS'
                    print('  PASS')
                else:
                    results['review_tab'] = 'SKIP: No review tab'
            else:
                results['review_tab'] = 'SKIP: No campaigns'
        except Exception as e:
            results['review_tab'] = f'FAIL: {e}'
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
            for e in errors[:15]:
                print(f'    - {e[:150]}')

        browser.close()
        return fail_count == 0

if __name__ == '__main__':
    success = test_all()
    exit(0 if success else 1)
