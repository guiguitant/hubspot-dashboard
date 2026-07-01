-- Migration 31 : configuration de l'estimateur de primes commerciales.
-- Alimente la section "Estimateur de primes" de l'onglet KPI (dashboard Pilot).
-- Une seule ligne (id = 'default') porte tout le paramétrage en JSONB :
--   { rates: { [partner]: { txNew, txRepeat } },
--     tiers: [{ seuil, taux } x3],
--     resultatAnnuel, gateTrimestriel }
-- Les réalisés (new/repeat) ne sont PAS stockés ici : ils viennent du KPI réel.
-- Pattern RLS identique à 30_kpi_tables.sql (mono-tenant, accès ouvert ;
-- l'accès est déjà gaté en amont par l'auth dashboard TOTP côté serveur).

CREATE TABLE kpi_prime_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE kpi_prime_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on kpi_prime_config" ON kpi_prime_config FOR ALL USING (true) WITH CHECK (true);
