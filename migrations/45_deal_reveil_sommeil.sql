-- Migration 45: arbitrage d'un deal en sommeil
--
-- Le bac "À relancer" mélange deux populations. Les GELÉS, qui y sont allés
-- volontairement avec une date de retour (migration 43). Et les EN SOMMEIL,
-- qui n'ont rien demandé : ils sont restés dans leur stage HubSpot, mais plus
-- de 90 jours sans relance ni note les en ont exilés à l'affichage.
--
-- Sortir un gelé du bac est trivial : on efface wake_up_at et il redevient un
-- deal normal. Sortir un deal en sommeil ne l'était pas du tout : rien ne
-- remettait le compteur de jours sans contact à zéro, donc la carte revenait
-- au bac au premier re-render. Le geste avait l'air mort, alors que le stage
-- avait parfois bougé pour de vrai dans HubSpot. Pire, remettre la carte dans
-- son propre stage ne déclenchait strictement rien.
--
--   reveille_at : quand on a statué sur ce deal endormi. Ce n'est PAS un
--                 contact client et ça ne prétend pas l'être : c'est une
--                 décision ("celui-là n'est pas mort, il repart dans le pipe").
--                 Le calcul de santé la traite comme une date de dernier
--                 traitement, donc le compteur des 90 jours repart de là.
--
-- Pourquoi une colonne plutôt qu'une note automatique : une note écrite par le
-- système dans le journal des échanges laisse croire à un contact qui n'a pas
-- eu lieu, et se déclenche aussi quand on se trompe de colonne. Le marqueur
-- dit ce qu'il est.

ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS reveille_at TIMESTAMPTZ;
