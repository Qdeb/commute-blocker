# 🚲 Auto Commute Blocker — Google Calendar

Crée automatiquement des blocs "Travel" dans Google Calendar avant et après chaque réunion physique, avec le temps de trajet réel (vélo ou transports en commun) + un buffer configurable.

Les blocs apparaissent comme **occupé** → personne ne peut booker par-dessus ton temps de trajet.

---

## Comment ça marche

### Architecture

| Trigger | Fréquence | Portée | Rôle |
|---|---|---|---|
| `onCalChange_` | ~30sec après chaque modif | **Seulement les jours modifiés** | Détecte via sync token quels events ont changé. Traite uniquement ces journées. Fonctionne même pour un meeting dans 3 semaines. |
| `scanUpcoming_` | Toutes les 30min (configurable) | **7 prochains jours** | Filet de sécurité. Rattrape ce que le hook a manqué. |
| `morningSweep_` | 1x/jour à 7h | **Aujourd'hui** | Vérifie les conflits non résolus, envoie un email si problème. |

### Logique principale

Pour chaque réunion physique de la journée (triées par heure) :

1. **Résout l'origine** : d'où tu pars ?
   - 1ère réunion dans les 90min du début de journée → toujours depuis la maison
   - Réunion précédente < 90min avant → trajet direct A→B (chaînage)
   - Réunion précédente entre 90min et 2h avant → vérifie si un aller-retour maison/bureau tient dans le gap. Si oui → retour + départ depuis maison/bureau. Si non → trajet direct A→B
   - Aucune réunion dans les 2h → départ depuis maison ou bureau (selon Workspace)
2. **Si destination = maison** → pas de bloc trajet
3. **Mode de transport** : vélo si les 2 points sont dans Paris et trajet ≤ 45min, sinon transports en commun
4. **Appel Google Directions API** → durée réelle + buffer
5. **Résolution de conflits** : si le trajet chevauche une visio ou un "time block" → décalé avant automatiquement (récursif). Si il chevauche une réunion physique → email d'alerte

### Retour intra-journée

Après chaque réunion physique, si le prochain meeting physique est à plus de 90min :
- Calcule si un aller-retour (meeting → maison/bureau → prochain meeting) tient dans le gap
- Si oui → crée un bloc retour
- Si non → pas de retour, le prochain trajet sera direct A→B

### Retour fin de journée

- Après le dernier meeting physique → toujours un retour
- Après l'heure de coupure (configurable, défaut 17h) → toujours vers la maison (jamais le bureau)
- Si une nuit d'hôtel est détectée → retour vers l'hôtel à la place

### Bureau / Maison (Google Workspace)

- Si tu as un compte Workspace avec "working location" configuré → le script lit si c'est un jour bureau ou maison et utilise l'adresse correspondante
- Si tu es sur Gmail personnel → toujours la maison (fallback automatique)
- La 1ère réunion du matin part toujours de la maison (pas du bureau)

### Nuit d'hôtel

Si un événement dans ton calendrier commence le soir et se termine le lendemain matin avec une adresse physique → le script utilise cette adresse comme point d'ancrage pour le dernier retour de la soirée.

---

## Prérequis

- Un **compte Google** avec accès à [Google Apps Script](https://script.google.com/)
- Un **projet Google Cloud** avec facturation activée (le free tier suffit)
- Une **clé API Google Maps**

---

## Installation

### Étape 1 — Google Cloud Console

1. [console.cloud.google.com](https://console.cloud.google.com/) → crée ou sélectionne un projet
2. Active la **facturation**
3. **APIs & Services → Library** → active :
   - Google Calendar API
   - Directions API
   - Geocoding API
4. **APIs & Services → Credentials** → crée une **API Key**, restreins-la à Directions + Geocoding

### Étape 2 — Apps Script

1. [script.google.com](https://script.google.com/) → **New Project** → nomme-le `Commute Blocker`
2. Supprime le code par défaut, colle le contenu de `Code.gs`

### Étape 3 — Calendar Advanced Service

1. Sidebar → **Services** (icône puzzle) → **+** → **Google Calendar API** → **Add**

### Étape 4 — Lier au projet GCP

1. **Project Settings** (engrenage) → **Google Cloud Platform Project** → **Change project**
2. Entre le numéro de ton projet GCP

### Étape 5 — Personnaliser les Script Properties

**Project Settings → Script properties** — ajoute ces entrées avec tes propres valeurs :

| Propriété | Exemple | Description |
|---|---|---|
| `HOME_ADDRESS` | `12 Rue de Rivoli, 75001 Paris` | **Ton adresse maison** |
| `OFFICE_ADDRESS` | *(vide ou ton adresse bureau)* | Adresse bureau (optionnel, pour Workspace) |
| `BUFFER_MINUTES` | `10` | Buffer ajouté au trajet (minutes) |
| `WATCH_CALENDAR_ID` | `primary` | Calendrier à surveiller |
| `GOOGLE_MAPS_API_KEY` | `AIza...` | **Ta clé API Maps** (étape 1) |
| `POLL_INTERVAL_MINUTES` | `30` | Fréquence du poll de sécurité (minutes) |
| `DAY_START_HOUR` | `9` | Début de journée (format 24h) |
| `FIRST_MEETING_WINDOW` | `90` | 1er meeting dans ce délai → départ maison (min) |
| `CHAIN_WINDOW_MINUTES` | `120` | Fenêtre de chaînage depuis le meeting précédent (min) |
| `NEXT_MEETING_WINDOW` | `90` | Gap min avant de créer un retour intra-journée (min) |
| `CYCLING_MAX_MINUTES` | `45` | Durée max vélo avant transit |
| `EVENING_CUTOFF_HOUR` | `17` | Après cette heure → retour maison (pas bureau) |
| `ALERT_EMAIL` | `ton@email.com` | **Ton email** pour alertes de conflit |
| `LOG_LEVEL` | `INFO` | Verbosité (`DEBUG` pour troubleshoot) |
| `TRAVEL_COLOR_ID` | `8` | Couleur des blocs (8 = graphite) |

> **Aucune donnée personnelle n'est dans le code.** Toute la configuration est dans les Script Properties.

### Étape 6 — Autoriser

1. Sélectionne `authKickstart` → **Run** → approuve les permissions

### Étape 7 — Installer les triggers

1. Sélectionne `setup` → **Run**
2. Vérifie (icône horloge) :
   - `onCalChange_` → Calendar event updated
   - `scanUpcoming_` → toutes les 30 min
   - `morningSweep_` → tous les jours à 7h

> Note : au premier lancement, le sync token s'initialise. Les travel blocks se créeront à partir de la **deuxième** modification de calendrier.

---

## Tester

| Test | Action | Résultat attendu |
|---|---|---|
| Trajet simple | Crée un meeting avec une adresse, attends ~30sec | Bloc `Travel 🚲 Xmin` avant le meeting |
| Meeting lointain | Crée un meeting dans 2-3 semaines | Travel block créé en ~30sec via `onCalChange_` |
| Chaînage | 2 meetings dans des lieux différents, <2h d'écart | 1er trajet depuis maison, 2ème depuis le lieu du 1er |
| Retour intra-journée | 2 meetings avec >2h de gap | Bloc retour après le 1er meeting |
| Retour fin de journée | 1 seul meeting physique | Bloc retour après le meeting |
| Conflit visio | Visio juste avant un meeting physique lointain | Le trajet se décale avant la visio |
| Email d'alerte | `sweepNow` avec un conflit physique | Email reçu |
| Nuit d'hôtel | Event 22h→8h lendemain avec adresse | Dernier retour vers l'hôtel |

---

## Fonctions manuelles

| Fonction | Usage |
|---|---|
| `authKickstart()` | Approuver les permissions (1 fois) |
| `setup()` | Installer les triggers (1 fois) |
| `scanNow()` | Test manuel — scanne les 7 prochains jours |
| `sweepNow()` | Test manuel — simule le sweep du matin |

---

## Personnalisation

### Adapter le mode de transport

- **Bounding box** : modifie `PARIS_BOUNDS` dans le code pour ta ville
- **Seuil vélo** : ajuste `CYCLING_MAX_MINUTES` (défaut 45min)
- **Transit uniquement** : mets `CYCLING_MAX_MINUTES` à `0`
- **Vélo uniquement** : mets `CYCLING_MAX_MINUTES` à `999`

### Couleurs Google Calendar

| ID | Couleur |
|---|---|
| 1 | Lavande |
| 2 | Sauge |
| 3 | Raisin |
| 4 | Flamant |
| 5 | Banane |
| 6 | Mandarine |
| 7 | Paon |
| 8 | Graphite |
| 9 | Myrtille |
| 10 | Basilic |
| 11 | Tomate |

---

## Convention de nommage

`Travel 🚲 25min` ou `Travel 🚇 35min`

La description contient : origine → destination, mode, lien Google Maps cliquable. Les blocs sont en couleur graphite et marqués **occupé**.

---

## Coût

| Service | Free tier | Usage estimé (~5 meetings/jour) |
|---|---|---|
| Directions API | 1 000/mois | ~220/mois |
| Geocoding API | 1 000/mois | ~100/mois |
| Calendar API | 20 000/jour | Quelques centaines |
| Apps Script | 90 min/jour | ~30-60 min |

**Total : 0€/mois**

---

## Troubleshooting

| Problème | Solution |
|---|---|
| `onEventUpdated` échoue au setup | Relance `setup()` 2-3 fois. Intermittent côté Google. Le polling 30min prend le relai. |
| Duplicatas de travel blocks | Corrigé avec `LockService` + `privateExtendedProperty` filter. Lance `scanNow()` pour nettoyer. |
| Pas de bloc créé | Vérifie : adresse physique dans le champ location, meeting accepté, destination ≠ maison. Passe en `DEBUG`. |
| Pas de bloc au 1er lancement | Normal : le sync token s'initialise. Les blocs se créent à partir de la 2ème modif. Lance `scanNow()` pour forcer. |
| Mauvais mode transport | Vélo uniquement si les 2 points sont dans la bounding box ET ≤ 45min. |
| Working location ignoré | Nécessite Google Workspace. Sur Gmail personnel → toujours maison. |
| Synchro plus lente sur mobile | Normal : Google Calendar sur mobile synchronise moins fréquemment que sur desktop. |

---

## Stack

Google Apps Script · Calendar API (Advanced) · Directions API · Geocoding API · CacheService · LockService

Basé sur [Auto Drive-Time Blocker](https://github.com/mathewvarghesemanu/drive_to_time_script_for_google_calendar) par Mathew Varghese (MIT License).
