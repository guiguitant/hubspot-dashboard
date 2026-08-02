'use strict';

// États : voir spec 2026-06-26-kpi-partners-design.md §2.
const SIGNE_EXCLUDED_STATES = ['Annulé'];          // signé = tout sauf ça
const OPERE_STATES = ['En cours', 'Terminé'];      // opéré = ces états
const TYPES = ['newsale', 'upsale', 'opere'];

// Année (number) depuis un ISO timestamp ('2026-03-01T...' → 2026), sinon null.
function yearOf(iso) {
  return iso ? Number(String(iso).slice(0, 4)) : null;
}

// Année (number) d'une date de facture ('2025-12-15' ou ISO) ou d'une string d'année ('2026'), sinon null.
function yearOfDate(d) {
  return d ? Number(String(d).slice(0, 4)) : null;
}

// CA signé d'une mission rattaché à `year` (source : Notion).
// Une mission = acompte + solde, chacun rattaché à l'année d'émission de SA facture :
//   - acompte = montantAcompte, daté par dateFactureAcompte ; si non émise → année du champ "Année final".
//   - solde   = ca - montantAcompte, daté par dateFactureFinale ; si non émise → année du champ "Année final".
// Une mission facturée à cheval contribue donc à deux années. Sans date ni "Année final" → 0 (non rattachable).
function signedAmountForYear(m, year) {
  const ca = Number(m.ca) || 0;
  const acompte = Number(m.montantAcompte) || 0;
  const solde = Math.max(0, ca - acompte);
  const anneeFinal = m.anneeFinal ? Number(m.anneeFinal) : null;
  const acompteYear = m.dateFactureAcompte ? yearOfDate(m.dateFactureAcompte) : anneeFinal;
  const soldeYear   = m.dateFactureFinale ? yearOfDate(m.dateFactureFinale) : anneeFinal;
  let total = 0;
  if (acompteYear === year) total += acompte;
  if (soldeYear === year)   total += solde;
  return total;
}

// Total « CA <année> HT » (source Notion) : somme, sur toutes les missions non « Annulé »,
// du CA rattaché à `year` (facturé ou non, via signedAmountForYear). C'est LE chiffre partagé
// par le Cockpit, l'onglet Analytics et le KPI, pour qu'ils affichent tous la même valeur.
// Inclut les missions sans type_ca (elles font partie du CA de l'année même si non classées).
function totalCaAnnee(missions, year) {
  let total = 0;
  for (const m of missions || []) {
    if (SIGNE_EXCLUDED_STATES.includes(m.etat)) continue;
    total += signedAmountForYear(m, year);
  }
  return Math.round(total);
}

// Trimestre (1-4) d'une date ISO / 'YYYY-MM-DD', sinon null. Slicing (pas de parsing Date) pour
// rester insensible au fuseau horaire.
function quarterOfDate(d) {
  if (!d) return null;
  const mois = Number(String(d).slice(5, 7));
  if (!mois || mois < 1 || mois > 12) return null;
  return Math.ceil(mois / 3);
}

// Date de signature d'une mission : le champ "Date de signature" s'il est renseigné, sinon la date
// de création de la ligne Notion (proxy, en attendant le backfill des vraies dates).
function signatureDate(m) {
  return m.dateSignature || m.dateCreation || null;
}

// CA signé (source Notion) ventilé par trimestre pour `year`, DATÉ À LA SIGNATURE.
// Base des primes commerciales trimestrielles (étage 1). Différent de signedAmountForYear (qui date à
// la facture) : une mission est signée en un seul événement, donc son CA ENTIER tombe dans le trimestre
// de signature (pas de découpage acompte/solde).
//   - byPartner[p] = { new:[q1..q4], repeat:[q1..q4] } : CA classé (Newsale/Upsale) réparti par %.
//   - quarterTotals[q] : CA signé TOTAL du trimestre (toutes missions non « Annulé », classées ou non),
//     base du seuil de rentabilité collectif (le portillon trimestriel).
function signedByQuarter(missions, year, splits) {
  const splitIndex = {};
  for (const s of splits || []) {
    if (!s || s.axis !== 'commercial') continue;
    (splitIndex[s.mission_id] = splitIndex[s.mission_id] || {})[s.partner] = Number(s.pct) || 0;
  }
  const byPartner = {};
  const detailByPartner = {};                 // [p][q] = [{ id, nom, client, montant, pct, type }] : traçabilité prime -> deals
  const quarterTotals = [0, 0, 0, 0];
  const unattributed = [];                     // { id, nom, client, ca, quarter, reason } : signé mais non rattaché à un partner
  const ensure = (p) => {
    if (!byPartner[p]) { byPartner[p] = { new: [0, 0, 0, 0], repeat: [0, 0, 0, 0] }; detailByPartner[p] = [[], [], [], []]; }
    return byPartner[p];
  };

  for (const m of missions || []) {
    if (SIGNE_EXCLUDED_STATES.includes(m.etat)) continue;
    const ca = Number(m.ca) || 0;
    if (ca <= 0) continue;
    const sig = signatureDate(m);
    if (yearOfDate(sig) !== year) continue;
    const q = quarterOfDate(sig);
    if (!q) continue;
    quarterTotals[q - 1] += ca;

    let type = null;
    if (m.typeCa === 'Newsale') type = 'new';
    else if (m.typeCa === 'Upsale') type = 'repeat';
    const partners = m.partnerCommercial || [];
    // Non attribué : sans partner, ou sans type (Newsale/Upsale). Compté dans quarterTotals mais chez aucun partner.
    // C'est LA fuite d'attribution : le contrôle de couverture (front) s'appuie là-dessus.
    if (!partners.length || !type) {
      unattributed.push({ id: m.id, nom: m.nom, client: m.client, ca: Math.round(ca), quarter: q, reason: !partners.length ? 'sans partner' : 'sans type' });
      continue;
    }
    const shares = splitAmount(ca, partners, splitIndex[m.id]);
    for (const [p, amt] of Object.entries(shares)) {
      ensure(p)[type][q - 1] += amt;
      detailByPartner[p][q - 1].push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(amt), pct: ca > 0 ? Math.round(amt / ca * 100) : 0, type });
    }
  }

  for (const p of Object.keys(byPartner)) {
    byPartner[p].new = byPartner[p].new.map((v) => Math.round(v));
    byPartner[p].repeat = byPartner[p].repeat.map((v) => Math.round(v));
  }
  return {
    partners: Object.keys(byPartner).sort(),
    byPartner,
    detailByPartner,
    quarterTotals: quarterTotals.map((v) => Math.round(v)),
    total: Math.round(quarterTotals.reduce((s, v) => s + v, 0)),
    unattributed: {
      total: Math.round(unattributed.reduce((s, x) => s + x.ca, 0)),
      missions: unattributed,
    },
  };
}

// Candidats au clawback (reprise) : missions « Annulé » signées sur un trimestre DÉJÀ PAYÉ
// (quarter <= paidThroughQuarter), qui ont donc potentiellement généré une prime déjà versée.
// Retourne le détail par partner (montant = part après split) ; le taux/la prime sont appliqués côté
// front (qui a la config). Montant indicatif : on ignore si l'annulation est antérieure ou postérieure
// au paiement (pas de date d'annulation fiable), d'où la vérification manuelle.
function clawbackCandidates(missions, year, splits, paidThroughQuarter) {
  const splitIndex = {};
  for (const s of splits || []) {
    if (!s || s.axis !== 'commercial') continue;
    (splitIndex[s.mission_id] = splitIndex[s.mission_id] || {})[s.partner] = Number(s.pct) || 0;
  }
  const out = [];
  for (const m of missions || []) {
    if (m.etat !== 'Annulé') continue;
    const ca = Number(m.ca) || 0;
    if (ca <= 0) continue;
    if (yearOfDate(signatureDate(m)) !== year) continue;
    const q = quarterOfDate(signatureDate(m));
    if (!q || q > (paidThroughQuarter || 0)) continue; // pas encore payé -> pas un clawback
    let type = null;
    if (m.typeCa === 'Newsale') type = 'new';
    else if (m.typeCa === 'Upsale') type = 'repeat';
    const partners = m.partnerCommercial || [];
    if (!type || !partners.length) continue; // n'aurait pas généré de prime perso
    const shares = splitAmount(ca, partners, splitIndex[m.id]);
    for (const [p, amt] of Object.entries(shares)) {
      out.push({ id: m.id, nom: m.nom, client: m.client, quarter: q, partner: p, montant: Math.round(amt), type });
    }
  }
  return out;
}

// Répartit `ca` entre les partners selon `overrides` ({partner: pct}) si non vide, sinon à parts
// égales. Retourne { partner: montant }.
// Ensemble effectif = partners Notion de l'axe ∪ partners présents dans l'override. Ainsi un partner
// ajouté via un split enregistré (ex. l'opérationnel qui touche sa part de rétention sur un upsale)
// est bien crédité, même s'il n'est pas dans la liste Notion de l'axe. Sans override, seul le socle
// Notion compte (parts égales).
function splitAmount(ca, partners, overrides) {
  const out = {};
  const base = Array.isArray(partners) ? partners : [];
  const hasOverride = overrides && Object.keys(overrides).length > 0;
  const all = hasOverride ? Array.from(new Set([...base, ...Object.keys(overrides)])) : base;
  if (all.length === 0) return out;
  if (hasOverride) {
    const totalPct = all.reduce((s, p) => s + (Number(overrides[p]) || 0), 0);
    for (const p of all) {
      const pct = Number(overrides[p]) || 0;
      out[p] = totalPct > 0 ? ca * (pct / totalPct) : ca / all.length;
    }
  } else {
    const share = ca / all.length;
    for (const p of all) out[p] = share;
  }
  return out;
}

// Map d'affichage des pourcentages pour le panneau réglages (défaut égal ou override).
function displaySplit(partners, overrides) {
  const out = {};
  if (!partners || partners.length === 0) return out;
  const hasOverride = overrides && Object.keys(overrides).length > 0;
  if (hasOverride) {
    for (const p of partners) out[p] = Number(overrides[p]) || 0;
  } else {
    const eq = Math.round((100 / partners.length) * 100) / 100;
    for (const p of partners) out[p] = eq;
  }
  return out;
}

function computeKpi({ missions, objectives, splits, year }) {
  // Index des overrides : splitIndex[mission_id][axis] = { partner: pct }
  const splitIndex = {};
  for (const s of splits || []) {
    splitIndex[s.mission_id] = splitIndex[s.mission_id] || {};
    splitIndex[s.mission_id][s.axis] = splitIndex[s.mission_id][s.axis] || {};
    splitIndex[s.mission_id][s.axis][s.partner] = Number(s.pct) || 0;
  }

  // Accumulateur des montants réalisés par partner/type.
  const acc = {};
  const add = (partner, type, amount) => {
    acc[partner] = acc[partner] || { newsale: 0, upsale: 0, opere: 0 };
    acc[partner][type] += amount;
  };
  // Détail des missions contribuant à chaque (partner, type) — pour le pop-up au clic sur une barre.
  const detailAcc = {}; // detailAcc[partner][type] = [{ id, nom, client, montant }]
  const allDetail = { newsale: [], upsale: [], opere: [] }; // détail "All" (CA plein par mission)
  const addDetail = (partner, type, m, montant) => {
    detailAcc[partner] = detailAcc[partner] || { newsale: [], upsale: [], opere: [] };
    detailAcc[partner][type].push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(montant) });
  };

  const unclassified = [];
  const missionsForSplit = [];

  for (const m of missions || []) {
    const ca = Number(m.ca) || 0;
    // CA signé (source Notion) daté À LA SIGNATURE, comme signedByQuarter et la prime individuelle :
    // le CA ENTIER de la mission tombe sur son année de signature (pas de découpage acompte/solde, qui
    // relève de la facturation). 0 si l'état est "Annulé" (exclu du signé). Le total FACTURÉ de l'année
    // reste, lui, calculé à la date de facture via caAnnee/signedAmountForYear (base de la prime collective).
    const caSigne = (SIGNE_EXCLUDED_STATES.includes(m.etat) || yearOfDate(signatureDate(m)) !== year) ? 0 : ca;
    // Opéré : critère d'année inchangé (date de création de la ligne Notion) + CA total de la mission.
    const isOpereYear = yearOf(m.dateCreation) === year && OPERE_STATES.includes(m.etat);

    // --- Signé (commercial) ---
    if (caSigne > 0) {
      let type = null;
      if (m.typeCa === 'Newsale') type = 'newsale';
      else if (m.typeCa === 'Upsale') type = 'upsale';

      if (type) {
        const shares = splitAmount(caSigne, m.partnerCommercial, (splitIndex[m.id] || {}).commercial);
        for (const [p, amt] of Object.entries(shares)) { add(p, type, amt); addDetail(p, type, m, amt); }
        allDetail[type].push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(caSigne) });
      } else {
        unclassified.push({ id: m.id, nom: m.nom, client: m.client, ca: Math.round(caSigne) });
      }
    }

    // --- Opéré (opérationnel) : En cours / Terminé, daté par la création ---
    if (isOpereYear) {
      const shares = splitAmount(ca, m.partnerOperationnel, (splitIndex[m.id] || {}).operationnel);
      for (const [p, amt] of Object.entries(shares)) { add(p, 'opere', amt); addDetail(p, 'opere', m, amt); }
      allDetail.opere.push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(ca) });
    }

    // --- missionsForSplit : missions à 2+ partners contribuant à l'année (signé ou opéré) ---
    if (caSigne > 0 || isOpereYear) {
      const com = m.partnerCommercial || [];
      const ope = m.partnerOperationnel || [];
      if (com.length >= 2 || ope.length >= 2) {
        missionsForSplit.push({
          id: m.id, nom: m.nom, client: m.client || null, ca,
          // type de deal (grille d'allocation à appliquer côté front) : 'newsale' | 'upsale' | null.
          type: m.typeCa === 'Newsale' ? 'newsale' : (m.typeCa === 'Upsale' ? 'upsale' : null),
          // true si une répartition commerciale a déjà été enregistrée pour cette mission (au moins
          // une ligne kpi_ca_split axis=commercial). Sert au badge « Enregistré » persistant du calculateur.
          commercialSaved: !!((splitIndex[m.id] || {}).commercial && Object.keys((splitIndex[m.id] || {}).commercial).length),
          commercial: com, operationnel: ope,
          splitCommercial: displaySplit(com, (splitIndex[m.id] || {}).commercial),
          splitOperationnel: displaySplit(ope, (splitIndex[m.id] || {}).operationnel),
        });
      }
    }
  }

  // Objectifs indexés par partner/type (année filtrée).
  const objIndex = {};
  for (const o of objectives || []) {
    if (o.year !== year) continue;
    objIndex[o.partner] = objIndex[o.partner] || {};
    objIndex[o.partner][o.type] = Number(o.montant) || 0;
  }

  // Liste des partners = union (réalisé) ∪ (objectifs).
  const names = new Set([...Object.keys(acc), ...Object.keys(objIndex)]);
  const partners = [];
  const allReal = { newsale: 0, upsale: 0, opere: 0 };
  const allObj = { newsale: 0, upsale: 0, opere: 0 };

  for (const name of [...names].sort()) {
    const real = acc[name] || { newsale: 0, upsale: 0, opere: 0 };
    const obj = objIndex[name] || {};
    const details = detailAcc[name] || { newsale: [], upsale: [], opere: [] };
    for (const type of TYPES) details[type].sort((a, b) => b.montant - a.montant);
    const row = { partner: name, details };
    for (const type of TYPES) {
      const realise = Math.round(real[type] || 0);
      const objectif = Math.round(obj[type] || 0);
      row[type] = { objectif, realise, tx: objectif > 0 ? realise / objectif : null };
      allReal[type] += realise;
      allObj[type] += objectif;
    }
    partners.push(row);
  }

  const all = {};
  for (const type of TYPES) {
    all[type] = {
      objectif: allObj[type], realise: allReal[type],
      tx: allObj[type] > 0 ? allReal[type] / allObj[type] : null,
    };
  }

  for (const type of TYPES) allDetail[type].sort((a, b) => b.montant - a.montant);

  return { year, partners, all, unclassified, missionsForSplit, allDetails: allDetail, caAnnee: totalCaAnnee(missions, year) };
}

// Taux par defaut Releaf : l'objectif de Guillaume est le double, donc son taux est la moitie.
function primeDefaultRates(name) {
  if (/guillaume/i.test(name || '')) return { txNew: 2.25, txRepeat: 1.25 };
  return { txNew: 4.5, txRepeat: 2.5 };
}

// Applique les memes defauts que le panneau KPI (front ensurePrimeConfig), pour que le compte de
// resultat affiche exactement le meme pool que l'onglet KPI meme si la config sauvegardee est partielle.
function normalizePrimeConfig(config) {
  const c = (config && typeof config === 'object') ? config : {};
  const tiers = (Array.isArray(c.tiers) && c.tiers.length)
    ? c.tiers
    : [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }];
  return {
    rates: (c.rates && typeof c.rates === 'object') ? c.rates : {},
    tiers,
    resultatAnnuel: typeof c.resultatAnnuel === 'number' ? c.resultatAnnuel : 150000,
    gateTrimestriel: typeof c.gateTrimestriel === 'number' ? c.gateTrimestriel : 120000,
    versementEtage2Mois: c.versementEtage2Mois != null ? String(c.versementEtage2Mois).padStart(2, '0') : '03',
  };
}

// Pool de primes de l'annee = etage 1 (perso trimestriel, avec portillon) + etage 2 (collectif annuel).
// Reproduit primeCompute() du front. Le pool est independant de la liste des participants : on itere
// sur les partners porteurs de CA signe (cles de byPartner) ; un partner sans signe ajoute 0.
function computePrimePool({ missions, splits, config, year, caFacture }) {
  const cfg = normalizePrimeConfig(config);
  const sq = signedByQuarter(missions || [], year, splits || []);
  const gateOk = sq.quarterTotals.map((t) => t >= cfg.gateTrimestriel);

  let etage1 = 0;
  for (const name of Object.keys(sq.byPartner || {})) {
    const r = cfg.rates[name] || primeDefaultRates(name);
    const bp = sq.byPartner[name];
    for (let i = 0; i < 4; i++) {
      if (!gateOk[i]) continue;
      etage1 += (bp.new[i] || 0) * (r.txNew / 100) + (bp.repeat[i] || 0) * (r.txRepeat / 100);
    }
  }

  const caF = Math.max(0, Number(caFacture) || 0);
  const tiersAsc = cfg.tiers.slice().sort((a, b) => a.seuil - b.seuil);
  let tauxColl = 0;
  for (const t of tiersAsc) { if (caF >= t.seuil) tauxColl = t.taux; }
  const etage2 = (tauxColl / 100) * cfg.resultatAnnuel;

  return {
    etage1: Math.round(etage1),
    etage2: Math.round(etage2),
    pool: Math.round(etage1 + etage2),
    tauxColl,
  };
}

// Cle 'YYYY-MM' du mois qui suit la cloture du trimestre q (1-4) de l'annee y.
// Cloture T1=mars, T2=juin, T3=sept, T4=dec ; "mois suivant" = avril, juillet, octobre, janvier(N+1).
function monthAfterQuarterClose(y, q) {
  let m = q * 3 + 1, yy = y;
  if (m > 12) { m = 1; yy = y + 1; }
  return yy + '-' + String(m).padStart(2, '0');
}

// Cle 'YYYY-MM' du dernier mois du trimestre q (1-4) de l'annee y = mois de cloture.
// T1=mars(03), T2=juin(06), T3=sept(09), T4=dec(12). C'est la date de CHARGE (rattachement),
// pendant de monthAfterQuarterClose qui donne le mois de DECAISSEMENT.
function lastMonthOfQuarter(y, q) {
  return y + '-' + String(q * 3).padStart(2, '0');
}

// Cle 'YYYY-MM' du mois qui suit une date 'YYYY-MM-DD' (ou ISO). Null si date absente/invalide.
function monthAfterDate(d) {
  if (!d) return null;
  const y = Number(String(d).slice(0, 4)), m = Number(String(d).slice(5, 7));
  if (!y || !m) return null;
  let mm = m + 1, yy = y;
  if (mm > 12) { mm = 1; yy = y + 1; }
  return yy + '-' + String(mm).padStart(2, '0');
}

// Echeancier des versements de primes de l'annee `year` : map { 'YYYY-MM': montant } + detail.
// Etage 1 deal par deal (conditionne a la facturation de l'acompte, avec portillon trimestriel),
// etage 2 en N+1. `versements` = validations Phase 3 (couples deja verses, exclus). `now` = date
// courante ('YYYY-MM-DD' ou ISO) pour le rattrapage. Les cles zero-paddees se comparent lexicalement.
function computePrimePayments({ missions, splits, config, year, caFacture, versements = [], now, versementEtage2Mois, pastPolicy = 'rattrapage', participants = null }) {
  const cfg = normalizePrimeConfig(config);
  const sq = signedByQuarter(missions || [], year, splits || []);
  const gateOk = sq.quarterTotals.map((t) => t >= cfg.gateTrimestriel);
  const nowKey = String(now || '').slice(0, 7);
  // Dernier mois du trimestre courant ouvert (plancher de charge dynamique, R3/R4).
  const nowQuarter = quarterOfDate(now) || quarterOfDate((now || '') + '-01') || 1;
  const nowYear = yearOfDate(now) || year;
  const floorChargeKey = lastMonthOfQuarter(nowYear, nowQuarter);

  // Index des validations (Phase 3) : etage 1 -> 'E1|mission|partner' ; etage 2 -> 'E2|partner'.
  const verseKeys = new Set();
  for (const v of versements || []) {
    if (Number(v.etage) === 2) verseKeys.add('E2|' + v.partner);
    else verseKeys.add('E1|' + v.mission_id + '|' + v.partner);
  }

  // Date de facturation de l'acompte par mission.
  const acompteByMission = {};
  for (const m of (missions || [])) acompteByMission[m.id] = m.dateFactureAcompte || null;

  const byMonth = {};
  const byPartnerMonth = {};
  const detail = {};
  let enAttente = 0, verse = 0;
  const enAttenteByPartner = {};
  const add = (mk, amount, info) => {
    byMonth[mk] = (byMonth[mk] || 0) + amount;
    (detail[mk] = detail[mk] || []).push(info);
  };
  // Accumulateur par associe et par mois (pour l'ecriture GSheet). Ne casse pas byMonth (agrege).
  const addPM = (partner, mk, amount) => {
    if (!partner) return;
    (byPartnerMonth[partner] = byPartnerMonth[partner] || {})[mk] = (byPartnerMonth[partner][mk] || 0) + amount;
  };

  const byMonthCharge = {};
  const byPartnerMonthCharge = {};
  const detailCharge = [];
  const addCharge = (partner, mk, amount) => {
    if (!partner || !mk) return;
    byMonthCharge[mk] = (byMonthCharge[mk] || 0) + amount;
    (byPartnerMonthCharge[partner] = byPartnerMonthCharge[partner] || {})[mk] =
      (byPartnerMonthCharge[partner][mk] || 0) + amount;
  };

  // --- Etage 1 : prime trimestrielle calculee comme l'onglet KPI (sur le CA agrege bp),
  // repartie sur les deals au prorata de leur montant (pour garder l'echeance + le garde-fou
  // par deal). On n'arrondit PAS ici : l'arrondi final, en preservant le total par associe,
  // se fait a l'ecriture. Ainsi le Sheet colle a l'euro pres a ce que Pilot affiche.
  for (const p of Object.keys(sq.detailByPartner || {})) {
    const rate = cfg.rates[p] || primeDefaultRates(p);
    const bp = (sq.byPartner && sq.byPartner[p]) || { new: [0, 0, 0, 0], repeat: [0, 0, 0, 0] };
    for (let q = 0; q < 4; q++) {
      if (!gateOk[q]) continue;
      const deals = sq.detailByPartner[p][q] || [];
      if (!deals.length) continue;
      const primeTrim = (bp.new[q] * rate.txNew + bp.repeat[q] * rate.txRepeat) / 100;
      if (primeTrim <= 0) continue;
      const totalPart = deals.reduce((s, d) => s + (d.montant || 0), 0) || 1;
      for (const deal of deals) {
        const montant = primeTrim * ((deal.montant || 0) / totalPart); // part du deal (float)
        if (montant <= 0) continue;
        if (verseKeys.has('E1|' + deal.id + '|' + p)) { verse += montant; continue; }
        const acompte = acompteByMission[deal.id];
        if (!acompte) { enAttente += montant; enAttenteByPartner[p] = (enAttenteByPartner[p] || 0) + montant; continue; }
        // Regle unifiee : versement a M+1 de la cloture du trimestre OU l'acompte est facture.
        // Le trimestre de signature (q) ne sert qu'au portillon (gateOk) et au montant.
        // Decaissement (inchange) : M+1 de la cloture du trimestre de facturation.
        const qFact = quarterOfDate(acompte);
        const yFact = yearOfDate(acompte);
        let mk = (qFact && yFact) ? monthAfterQuarterClose(yFact, qFact) : monthAfterQuarterClose(year, q + 1);
        const decaissementMk = mk; // memorise avant rattrapage decaissement
        const isPast = mk < nowKey;
        if (isPast) {
          if (pastPolicy === 'drop') { /* decaissement passe non repris (byMonth) */ }
          else mk = nowKey;
        }
        if (!(isPast && pastPolicy === 'drop')) {
          add(mk, montant, { etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, rattrapage: isPast });
          addPM(p, mk, montant);
        }

        // Charge (nouveau) : dernier mois du trimestre de facturation. Statut selon le decaissement.
        const chargeMkTheorique = (qFact && yFact) ? lastMonthOfQuarter(yFact, qFact) : lastMonthOfQuarter(year, q + 1);
        const statut = decaissementMk < nowKey ? 'du' : 'a_venir';
        let chargeMk = chargeMkTheorique;
        if (chargeMk < nowKey) {
          // Mois de charge deja clos (R4). Si le decaissement est clos aussi, la charge est
          // deja portee par le reel Qonto (Option B) : ne pas l'ecrire (dateCharge=null).
          // Sinon, reporter au dernier mois du trimestre courant ouvert, sans depasser le decaissement.
          if (decaissementMk < nowKey) chargeMk = null;
          else chargeMk = floorChargeKey <= decaissementMk ? floorChargeKey : decaissementMk;
        }
        addCharge(p, chargeMk, montant);
        detailCharge.push({ etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, dateCharge: chargeMk, dateDecaissement: decaissementMk, statut });
      }
    }
  }

  // --- Etage 2 : collectif, verse en N+1 ---
  const caF = Math.max(0, Number(caFacture) || 0);
  const tiersAsc = cfg.tiers.slice().sort((a, b) => a.seuil - b.seuil);
  let tauxColl = 0;
  for (const t of tiersAsc) { if (caF >= t.seuil) tauxColl = t.taux; }
  const collTotal = tauxColl * cfg.resultatAnnuel / 100; // float (ordre stable), arrondi a l'ecriture
  // Etage 2 verse en une ligne (total collectif). L'exclusion par partner valide arrive en Phase 3.
  if (collTotal > 0) {
    const moisE2 = String(versementEtage2Mois || cfg.versementEtage2Mois || '03').padStart(2, '0');
    let mk = (year + 1) + '-' + moisE2;
    const isPast = mk < nowKey;
    if (!(isPast && pastPolicy === 'drop')) {
      if (isPast) mk = nowKey;
      add(mk, collTotal, { etage: 2, montant: collTotal, rattrapage: isPast });
      // Collectif reparti a parts egales sur les participants (meme regle que le front : collTotal / N).
      const parts = (participants && participants.length) ? participants : Object.keys(sq.detailByPartner || {});
      if (parts.length) {
        const share = collTotal / parts.length; // float, arrondi a l'ecriture
        for (const p of parts) addPM(p, mk, share);
      }
    }
  }

  return { byMonth, byPartnerMonth, detail, enAttente, enAttenteByPartner, verse, byMonthCharge, byPartnerMonthCharge, detailCharge };
}

module.exports = { computeKpi, yearOf, yearOfDate, signedAmountForYear, totalCaAnnee, signedByQuarter, clawbackCandidates, quarterOfDate, signatureDate, splitAmount, displaySplit, OPERE_STATES, SIGNE_EXCLUDED_STATES, primeDefaultRates, normalizePrimeConfig, computePrimePool, computePrimePayments, lastMonthOfQuarter };
